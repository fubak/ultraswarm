import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateOrThrow, completeWithSchema } from './validate.mjs'

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }

test('validateOrThrow accepts conforming, throws on non-conforming', () => {
  assert.deepEqual(validateOrThrow({ ok: true }, SCHEMA), { ok: true })
  assert.throws(() => validateOrThrow({ nope: 1 }, SCHEMA), /required/)
})

test('completeWithSchema retries once then succeeds', async () => {
  let n = 0
  const raw = async () => (++n === 1 ? { object: { nope: 1 }, usage: {} } : { object: { ok: true }, usage: {} })
  const r = await completeWithSchema(raw, { schema: SCHEMA, maxRetries: 2 })
  assert.deepEqual(r.object, { ok: true })
  assert.equal(n, 2)
})

test('completeWithSchema returns null after exhausting retries', async () => {
  const r = await completeWithSchema(async () => ({ object: { nope: 1 }, usage: {} }), { schema: SCHEMA, maxRetries: 1 })
  assert.equal(r, null)
})
