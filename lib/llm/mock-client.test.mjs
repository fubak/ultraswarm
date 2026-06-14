import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockLlmClient } from './mock-client.mjs'

test('MockLlmClient routes by label and records calls', async () => {
  const c = new MockLlmClient((label) =>
    label.startsWith('review') ? { object: { approve: true }, usage: {} } : { object: {}, usage: {} })
  const r = await c.complete({ label: 'review:t1', prompt: 'p', model: 'haiku' })
  assert.deepEqual(r.object, { approve: true })
  assert.equal(c.calls[0].model, 'haiku')
  assert.equal(c.calls[0].label, 'review:t1')
})

// Branch: opts.label is undefined — falls back to empty string ''
test('MockLlmClient falls back to empty string when label is omitted', async () => {
  const c = new MockLlmClient((label, opts) => ({ object: { label, prompt: opts.prompt }, usage: {} }))
  const r = await c.complete({ prompt: 'hello', model: 'haiku' })
  assert.deepEqual(r.object, { label: '', prompt: 'hello' })
  assert.equal(c.calls[0].label, '')
  assert.equal(c.calls[0].prompt, 'hello')
})

// Branch: behavior receives the full opts object (including schema)
test('MockLlmClient passes full opts to behavior', async () => {
  const received = []
  const c = new MockLlmClient((label, opts) => { received.push(opts); return { object: null, usage: {} } })
  const schema = { type: 'object' }
  await c.complete({ label: 'x', prompt: 'p', model: 'm', schema })
  assert.equal(received[0].schema, schema)
  assert.equal(received[0].model, 'm')
})
