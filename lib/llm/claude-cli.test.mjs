import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClaudeCliClient, extractJson, buildArgs } from './claude-cli.mjs'

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }

test('extractJson handles plain, fenced, and prose-wrapped JSON; returns null on garbage', () => {
  assert.deepEqual(extractJson('{"ok":true}'), { ok: true })
  assert.deepEqual(extractJson('```json\n{"ok":true}\n```'), { ok: true })
  assert.deepEqual(extractJson('Here is the result: {"ok":true} — done.'), { ok: true })
  assert.equal(extractJson('no json here'), null)
  assert.equal(extractJson('{ not valid'), null)
})

test('buildArgs uses headless print + json output, appends schema instruction, adds --model', () => {
  const args = buildArgs({ prompt: 'do it', schema: SCHEMA, model: 'claude-haiku-4-5' })
  assert.ok(args.includes('-p'))
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'json'])
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-4-5')
  // schema instruction folded into the prompt (first arg after -p)
  assert.match(args[args.indexOf('-p') + 1], /JSON object matching this JSON Schema/)
  assert.match(args[args.indexOf('-p') + 1], /"required":\["ok"\]/)
})

test('complete parses the claude -p envelope into { object, usage } using an injected runner', async () => {
  const run = (_bin, _args) => ({
    type: 'result', subtype: 'success', is_error: false,
    result: 'Sure: ```json\n{"ok":true}\n```',
    usage: { input_tokens: 12, output_tokens: 3 },
  })
  const client = new ClaudeCliClient({ run })
  const r = await client.complete({ prompt: 'p', schema: SCHEMA, model: 'claude-haiku-4-5' })
  assert.deepEqual(r.object, { ok: true })
  assert.equal(r.usage.input_tokens, 12)
  assert.equal(r.usage.output_tokens, 3)
})

test('complete throws on an error envelope (so the run fails closed)', async () => {
  const run = () => ({ subtype: 'error_during_execution', is_error: true, result: 'boom' })
  const client = new ClaudeCliClient({ run })
  await assert.rejects(() => client.complete({ prompt: 'p', schema: SCHEMA }), /claude -p failed/)
})

test('without a schema, complete returns the raw result text', async () => {
  const run = () => ({ subtype: 'success', is_error: false, result: 'hello', usage: {} })
  const client = new ClaudeCliClient({ run })
  const r = await client.complete({ prompt: 'p' })
  assert.equal(r.object, 'hello')
})
