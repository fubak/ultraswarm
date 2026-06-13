export const DEFAULT_POLICY = Object.freeze({
  minimumHealthyWorkers: 2,
  maxParallelWorkers: 4,
  requireCompetitionForRisk: ['high'],
  approvals: { beforeExecution: true, beforeMerge: true },
  forbiddenPaths: ['.env', '.env.*', 'infra/prod/**'],
  maxCostUsd: null,
  isolation: 'native',
  containerImage: null,
  network: 'allow',
})

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`)

export function resolvePolicy(config = {}) {
  const p = config.policy ?? {}
  return { ...DEFAULT_POLICY, ...p, approvals: { ...DEFAULT_POLICY.approvals, ...(p.approvals ?? {}) } }
}

export function validatePolicy(policy) {
  const errors = []
  if (!Number.isInteger(policy.minimumHealthyWorkers) || policy.minimumHealthyWorkers < 1) errors.push('minimumHealthyWorkers must be a positive integer')
  if (!Number.isInteger(policy.maxParallelWorkers) || policy.maxParallelWorkers < 1) errors.push('maxParallelWorkers must be a positive integer')
  if (!['native', 'container'].includes(policy.isolation)) errors.push('isolation must be native or container')
  if (policy.isolation === 'container' && (!policy.containerImage || typeof policy.containerImage !== 'string')) errors.push('container isolation requires containerImage')
  if (!['allow', 'deny'].includes(policy.network)) errors.push('network must be allow or deny')
  if (policy.network === 'deny' && policy.isolation !== 'container') errors.push('network deny requires container isolation')
  if (policy.maxCostUsd !== null && (!(policy.maxCostUsd > 0) || !Number.isFinite(policy.maxCostUsd))) errors.push('maxCostUsd must be null or a positive number')
  return { valid: errors.length === 0, errors }
}

export function enforceTaskPolicy(task, policy) {
  const violations = []
  const forbidden = (policy.forbiddenPaths ?? []).map((p) => [p, globToRegExp(p)])
  for (const file of task.files ?? []) for (const [pattern, re] of forbidden) if (re.test(file)) violations.push(`file ${file} matches forbidden path ${pattern}`)
  if ((policy.requireCompetitionForRisk ?? []).includes(task.risk) && task.competition === false) violations.push(`risk ${task.risk} requires competition`)
  return violations
}

// Match a single path against policy.forbiddenPaths (glob patterns). Returns the matching
// pattern string, or null if none match. Used to enforce forbiddenPaths against ACTUAL worker
// changes (B1), not just declared task.files.
export function matchesForbidden(file, policy = {}) {
  for (const pattern of policy.forbiddenPaths ?? []) if (globToRegExp(pattern).test(file)) return pattern
  return null
}

// Given a list of changed files, return one violation message per file that matches a
// forbidden path. Empty array means no violations.
export function forbiddenViolations(files = [], policy = {}) {
  const violations = []
  for (const file of files) {
    const pattern = matchesForbidden(file, policy)
    if (pattern) violations.push(`file ${file} matches forbidden path ${pattern}`)
  }
  return violations
}

export function requireApproval(store, runId, gate, policy) {
  const required = gate === 'plan' ? policy.approvals.beforeExecution : policy.approvals.beforeMerge
  if (required && !store.isApproved(runId, gate)) {
    const error = new Error(`${gate} approval required for run ${runId}`)
    error.code = 'APPROVAL_REQUIRED'
    throw error
  }
}
