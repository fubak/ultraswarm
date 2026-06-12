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
