import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport } from './report.mjs'

test('buildReport summarizes merged, failed, and external tokens', () => {
  const r = buildReport({
    merged: [{ task: 't1', merged: true }, { task: 't2', merged: false, reason: 'post-merge gate regression' }],
    failed: ['t3'], externalTokens: 1234,
  })
  assert.match(r, /t1/); assert.match(r, /t3/); assert.match(r, /1234/)
  assert.match(r, /post-merge gate regression/)
})

test('buildReport renders blocked tasks, attempts, and a metrics summary (#10/#11)', () => {
  const r = buildReport({
    merged: [{ task: 't1', merged: true }],
    failed: ['t2'],
    blocked: [{ task: 't3', reason: 'dependency t2 did not merge' }],
    externalTokens: 500, attempts: { t1: 1, t2: 3 }, taskCount: 3,
    tokenCoverage: { captured: 1, total: 1 },
  })
  assert.match(r, /t3 \| blocked — dependency t2 did not merge/)
  assert.match(r, /Summary: 1\/3 merged · 1 failed · 1 blocked \(33% success\)/)
  assert.match(r, /captured 1\/1 runs/)
})
