import Anthropic from '@anthropic-ai/sdk'

// Models that accept adaptive thinking + output_config.effort. Haiku 4.5 rejects both (400).
const THINKING_MODELS = new Set(['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5'])

export function buildRequest({ system, prompt, schema, model, effort = 'high' }) {
  const req = { model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }], output_config: {} }
  if (system) req.system = system
  if (THINKING_MODELS.has(model)) { req.thinking = { type: 'adaptive' }; req.output_config.effort = effort }
  if (schema) req.output_config.format = { type: 'json_schema', schema }
  return req
}

// Extract a JSON object/array from model text (handles ```json fences and prose wrappers). Returns
// the parsed value, or null if nothing parses — the caller then returns the RAW text so
// completeWithSchema's validator rejects-and-retries, instead of a bare JSON.parse throwing out of
// the retry loop entirely (claude-cli.mjs does the same) (#S2).
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()
  try { return JSON.parse(candidate) } catch {}
  const span = candidate.match(/[{[][\s\S]*[}\]]/)
  if (span) { try { return JSON.parse(span[0]) } catch {} }
  return null
}

export class AnthropicClient {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for the standalone runner brain')
    this.client = new Anthropic({ apiKey })
  }
  async complete(opts) {
    const res = await this.client.messages.create(buildRequest(opts))
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    return { object: opts.schema ? (extractJson(text) ?? text) : text, usage: res.usage }
  }
}
