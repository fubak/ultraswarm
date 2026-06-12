const DEFAULTS = Object.freeze({
  haiku:  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  opus:   { provider: 'anthropic', model: 'claude-opus-4-8' },
  fable:  { provider: 'anthropic', model: 'claude-fable-5' },
})

export function resolveBrainModel(tier, config = {}) {
  const base = DEFAULTS[tier]
  if (!base) throw new Error(`Unknown brain tier "${tier}". Allowed: ${Object.keys(DEFAULTS).join(', ')}`)
  const override = config.intelligence?.modelRouting?.models?.[tier]
  return override ? { ...base, model: override } : { ...base }
}
