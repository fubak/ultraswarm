import { AnthropicClient } from '../lib/llm/anthropic.mjs'
const c = new AnthropicClient()
const r = await c.complete({ prompt: 'Return JSON {"ok": true}.', model: 'claude-haiku-4-5',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
console.log('object:', r.object, 'usage:', r.usage)
