import { execFileSync } from 'node:child_process'

// Brain adapter that shells out to the local, authenticated Claude Code CLI (`claude -p`)
// instead of the raw Anthropic API. Reuses your existing Claude Code auth — no ANTHROPIC_API_KEY,
// no separate API billing. Implements the same LlmClient contract as AnthropicClient:
//   complete({ system?, prompt, schema?, model, effort?, label? }) -> { object, usage }

// Pull a JSON object out of model text (handles ```json fences and surrounding prose).
export function extractJson(text) {
  if (typeof text !== 'string') return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try { return JSON.parse(body.slice(start, end + 1)) } catch { return null }
}

// claude -p has no JSON-schema constraint like the API's output_config.format, so we fold the
// schema into the prompt and rely on the caller's validate-and-retry wrapper (completeWithSchema).
export function buildArgs({ prompt, schema, model, system }) {
  const fullPrompt = schema
    ? `${prompt}\n\nRespond with ONLY a JSON object matching this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(schema)}`
    : prompt
  const args = ['-p', fullPrompt, '--output-format', 'json']
  if (model) args.push('--model', model)
  if (system) args.push('--append-system-prompt', system)
  return args
}

function defaultRun(bin, args) {
  const raw = execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(raw)
}

export class ClaudeCliClient {
  constructor({ bin = 'claude', run = defaultRun } = {}) {
    this.bin = bin
    this.run = run
  }

  async complete({ system, prompt, schema, model }) {
    const env = this.run(this.bin, buildArgs({ prompt, schema, model, system }))
    if (env.is_error || env.subtype !== 'success') {
      throw new Error(`claude -p failed: ${env.subtype || 'error'}${env.result ? ` — ${env.result}` : ''}`)
    }
    const text = env.result ?? ''
    const usage = { input_tokens: env.usage?.input_tokens, output_tokens: env.usage?.output_tokens }
    // On a schema call, return the parsed object; if extraction fails, return the raw text so the
    // caller's schema validation rejects it and retries (rather than throwing here).
    return { object: schema ? (extractJson(text) ?? text) : text, usage }
  }
}
