// Token estimates for the report's `est.` column. These are a documented heuristic floor,
// never a substitute for measured usage — the honesty invariant (v3.5.13) means "used" stays
// null until an adapter reports structured token counts. Do not present an estimate as measured.

export const TIER_TOKEN_CURVE = Object.freeze({ simple: 10_000, moderate: 30_000, complex: 75_000, expert: 150_000 })

/**
 * estimateTaskTokens(route, calibration) -> number
 * @param {object} route - { cli, model, effort, tier } (the shape resolveRoute returns)
 * @param {Array<object>} [calibration] - rows from store.getCalibration()
 * @returns {number} estimated tokens: exact (cli,model,effort) calibration mean, else
 *   (cli,model) aggregate mean across efforts, else the static tier curve.
 */
export function estimateTaskTokens(route, calibration = []) {
  const tier = route.tier ?? 'simple'
  const exact = calibration.filter((row) => row.cli === route.cli && row.model === route.model && row.effort === route.effort && row.attempts > 0)
  if (exact.length > 0) {
    const attempts = exact.reduce((sum, row) => sum + row.attempts, 0)
    const totalTokens = exact.reduce((sum, row) => sum + row.total_tokens, 0)
    return Math.round(totalTokens / attempts)
  }
  const byModel = calibration.filter((row) => row.cli === route.cli && row.model === route.model && row.attempts > 0)
  if (byModel.length > 0) {
    const attempts = byModel.reduce((sum, row) => sum + row.attempts, 0)
    const totalTokens = byModel.reduce((sum, row) => sum + row.total_tokens, 0)
    return Math.round(totalTokens / attempts)
  }
  return TIER_TOKEN_CURVE[tier] ?? TIER_TOKEN_CURVE.simple
}
