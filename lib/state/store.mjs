import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

const SCHEMA_VERSION = 1

export class StateStore {
  constructor(file) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
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
    `)
    const version = this.db.prepare('SELECT version FROM schema_meta LIMIT 1').get()?.version
    if (version !== SCHEMA_VERSION) throw new Error(`unsupported state schema ${version}; expected ${SCHEMA_VERSION}`)
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  createRun({ id = randomUUID(), repo, baseSha, plan, policy, integrationBranch = null, waves = [] }) {
    const now = new Date().toISOString()
    this.transaction(() => {
      this.db.prepare(`INSERT INTO runs(id,repo,base_sha,integration_branch,status,plan_json,policy_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, repo, baseSha, integrationBranch, 'awaiting_plan_approval', JSON.stringify(plan), JSON.stringify(policy), now, now)
      const insert = this.db.prepare('INSERT INTO tasks(run_id,task_id,status,wave,worker,model_tier) VALUES(?,?,?,?,?,?)')
      waves.forEach((wave, index) => wave.forEach((task) => insert.run(id, task.id, 'pending', index + 1, task.cli ?? null, task.model_tier ?? null)))
      this.appendEvent(id, 'run.created', { baseSha, taskCount: plan.tasks.length })
    })
    return id
  }

  appendEvent(runId, type, payload = {}, taskId = null) {
    this.db.prepare('INSERT INTO events(run_id,type,task_id,created_at,payload_json) VALUES(?,?,?,?,?)')
      .run(runId, type, taskId, new Date().toISOString(), JSON.stringify(payload))
  }

  setRunStatus(runId, status, extra = {}) {
    const now = new Date().toISOString()
    const run = this.getRun(runId)
    if (!run) throw new Error(`run not found: ${runId}`)
    this.db.prepare('UPDATE runs SET status=?,updated_at=?,target_sha=?,report_json=? WHERE id=?')
      .run(status, now, extra.targetSha ?? run.target_sha, extra.report === undefined ? run.report_json : JSON.stringify(extra.report), runId)
    this.appendEvent(runId, `run.${status}`, extra)
  }

  approve(runId, gate, actor = 'user') {
    const now = new Date().toISOString()
    this.db.prepare('INSERT OR REPLACE INTO approvals(run_id,gate,approved_at,actor) VALUES(?,?,?,?)').run(runId, gate, now, actor)
    this.appendEvent(runId, 'approval.granted', { gate, actor })
  }

  isApproved(runId, gate) { return Boolean(this.db.prepare('SELECT 1 FROM approvals WHERE run_id=? AND gate=?').get(runId, gate)) }

  updateTask(runId, taskId, status, data = {}) {
    this.db.prepare(`UPDATE tasks SET status=?,worker=COALESCE(?,worker),model_tier=COALESCE(?,model_tier),
      attempts=COALESCE(?,attempts),last_error=?,result_json=? WHERE run_id=? AND task_id=?`)
      .run(status, data.worker ?? null, data.modelTier ?? null, data.attempts ?? null, data.lastError ?? null,
        data.result === undefined ? null : JSON.stringify(data.result), runId, taskId)
    this.appendEvent(runId, `task.${status}`, data, taskId)
  }

  startAttempt({ runId, taskId, number, worker, model, pid = null, logPath = null }) {
    const now = new Date().toISOString()
    const r = this.db.prepare(`INSERT INTO attempts(run_id,task_id,number,worker,model,status,pid,started_at,log_path)
      VALUES(?,?,?,?,?,'running',?,?,?)`).run(runId, taskId, number, worker, model ?? null, pid, now, logPath)
    this.appendEvent(runId, 'attempt.started', { number, worker, model, pid, attemptId: Number(r.lastInsertRowid) }, taskId)
    return Number(r.lastInsertRowid)
  }

  finishAttempt(id, result) {
    const finished = new Date().toISOString()
    const row = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id)
    if (!row) throw new Error(`attempt not found: ${id}`)
    this.db.prepare(`UPDATE attempts SET status=?,finished_at=?,exit_code=?,duration_ms=?,input_tokens=?,output_tokens=?,cost_usd=?,error_kind=?,result_json=? WHERE id=?`)
      .run(result.status, finished, result.exitCode ?? null, result.durationMs ?? null, result.inputTokens ?? null,
        result.outputTokens ?? null, result.costUsd ?? null, result.errorKind ?? null, JSON.stringify(result), id)
    this.appendEvent(row.run_id, 'attempt.finished', { attemptId: id, ...result }, row.task_id)
  }

  recordMetric(worker, taskClass, { passed, durationMs = 0, costUsd = 0 }) {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO worker_metrics(worker,task_class,runs,passes,total_duration_ms,total_cost_usd,updated_at)
      VALUES(?,?,1,?,?,?,?) ON CONFLICT(worker,task_class) DO UPDATE SET runs=runs+1,passes=passes+excluded.passes,
      total_duration_ms=total_duration_ms+excluded.total_duration_ms,total_cost_usd=total_cost_usd+excluded.total_cost_usd,updated_at=excluded.updated_at`)
      .run(worker, taskClass, passed ? 1 : 0, durationMs, costUsd, now)
  }

  getMetrics() { return this.db.prepare('SELECT * FROM worker_metrics ORDER BY worker,task_class').all() }
  totalCost() { return this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS total FROM attempts').get().total }
  getRun(id) { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) ?? null }
  getTasks(id) { return this.db.prepare('SELECT * FROM tasks WHERE run_id=? ORDER BY wave,task_id').all(id) }
  getAttempts(id) { return this.db.prepare('SELECT * FROM attempts WHERE run_id=? ORDER BY id').all(id) }
  getEvents(id, after = 0) { return this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq').all(id, after).map(e => ({ ...e, payload: JSON.parse(e.payload_json) })) }
  listRuns() { return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() }
  close() { this.db.close() }
}

export function openRepoStore(repo) { return new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite')) }
