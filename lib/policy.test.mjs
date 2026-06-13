import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePolicy, validatePolicy, enforceTaskPolicy, requireApproval } from './policy.mjs'

test('policy merges defaults and rejects unenforceable network denial', () => {
  const policy = resolvePolicy({ policy: { maxParallelWorkers: 2, network: 'deny' } })
  assert.equal(policy.maxParallelWorkers, 2)
  assert.match(validatePolicy(policy).errors.join(' '), /container isolation/)
})

test('policy blocks forbidden paths and requires competition', () => {
  const violations = enforceTaskPolicy({ files: ['.env', 'infra/prod/app.tf'], risk: 'high', competition: false }, resolvePolicy())
  assert.equal(violations.length, 3)
})

test('requireApproval raises a typed error', () => {
  assert.throws(() => requireApproval({ isApproved: () => false }, 'r', 'plan', resolvePolicy()), (error) => error.code === 'APPROVAL_REQUIRED')
})
