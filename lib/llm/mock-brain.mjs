// Deterministic brain behavior for the `ULTRASWARM_BRAIN=mock` test mode (see bin/cli.mjs).
// Returns schema-appropriate, approving canned responses so the full run/QA/merge pipeline can
// be exercised end-to-end without a live LLM. Keyed on the discriminating property of each QA
// schema (review/judge/expert/decompose). Shape matches LlmClient.complete: { object, usage }.
export function mockBrainBehavior(label, opts = {}) {
  const props = opts?.schema?.properties ?? {}
  const usage = { totalTokens: 10, costUsd: 0 }
  if ('approve' in props) {
    return { object: { approve: true, issues: [], quality_score: 95, complexity_assessment: 10, recommendations: [], requires_expert_review: false }, usage }
  }
  if ('score' in props) {
    return { object: { score: 9, rationale: 'mock-approved', graft_ideas: [], complexity_handling: 9, model_efficiency: 9, code_quality: 9 }, usage }
  }
  if ('refuted' in props) {
    // Test hook: a QA_REJECT sentinel in the embedded task lets e2e tests deterministically drive the
    // adversarial-QA-rejection (and the O3 retry-with-feedback) path through the real runner.
    if (typeof opts.prompt === 'string' && opts.prompt.includes('QA_REJECT')) {
      return { object: { refuted: true, reasons: ['mock forced QA rejection (QA_REJECT sentinel)'], confidence: 5, severity: 'critical' }, usage }
    }
    return { object: { refuted: false, reasons: ['mock-verified'], confidence: 95, severity: 'low' }, usage }
  }
  if ('tasks' in props) {
    return { object: { tasks: [] }, usage }
  }
  return { object: {}, usage }
}
