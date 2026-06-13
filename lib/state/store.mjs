import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

const SCHEMA_VERSION = 1

// Ordered migrations keyed by the version they upgrade TO. migrations[n] runs
// when stored version is n-1, advancing schema_meta.version to n. v1 is the
// baseline (tables created below), so its migration set is empty. To add a
// schema change later: bump SCHEMA_VERSION and add migrations[<new>] = (db) => { db.exec('ALTER ...') }.
const MIGRATIONS = {}

const BASE_TABLES = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, repo TEXT NOT NULL, base_sha TEXT NOT NULL,
    integration_branch TEXT, status TEXT NOT NULL, plan_json TEXT NOT NULL,
    policy_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    target_sha TEXT, report_json TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL, status TEXT NOT NULL, wave INTEGER NOT NULL,
    worker TEXT, model_tier TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, result_json TEXT, PRIMARY KEY(run_id, task_id)
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
    number INTEGER NOT NULL, worker TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
    pid INTEGER, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER,
    duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    cost_usd REAL, error_kind TEXT, log_path TEXT, result_json TEXT,
    UNIQUE(run_id, task_id, number, worker)
  );
  CREATE TABLE IF NOT EXISTS approvals (
    run_id TEXT NOT NULL, gate TEXT NOT NULL, approved_at TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'user', PRIMARY KEY(run_id, gate)
  );
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
    type TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worker_metrics (
    worker TEXT NOT NULL, task_class TEXT NOT NULL, runs INTEGER NOT NULL DEFAULT 0,
    passes INTEGER NOT NULL DEFAULT 0, total_duration_ms INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY(worker, task_class)
  );
  CREATE TABLE IF NOT EXISTS brain_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
    cost_usd REAL NOT NULL, created_at TEXT NOT NULL
  );
`

const isBusy = (error) => /SQLITE_BUSY|database is locked|database table is locked/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`)

// Retry a mutating write through transient SQLITE_BUSY contention. Synchronous
// busy-wait backoff (node:sqlite is sync); kept short so a stuck lock still surfaces.
function withBusyRetry(fn, attempts = 10) {
  for (let i = 0; ; i++) {
    try { return fn() }
    catch (error) {
      if (!isBusy(error) || i >= attempts - 1) throw error
      const until = Date.now() + Math.min(50, 5 * (i + 1))
      while (Date.now() < until) { /* spin backoff */ }
    }
  }
}

export class StateStore {
  constructor(file) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      this.db = new DatabaseSync(file)
      // One PRAGMA per exec so a failure is attributable and not silently
      // dropped after an earlier statement in a batch.
      this.db.exec('PRAGMA busy_timeout=5000')
      this.db.exec('PRAGMA journal_mode=WAL')
      this.db.exec('PRAGMA foreign_keys=ON')
      const mode = this.db.prepare('PRAGMA journal_mode').get()?.journal_mode
      if (String(mode).toLowerCase() !== 'wal') throw new Error(`failed to enable WAL journal_mode (got ${mode})`)
      this.migrate()
    } catch (error) {
      throw new Error(`failed to open state db at ${file}: ${error.message}`)
    }
  }

  migrate() {
    // schema_meta is a singleton row (id=1). INSERT OR IGNORE makes concurrent
    // migrate() calls converge instead of inserting duplicate version rows.
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)')
    this.db.exec(BASE_TABLES)
    this.db.prepare('INSERT OR IGNORE INTO schema_meta(id,version) VALUES(1,?)').run(SCHEMA_VERSION)

    const stored = this.db.prepare('SELECT version FROM schema_meta WHERE id=1').get()?.version ?? SCHEMA_VERSION
    if (stored > SCHEMA_VERSION) return // newer/unknown db: leave it; reads still work, writes will likely fail loudly
    for (let v = stored + 1; v <= SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v]
      this.transaction(() => {
        if (step) step(this.db)
        this.db.prepare('UPDATE schema_meta SET version=? WHERE id=1').run(v)
      })
    }
  }

  transaction(fn) {
    return withBusyRetry(() => {
      this.db.exec('BEGIN IMMEDIATE')
      try { const result = fn(); this.db.exec('COMMIT'); return result }
      catch (error) { this.db.exec('ROLLBACK'); throw error }
    })
  }

  createRun({ id = randomUUID(), repo, baseSha, plan, policy, integrationBranch = null, waves = [] }) {
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db.prepare(`INSERT INTO runs(id,repo,base_sha,integration_branch,status,plan_json,policy_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, repo, baseSha, integrationBranch, 'awaiting_plan_approval', JSON.stringify(plan), JSON.stringify(policy), now, now)
      const insert = this.db.prepare('INSERT INTO tasks(run_id,task_id,status,wave,worker,model_tier) VALUES(?,?,?,?,?,?)')
      let inserted = 0
      waves.forEach((wave, index) => wave.forEach((task) => { insert.run(id, task.id, 'pending', index + 1, task.cli ?? null, task.model_tier ?? null); inserted++ }))
      if (inserted !== plan.tasks.length) throw new Error(`task count mismatch: inserted ${inserted} from waves but plan has ${plan.tasks.length}`)
      this.appendEvent(id, 'run.created', { baseSha, taskCount: plan.tasks.length })
    })
    return id
  }

  appendEvent(runId, type, payload = {}, taskId = null) {
    withBusyRetry(() => this.db.prepare('INSERT INTO events(run_id,type,task_id,created_at,payload_json) VALUES(?,?,?,?,?)')
      .run(runId, type, taskId, new Date().toISOString(), JSON.stringify(payload)))
  }

  setRunStatus(runId, status, extra = {}) {
    const now = new Date().toISOString()
    const run = this.getRun(runId)
    if (!run) throw new Error(`run not found: ${runId}`)
    this.transaction(() => {
      this.db.prepare('UPDATE runs SET status=?,updated_at=?,target_sha=?,report_json=? WHERE id=?')
        .run(status, now, extra.targetSha ?? run.target_sha, extra.report === undefined ? run.report_json : JSON.stringify(extra.report), runId)
      this.appendEvent(runId, `run.${status}`, extra)
    })
  }

  approve(runId, gate, actor = 'user') {
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO approvals(run_id,gate,approved_at,actor) VALUES(?,?,?,?)').run(runId, gate, now, actor)
      this.appendEvent(runId, 'approval.granted', { gate, actor })
    })
  }

  isApproved(runId, gate) { return Boolean(this.db.prepare('SELECT 1 FROM approvals WHERE run_id=? AND gate=?').get(runId, gate)) }

  updateTask(runId, taskId, status, data = {}) {
    this.transaction(() => {
      this.db.prepare(`UPDATE tasks SET status=?,worker=COALESCE(?,worker),model_tier=COALESCE(?,model_tier),
        attempts=COALESCE(?,attempts),last_error=?,result_json=? WHERE run_id=? AND task_id=?`)
        .run(status, data.worker ?? null, data.modelTier ?? null, data.attempts ?? null, data.lastError ?? null,
          data.result === undefined ? null : JSON.stringify(data.result), runId, taskId)
      this.appendEvent(runId, `task.${status}`, data, taskId)
    })
  }

  startAttempt({ runId, taskId, number, worker, model, pid = null, logPath = null }) {
    const now = new Date().toISOString()
    return this.transaction(() => {
      const r = this.db.prepare(`INSERT INTO attempts(run_id,task_id,number,worker,model,status,pid,started_at,log_path)
        VALUES(?,?,?,?,?,'running',?,?,?)`).run(runId, taskId, number, worker, model ?? null, pid, now, logPath)
      const attemptId = Number(r.lastInsertRowid)
      this.appendEvent(runId, 'attempt.started', { number, worker, model, pid, attemptId }, taskId)
      return attemptId
    })
  }

  finishAttempt(id, result) {
    const finished = new Date().toISOString()
    const row = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id)
    if (!row) throw new Error(`attempt not found: ${id}`)
    this.transaction(() => {
      this.db.prepare(`UPDATE attempts SET status=?,finished_at=?,exit_code=?,duration_ms=?,input_tokens=?,output_tokens=?,cost_usd=?,error_kind=?,result_json=? WHERE id=?`)
        .run(result.status, finished, result.exitCode ?? null, result.durationMs ?? null, result.inputTokens ?? null,
          result.outputTokens ?? null, result.costUsd ?? null, result.errorKind ?? null, JSON.stringify(result), id)
      this.appendEvent(row.run_id, 'attempt.finished', { attemptId: id, ...result }, row.task_id)
    })
  }

  recordMetric(worker, taskClass, { passed, durationMs = 0, costUsd = 0 }) {
    const now = new Date().toISOString()
    withBusyRetry(() => this.db.prepare(`INSERT INTO worker_metrics(worker,task_class,runs,passes,total_duration_ms,total_cost_usd,updated_at)
      VALUES(?,?,1,?,?,?,?) ON CONFLICT(worker,task_class) DO UPDATE SET runs=runs+1,passes=passes+excluded.passes,
      total_duration_ms=total_duration_ms+excluded.total_duration_ms,total_cost_usd=total_cost_usd+excluded.total_cost_usd,updated_at=excluded.updated_at`)
      .run(worker, taskClass, passed ? 1 : 0, durationMs, costUsd, now))
  }

  // Persist brain (LLM) spend. Signature matches the runner: recordBrainCost({ runId, costUsd }).
  recordBrainCost({ runId, costUsd }) {
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db.prepare('INSERT INTO brain_costs(run_id,cost_usd,created_at) VALUES(?,?,?)').run(runId, costUsd ?? 0, now)
      this.appendEvent(runId, 'brain.cost', { costUsd: costUsd ?? 0 })
    })
  }

  getMetrics() { return this.db.prepare('SELECT * FROM worker_metrics ORDER BY worker,task_class').all() }
  // Total spend = worker attempt cost + brain (LLM) cost.
  totalCost() {
    const attempts = this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS total FROM attempts').get().total
    const brain = this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS total FROM brain_costs').get().total
    return attempts + brain
  }
  getRun(id) { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) ?? null }
  getTasks(id) { return this.db.prepare('SELECT * FROM tasks WHERE run_id=? ORDER BY wave,task_id').all(id) }
  getAttempts(id) { return this.db.prepare('SELECT * FROM attempts WHERE run_id=? ORDER BY id').all(id) }
  getEvents(id, after = 0) { return this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq').all(id, after).map(e => ({ ...e, payload: JSON.parse(e.payload_json) })) }
  listRuns() { return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() }
  close() { this.db.close() }
}

export function openRepoStore(repo) { return new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite')) }
