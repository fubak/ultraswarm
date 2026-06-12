import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockLlmClient } from './client.mjs'

test('MockLlmClient routes by label and records calls', async () => {
  const c = new MockLlmClient((label) =>
    label.startsWith('review') ? { object: { approve: true }, usage: {} } : { object: {}, usage: {} })
  const r = await c.complete({ label: 'review:t1', prompt: 'p', model: 'haiku' })
  assert.deepEqual(r.object, { approve: true })
  assert.equal(c.calls[0].model, 'haiku')
  assert.equal(c.calls[0].label, 'review:t1')
})
