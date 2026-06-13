import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
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
