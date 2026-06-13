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
