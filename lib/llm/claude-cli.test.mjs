import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ClaudeCliClient, extractJson, buildArgs } from './claude-cli.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

// Lines 31-34: defaultRun — reached when no `run` is injected.
// We pass a real executable (fake-claude-bin script) as bin so execFileSync
// runs successfully without a real claude CLI or network call.
test('defaultRun (lines 31-34): executes bin via execFileSync and parses its JSON stdout', async () => {
  const fakeBin = join(__dirname, '../../fixtures/fake-claude-bin')
  // No run option → defaultRun is used (covers lines 31-34)
  const client = new ClaudeCliClient({ bin: fakeBin })
  const r = await client.complete({ prompt: 'test prompt', schema: SCHEMA, model: 'haiku' })
  assert.deepEqual(r.object, { ok: true })
  assert.equal(r.usage.input_tokens, 5)
  assert.equal(r.usage.output_tokens, 2)
})

// extractJson: non-string input → returns null early (line 10 true branch)
test('extractJson returns null for non-string input', () => {
  assert.equal(extractJson(null), null)
  assert.equal(extractJson(undefined), null)
  assert.equal(extractJson(42), null)
  assert.equal(extractJson({}), null)
})

// extractJson: JSON.parse catch path (line 16) — start/end found but content is not valid JSON
test('extractJson returns null when braces are found but JSON.parse throws', () => {
  // "{invalid}" has braces but is not parseable JSON — exercises the catch on line 16
  assert.equal(extractJson('{invalid}'), null)
  // fenced block with invalid JSON inside
  assert.equal(extractJson('```\n{bad json here}\n```'), null)
})

// buildArgs: system prompt appended (line 27 true branch)
test('buildArgs appends --append-system-prompt when system is provided', () => {
  const args = buildArgs({ prompt: 'do it', system: 'be terse', model: 'haiku' })
  const idx = args.indexOf('--append-system-prompt')
  assert.ok(idx !== -1, '--append-system-prompt flag should be present')
  assert.equal(args[idx + 1], 'be terse')
})

// complete: error envelope with no result field → error message uses just the subtype
test('complete error message omits result when result is missing', async () => {
  const run = () => ({ subtype: 'timeout', is_error: true })
  const client = new ClaudeCliClient({ run })
  await assert.rejects(
    () => client.complete({ prompt: 'p' }),
    (err) => {
      assert.match(err.message, /claude -p failed: timeout/)
      // Should NOT include the '—' separator since result is absent
      assert.ok(!err.message.includes(' — '), 'no separator when result is absent')
      return true
    }
  )
})

// complete: error envelope with no subtype → falls back to 'error' literal (line 45 || branch)
test('complete error message falls back to "error" when subtype is absent', async () => {
  const run = () => ({ is_error: true, result: 'no subtype here' })
  const client = new ClaudeCliClient({ run })
  await assert.rejects(
    () => client.complete({ prompt: 'p' }),
    /claude -p failed: error — no subtype here/
  )
})

// complete: schema call where extractJson returns null falls back to raw text
test('complete falls back to raw text when schema extraction fails', async () => {
  const run = () => ({ subtype: 'success', is_error: false, result: 'not JSON at all', usage: {} })
  const client = new ClaudeCliClient({ run })
  const r = await client.complete({ prompt: 'p', schema: SCHEMA })
  assert.equal(r.object, 'not JSON at all')
})

// complete: env.result is undefined → text defaults to ''
test('complete handles missing result field (env.result nullish)', async () => {
  const run = () => ({ subtype: 'success', is_error: false, usage: {} })
  const client = new ClaudeCliClient({ run })
  const r = await client.complete({ prompt: 'p' })
  assert.equal(r.object, '')
})
