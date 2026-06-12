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

export class AnthropicClient {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for the standalone runner brain')
    this.client = new Anthropic({ apiKey })
  }
  async complete(opts) {
    const res = await this.client.messages.create(buildRequest(opts))
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    return { object: opts.schema ? JSON.parse(text) : text, usage: res.usage }
  }
}
