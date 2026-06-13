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
