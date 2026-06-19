import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StateStore } from './store.mjs'

test('StateStore persists runs, approvals, attempts, events, and metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  const plan = { tasks: [{ id: 'a' }] }
  const id = store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan, policy: {}, waves: [[{ id: 'a', cli: 'codex', model_tier: 'simple' }]] })
  assert.equal(id, 'r1'); assert.equal(store.getRun(id).status, 'awaiting_plan_approval')
  store.approve(id, 'plan'); assert.equal(store.isApproved(id, 'plan'), true)
  const attempt = store.startAttempt({ runId: id, taskId: 'a', number: 1, worker: 'codex', model: 'm' })
  store.finishAttempt(attempt, { status: 'passed', exitCode: 0, durationMs: 12, inputTokens: 1, outputTokens: 2, costUsd: 0.01 })
  store.updateTask(id, 'a', 'passed', { attempts: 1, result: { ok: true } })
  store.recordMetric('codex', 'tests', { passed: true, durationMs: 12, costUsd: 0.01 })
  assert.equal(store.getAttempts(id)[0].status, 'passed')
  assert.equal(store.getMetrics()[0].passes, 1)
  assert.ok(store.getEvents(id).some((event) => event.type === 'approval.granted'))
  store.close()
})

test('StateStore transaction rolls back atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  assert.throws(() => store.transaction(() => { store.db.prepare('INSERT INTO worker_metrics VALUES(?,?,?,?,?,?,?)').run('x', 'x', 1, 1, 1, 1, 'now'); throw new Error('stop') }))
  assert.equal(store.getMetrics().length, 0); store.close()
})

// Task 1b: WAL must actually be enabled, not silently dropped.
test('StateStore enables WAL journal_mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  assert.equal(String(store.db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal')
  store.close()
})

// Task 3: schema_meta is a singleton (id=1) — re-opening must not create a 2nd version row.
test('schema_meta stays a single row across re-opens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const file = path.join(dir, 'state.sqlite')
  const a = new StateStore(file); a.close()
  const b = new StateStore(file)
  assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM schema_meta').get().n, 1)
  // and the singleton CHECK(id=1) must reject any second row
  assert.throws(() => b.db.prepare('INSERT INTO schema_meta(id,version) VALUES(2,1)').run())
  b.close()
})

// Task 2: a NEWER/unknown stored schema version must still allow read-only ops.
test('newer stored schema version still permits read-only operations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const file = path.join(dir, 'state.sqlite')
  const seed = new StateStore(file)
  seed.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }] }, policy: {}, waves: [[{ id: 'a' }]] })
  seed.db.prepare('UPDATE schema_meta SET version=999 WHERE id=1').run() // pretend a future build wrote this
  seed.close()
  const reopened = new StateStore(file) // must NOT throw despite unknown version
  assert.equal(reopened.getRun('r1').id, 'r1')
  assert.equal(reopened.getTasks('r1').length, 1)
  reopened.close()
})

// Task 4: finishAttempt's UPDATE + event append are atomic — a failure in either rolls back both.
test('finishAttempt is atomic (no orphan event without the update)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }] }, policy: {}, waves: [[{ id: 'a' }]] })
  const att = store.startAttempt({ runId: 'r1', taskId: 'a', number: 1, worker: 'codex', model: 'm' })
  const before = store.getEvents('r1').length
  // costUsd is a getter that throws AFTER the UPDATE statement but BEFORE the event append would commit
  const poison = { get status() { return 'passed' }, get costUsd() { throw new Error('boom') } }
  assert.throws(() => store.finishAttempt(att, poison))
  // attempt must remain 'running' (UPDATE rolled back) and no extra event was committed
  assert.equal(store.getAttempts('r1')[0].status, 'running')
  assert.equal(store.getEvents('r1').length, before)
  store.close()
})

// Task 5: totalCost() sums worker attempt cost AND recordBrainCost spend.
test('totalCost sums worker attempt cost and brain cost', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }] }, policy: {}, waves: [[{ id: 'a' }]] })
  const att = store.startAttempt({ runId: 'r1', taskId: 'a', number: 1, worker: 'codex', model: 'm' })
  store.finishAttempt(att, { status: 'passed', exitCode: 0, costUsd: 0.10 })
  store.recordBrainCost({ runId: 'r1', costUsd: 0.05 })
  assert.ok(Math.abs(store.totalCost() - 0.15) < 1e-9, `expected 0.15, got ${store.totalCost()}`)
  store.close()
})

// Task 6: createRun must throw loudly when waves don't yield plan.tasks.length tasks.
test('createRun throws when inserted task count != plan.tasks.length', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  assert.throws(
    () => store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }, { id: 'b' }] }, policy: {}, waves: [[{ id: 'a' }]] }),
    /task count mismatch/
  )
  assert.equal(store.getRun('r1'), null) // and the partial run was rolled back
  store.close()
})

// Task 7: a corrupt/garbage state.sqlite must surface a clear, actionable error.
test('opening a corrupt db surfaces a clear error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const file = path.join(dir, 'state.sqlite')
  fs.writeFileSync(file, 'this is not a sqlite database at all')
  assert.throws(() => new StateStore(file), /failed to open state db/)
})

// setRunStatus: covers lines 135-143 — status update, event append, and both branches of
// extra.report (undefined → keep existing, defined → serialise) and extra.targetSha (absent/present).
test('setRunStatus updates status and appends event', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }] }, policy: {}, waves: [[{ id: 'a' }]] })
  // Call with no targetSha and no report — exercises extra.targetSha ?? run.target_sha (null) and extra.report === undefined branch.
  store.setRunStatus('r1', 'in_progress')
  assert.equal(store.getRun('r1').status, 'in_progress')
  assert.ok(store.getEvents('r1').some((e) => e.type === 'run.in_progress'))
  store.close()
})

test('setRunStatus with targetSha and report covers both ?? and ternary branches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }] }, policy: {}, waves: [[{ id: 'a' }]] })
  // Provide both targetSha (covers ?? left branch) and report (covers ternary false branch → JSON.stringify).
  store.setRunStatus('r1', 'done', { targetSha: 'sha999', report: { ok: true } })
  const run = store.getRun('r1')
  assert.equal(run.status, 'done')
  assert.equal(run.target_sha, 'sha999')
  assert.deepEqual(JSON.parse(run.report_json), { ok: true })
  store.close()
})

test('setRunStatus throws when run does not exist', () => {
  // WHY: the !run guard on line 137 must throw to prevent silent no-ops on phantom run IDs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  assert.throws(() => store.setRunStatus('no-such-run', 'done'), /run not found/)
  store.close()
})

// #ST4: terminal runs (merged/cancelled) must be immutable, so a straggler process or a stray
// resume can't resurrect a finished run into an active status.
test('setRunStatus refuses to move a terminal run backward (#ST4)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r', repo: dir, baseSha: 'b', plan: { tasks: [] }, policy: {}, waves: [] })
  store.setRunStatus('r', 'merged')
  assert.throws(() => store.setRunStatus('r', 'running'), /terminal/i)
  assert.equal(store.getRun('r').status, 'merged')
  store.setRunStatus('r', 'merged')   // idempotent same-status write is allowed
  store.close()
})

// #ST1/#ST2: the orchestrator's identity (pid + boot id) is persisted so recovery can judge liveness
// on the durable orchestrator, not transient worker pids, and defeat PID reuse across reboots.
test('setOrchestrator persists pid + boot id; bootId is stable within a process (#ST1,#ST2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r', repo: dir, baseSha: 'b', plan: { tasks: [] }, policy: {}, waves: [] })
  store.setOrchestrator('r', 4242, 'boot-xyz')
  const run = store.getRun('r')
  assert.equal(run.orchestrator_pid, 4242)
  assert.equal(run.orchestrator_boot, 'boot-xyz')
  assert.equal(store.bootId(), store.bootId())   // stable within the process
  store.close()
})

// updateTask: cover data.result === undefined branch (null stored) vs. defined branch (JSON).
test('updateTask with no result field stores null for result_json', () => {
  // WHY: the `data.result === undefined ? null : JSON.stringify(data.result)` ternary has two branches;
  // existing tests only call it with a result object, leaving the null branch uncovered.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }] }, policy: {}, waves: [[{ id: 'a' }]] })
  // Call without result — exercises the undefined branch (stores null).
  store.updateTask('r1', 'a', 'running')
  const task = store.getTasks('r1')[0]
  assert.equal(task.status, 'running')
  assert.equal(task.result_json, null)
  store.close()
})

// finishAttempt: !row guard — throws when attempt id does not exist.
test('finishAttempt throws when attempt id not found', () => {
  // WHY: line 179 `if (!row) throw` — the !row=true branch never taken by any existing test.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  assert.throws(() => store.finishAttempt(9999, { status: 'passed' }), /attempt not found/)
  store.close()
})

// startAttempt with model=null: covers the `model ?? null` right-side branch (line 169).
test('startAttempt with null model stores null in db', () => {
  // WHY: all existing startAttempt calls pass model:'m' — the `model ?? null` left-side is taken.
  // Passing model=null/undefined exercises the right-side ?? null branch.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }] }, policy: {}, waves: [[{ id: 'a' }]] })
  const att = store.startAttempt({ runId: 'r1', taskId: 'a', number: 1, worker: 'codex', model: null })
  const row = store.getAttempts('r1')[0]
  assert.equal(row.model, null)
  assert.equal(typeof att, 'number')
  store.close()
})

// recordMetric with passed=false: covers the `passed ? 1 : 0` false branch (line 193).
test('recordMetric tracks failed runs (passed=false)', () => {
  // WHY: existing test only calls with passed:true — the ternary `? 1 : 0` false branch is uncovered.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.recordMetric('codex', 'tests', { passed: false, durationMs: 10, costUsd: 0.02 })
  const m = store.getMetrics()[0]
  assert.equal(m.passes, 0)
  assert.equal(m.runs, 1)
  store.close()
})

// recordBrainCost with costUsd=undefined: covers `costUsd ?? 0` right-side branch (lines 200-201).
test('recordBrainCost with undefined costUsd defaults to 0', () => {
  // WHY: existing test passes costUsd:0.05, hitting the left-side of `??`. Undefined exercises
  // the right-side (fallback 0) on both line 200 and line 201.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }] }, policy: {}, waves: [[{ id: 'a' }]] })
  store.recordBrainCost({ runId: 'r1', costUsd: undefined })
  assert.ok(Math.abs(store.totalCost()) < 1e-9, 'undefined costUsd should store 0')
  store.close()
})

// finishAttempt with errorKind provided: covers `result.errorKind ?? null` left-side (line 183).
test('finishAttempt stores errorKind when provided', () => {
  // WHY: all existing finishAttempt calls omit errorKind → always undefined → right-side ?? null.
  // Providing errorKind exercises the left-side of the `??` expression.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const store = new StateStore(path.join(dir, 'state.sqlite'))
  store.createRun({ id: 'r1', repo: dir, baseSha: 'abc', plan: { tasks: [{ id: 'a' }] }, policy: {}, waves: [[{ id: 'a' }]] })
  const att = store.startAttempt({ runId: 'r1', taskId: 'a', number: 1, worker: 'codex', model: 'gpt' })
  store.finishAttempt(att, { status: 'failed', exitCode: 1, errorKind: 'timeout' })
  assert.equal(store.getAttempts('r1')[0].error_kind, 'timeout')
  store.close()
})

// migrate() loop body (lines 99-104): only executes when stored version < SCHEMA_VERSION.
// We manipulate the meta row directly so migrate() sees version 0 and must run the loop once.
test('migrate() loop body runs when stored version is behind SCHEMA_VERSION', () => {
  // WHY: with stored=0 and SCHEMA_VERSION=2, the loop executes for v=1 (MIGRATIONS[1]=undefined →
  // UPDATE only) then v=2 (MIGRATIONS[2] adds the orchestrator columns to a pre-v2 runs table).
  // Proves the migration loop + the v2 ALTER are reachable on an upgrade from an old DB.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-state-'))
  const file = path.join(dir, 'state.sqlite')
  // Bootstrap schema manually so we can set version=0, then let StateStore re-open and migrate.
  const bootstrap = new DatabaseSync(file)
  bootstrap.exec('CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)')
  bootstrap.exec(`
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, base_sha TEXT NOT NULL,
      integration_branch TEXT, status TEXT NOT NULL, plan_json TEXT NOT NULL,
      policy_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      target_sha TEXT, report_json TEXT);
    CREATE TABLE IF NOT EXISTS tasks (run_id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
      wave INTEGER NOT NULL, worker TEXT, model_tier TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, result_json TEXT, PRIMARY KEY(run_id, task_id));
    CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      task_id TEXT NOT NULL, number INTEGER NOT NULL, worker TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
      pid INTEGER, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, duration_ms INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, error_kind TEXT, log_path TEXT, result_json TEXT,
      UNIQUE(run_id, task_id, number, worker));
    CREATE TABLE IF NOT EXISTS approvals (run_id TEXT NOT NULL, gate TEXT NOT NULL, approved_at TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user', PRIMARY KEY(run_id, gate));
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      type TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS worker_metrics (worker TEXT NOT NULL, task_class TEXT NOT NULL, runs INTEGER NOT NULL DEFAULT 0,
      passes INTEGER NOT NULL DEFAULT 0, total_duration_ms INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(worker, task_class));
    CREATE TABLE IF NOT EXISTS brain_costs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
      cost_usd REAL NOT NULL, created_at TEXT NOT NULL);
  `)
  // Set stored version to 0 — below SCHEMA_VERSION (1) — so migrate() loop runs.
  bootstrap.prepare('INSERT INTO schema_meta(id,version) VALUES(1,0)').run()
  bootstrap.close()
  // Opening StateStore must succeed and bump version from 0 to 2 via the migration loop, adding the
  // orchestrator columns to the pre-v2 runs table.
  const store = new StateStore(file)
  assert.equal(store.db.prepare('SELECT version FROM schema_meta WHERE id=1').get().version, 2)
  const cols = store.db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name)
  assert.ok(cols.includes('orchestrator_pid') && cols.includes('orchestrator_boot'), 'v2 migration added orchestrator columns')
  store.close()
})
