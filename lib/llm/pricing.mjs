// USD-per-million-token rates per model, used to convert brain.complete() usage into
// a dollar cost so the run can honour maxCostUsd (it was previously blind to brain spend).
//
// Rates below are APPROXIMATE list prices (input/output per million tokens) and are meant
// only for budget accounting, not billing. Override any model via
// config.intelligence.pricing[model] = { input, output } (USD per million tokens).
const DEFAULT_RATES = Object.freeze({
  'claude-opus-4-8':   { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3,  output: 15 },
  'claude-haiku-4-5':  { input: 1,  output: 5 },
  'claude-fable-5':    { input: 15, output: 75 },
})

// Pull input/output token counts out of the several usage shapes the SDKs/mocks emit.
// Returns { input, output } in tokens. If only a total is available it lands in `output`
// so it is priced at the (higher) output rate — a deliberately conservative default.
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0 }
  const input = usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? null
  const output = usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? null
  if (input == null && output == null) {
    const total = usage.totalTokens ?? usage.total_tokens ?? 0
    return { input: 0, output: total }   // price unknown-split totals at the output rate
  }
  return { input: input ?? 0, output: output ?? 0 }
}

/**
 * priceUsd(model, usage, config) -> number (USD)
 * @param {string} model  - resolved model id (e.g. 'claude-opus-4-8')
 * @param {object} usage  - { input_tokens, output_tokens } | { inputTokens, outputTokens } | { totalTokens }
 * @param {object} [config] - { intelligence: { pricing: { [model]: { input, output } } } }
 * @returns {number} dollar cost; 0 for an unknown model (acceptable — keeps accounting going)
 */
export function priceUsd(model, usage, config = {}) {
  const override = config?.intelligence?.pricing?.[model]
  const rate = override ?? DEFAULT_RATES[model]
  if (!rate) return 0
  const { input, output } = normalizeUsage(usage)
  return (input / 1e6) * rate.input + (output / 1e6) * rate.output
}
