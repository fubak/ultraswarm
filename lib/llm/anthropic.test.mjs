import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest } from './anthropic.mjs'

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }

test('haiku request omits effort and thinking (they 400 on haiku), keeps structured format', () => {
  const req = buildRequest({ prompt: 'p', schema: SCHEMA, model: 'claude-haiku-4-5', effort: 'high' })
  assert.equal(req.thinking, undefined)
  assert.equal(req.output_config.effort, undefined)
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: SCHEMA })
})

test('opus request includes adaptive thinking and effort', () => {
  const req = buildRequest({ prompt: 'p', schema: SCHEMA, model: 'claude-opus-4-8', effort: 'high' })
  assert.deepEqual(req.thinking, { type: 'adaptive' })
  assert.equal(req.output_config.effort, 'high')
})
