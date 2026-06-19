import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest, AnthropicClient } from './anthropic.mjs'

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

// buildRequest: system prompt included when provided (line 8 true branch)
test('buildRequest includes system field when system is provided', () => {
  const req = buildRequest({ prompt: 'p', model: 'claude-haiku-4-5', system: 'be concise' })
  assert.equal(req.system, 'be concise')
})

// buildRequest: no schema → output_config.format not set (line 10 false branch)
test('buildRequest omits output_config.format when no schema', () => {
  const req = buildRequest({ prompt: 'p', model: 'claude-haiku-4-5' })
  assert.equal(req.output_config.format, undefined)
})

// Line 16-17: AnthropicClient constructor throws when apiKey is absent and ANTHROPIC_API_KEY env is unset.
test('AnthropicClient constructor throws when no apiKey is provided', () => {
  const saved = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    assert.throws(
      () => new AnthropicClient(),
      /ANTHROPIC_API_KEY is required/
    )
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
  }
})

// Line 18: constructor builds this.client when apiKey is provided (no network call — SDK stores key locally).
test('AnthropicClient constructor succeeds with a provided apiKey', () => {
  const client = new AnthropicClient({ apiKey: 'test-key-abc' })
  assert.ok(client.client, 'this.client should be set')
  assert.equal(typeof client.client.messages.create, 'function')
})

// Lines 20-23: complete() — stub this.client.messages.create to avoid real API call.
// Branch A: with schema — parses the text content block as JSON.
test('AnthropicClient.complete with schema parses text content as JSON (stubbed SDK)', async () => {
  const client = new AnthropicClient({ apiKey: 'test-key-abc' })
  client.client = {
    messages: {
      create: async (_req) => ({
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    },
  }
  const r = await client.complete({ prompt: 'p', schema: SCHEMA, model: 'claude-haiku-4-5' })
  assert.deepEqual(r.object, { ok: true })
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 4 })
})

// Branch B: without schema — returns the raw concatenated text.
test('AnthropicClient.complete without schema returns raw text (stubbed SDK)', async () => {
  const client = new AnthropicClient({ apiKey: 'test-key-abc' })
  client.client = {
    messages: {
      create: async (_req) => ({
        content: [
          { type: 'thinking', thinking: 'internal thoughts' },
          { type: 'text', text: 'hello' },
          { type: 'text', text: ' world' },
        ],
        usage: { input_tokens: 8, output_tokens: 3 },
      }),
    },
  }
  const r = await client.complete({ prompt: 'p', model: 'claude-haiku-4-5' })
  // Only text blocks are joined; thinking blocks are filtered out.
  assert.equal(r.object, 'hello world')
  assert.deepEqual(r.usage, { input_tokens: 8, output_tokens: 3 })
})

// #S2: on a schema call, a non-JSON / truncated response must NOT throw out of complete() — it must
// return raw text so completeWithSchema's validateOrThrow rejects it and retries (claude-cli does
// this; anthropic must match). A bare JSON.parse threw, escaping the retry loop entirely.
test('complete with schema returns raw text on non-JSON output so the validator can retry (#S2)', async () => {
  const client = new AnthropicClient({ apiKey: 'test-key-abc' })
  client.client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Sure! ```not valid json```' }], usage: {} }) } }
  const r = await client.complete({ prompt: 'p', schema: SCHEMA, model: 'claude-haiku-4-5' })
  assert.equal(typeof r.object, 'string')   // raw text, not a thrown SyntaxError
  assert.match(r.object, /not valid json/)
})

// And a fenced ```json block on a schema call is still extracted to an object.
test('complete with schema extracts a fenced ```json block (#S2)', async () => {
  const client = new AnthropicClient({ apiKey: 'test-key-abc' })
  client.client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Here:\n```json\n{"ok":true}\n```' }], usage: {} }) } }
  const r = await client.complete({ prompt: 'p', schema: SCHEMA, model: 'claude-haiku-4-5' })
  assert.deepEqual(r.object, { ok: true })
})
