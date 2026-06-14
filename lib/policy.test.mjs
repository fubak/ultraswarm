import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePolicy, validatePolicy, enforceTaskPolicy, requireApproval, matchesForbidden, forbiddenViolations } from './policy.mjs'

test('policy merges defaults and rejects unenforceable network denial', () => {
  const policy = resolvePolicy({ policy: { maxParallelWorkers: 2, network: 'deny' } })
  assert.equal(policy.maxParallelWorkers, 2)
  assert.match(validatePolicy(policy).errors.join(' '), /container isolation/)
})

test('policy blocks forbidden paths and requires competition', () => {
  const violations = enforceTaskPolicy({ files: ['.env', 'infra/prod/app.tf'], risk: 'high', competition: false }, resolvePolicy())
  assert.equal(violations.length, 3)
})

test('forbiddenViolations flags actual changed files, exact pattern matters (B1)', () => {
  // WHY: B1 enforces forbiddenPaths against what the worker actually wrote, not declared task.files.
  // A clean file must produce no violation, while a forbidden one must — proving the matcher, not a constant.
  const policy = resolvePolicy()
  assert.equal(matchesForbidden('.env', policy), '.env')
  assert.equal(matchesForbidden('infra/prod/app.tf', policy), 'infra/prod/**')
  assert.equal(matchesForbidden('src/index.js', policy), null)
  const v = forbiddenViolations(['src/index.js', '.env', 'infra/prod/db.tf'], policy)
  assert.equal(v.length, 2)
  assert.match(v.join(' '), /\.env matches forbidden path \.env/)
  assert.deepEqual(forbiddenViolations(['ok.js'], policy), [])
})

test('requireApproval raises a typed error', () => {
  assert.throws(() => requireApproval({ isApproved: () => false }, 'r', 'plan', resolvePolicy()), (error) => error.code === 'APPROVAL_REQUIRED')
})

// --- branch-coverage additions ---

test('resolvePolicy with no argument uses all defaults', () => {
  // Exercises config.policy ?? {} when config is undefined (default param)
  const p = resolvePolicy()
  assert.equal(p.isolation, 'native')
  assert.equal(p.network, 'allow')
  assert.equal(p.maxCostUsd, null)
  assert.equal(p.approvals.beforeExecution, true)
})

test('resolvePolicy with empty object uses all defaults', () => {
  // Exercises config.policy ?? {} when policy key is absent
  const p = resolvePolicy({})
  assert.equal(p.minimumHealthyWorkers, 2)
  assert.deepEqual(p.approvals, { beforeExecution: true, beforeMerge: true })
})

test('validatePolicy accepts a fully valid container+deny policy', () => {
  // Exercises isolation=container WITH image, network=deny WITH container — no errors expected
  const p = resolvePolicy({ policy: { isolation: 'container', containerImage: 'ubuntu:22.04', network: 'deny' } })
  const r = validatePolicy(p)
  assert.equal(r.valid, true)
  assert.deepEqual(r.errors, [])
})

test('validatePolicy rejects container isolation without containerImage', () => {
  // isolation=container but no containerImage — exercises the containerImage branch
  const p = resolvePolicy({ policy: { isolation: 'container', containerImage: null } })
  const r = validatePolicy(p)
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /containerImage/.test(e)))
})

test('validatePolicy rejects minimumHealthyWorkers < 1', () => {
  // Exercises the < 1 branch (integer but not positive)
  const p = resolvePolicy({ policy: { minimumHealthyWorkers: 0 } })
  const r = validatePolicy(p)
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /minimumHealthyWorkers/.test(e)))
})

test('validatePolicy rejects non-integer minimumHealthyWorkers', () => {
  // Exercises the !Number.isInteger branch
  const p = resolvePolicy({ policy: { minimumHealthyWorkers: 1.5 } })
  const r = validatePolicy(p)
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /minimumHealthyWorkers/.test(e)))
})

test('validatePolicy rejects maxParallelWorkers < 1', () => {
  const p = resolvePolicy({ policy: { maxParallelWorkers: 0 } })
  const r = validatePolicy(p)
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /maxParallelWorkers/.test(e)))
})

test('validatePolicy rejects invalid isolation value', () => {
  const p = { ...resolvePolicy(), isolation: 'sandbox' }
  const r = validatePolicy(p)
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /isolation/.test(e)))
})

test('validatePolicy rejects invalid network value', () => {
  const p = { ...resolvePolicy(), network: 'blocked' }
  const r = validatePolicy(p)
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /network must be/.test(e)))
})

test('validatePolicy rejects maxCostUsd of zero (not positive)', () => {
  // Exercises the maxCostUsd !== null branch with an invalid non-positive value
  const p = resolvePolicy({ policy: { maxCostUsd: 0 } })
  const r = validatePolicy(p)
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /maxCostUsd/.test(e)))
})

test('validatePolicy accepts positive maxCostUsd', () => {
  // Exercises the maxCostUsd !== null branch with a valid value
  const p = resolvePolicy({ policy: { maxCostUsd: 5.0 } })
  const r = validatePolicy(p)
  assert.equal(r.valid, true)
})

test('enforceTaskPolicy with no files produces no file violations', () => {
  // Exercises task.files ?? [] when files is absent
  const v = enforceTaskPolicy({ risk: 'low', competition: true }, resolvePolicy())
  assert.deepEqual(v, [])
})

test('enforceTaskPolicy allows high-risk task when competition is enabled', () => {
  // Exercises the requireCompetitionForRisk branch where competition !== false
  const v = enforceTaskPolicy({ files: [], risk: 'high', competition: true }, resolvePolicy())
  assert.deepEqual(v, [])
})

test('enforceTaskPolicy with risk not in requireCompetitionForRisk ignores competition flag', () => {
  // Exercises includes() returning false — low risk with competition=false is not a violation
  const v = enforceTaskPolicy({ files: [], risk: 'low', competition: false }, resolvePolicy())
  assert.deepEqual(v, [])
})

test('requireApproval does not throw when approval is not required', () => {
  // Exercises the required=false branch (beforeMerge: false)
  const policy = resolvePolicy({ policy: { approvals: { beforeMerge: false } } })
  assert.doesNotThrow(() => requireApproval({ isApproved: () => false }, 'r', 'merge', policy))
})

test('requireApproval uses beforeMerge for merge gate and passes when already approved', () => {
  // Exercises gate !== 'plan' ternary branch and the !store.isApproved() === false path
  const policy = resolvePolicy()
  assert.doesNotThrow(() => requireApproval({ isApproved: () => true }, 'r', 'merge', policy))
})

test('matchesForbidden with empty forbiddenPaths returns null', () => {
  // Exercises the policy.forbiddenPaths ?? [] empty case — loop body never runs
  assert.equal(matchesForbidden('.env', {}), null)
  assert.equal(matchesForbidden('.env', { forbiddenPaths: [] }), null)
})

test('forbiddenViolations with no forbidden paths returns empty array', () => {
  // Exercises files loop where matchesForbidden always returns null
  const v = forbiddenViolations(['.env', 'secret.key'], {})
  assert.deepEqual(v, [])
})
