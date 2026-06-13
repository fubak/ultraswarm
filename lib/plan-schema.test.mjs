import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan } from './plan-schema.mjs'

const task = (over = {}) => ({ id: 't1', description: 'd', files: ['a.js'], cli: 'codex',
  model_tier: 'simple', complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go', ...over })

test('valid plan passes', () => {
  const r = validatePlan({ tasks: [task()] })
  assert.equal(r.valid, true)
  assert.deepEqual(r.errors, [])
})

test('unknown cli is rejected', () => {
  const r = validatePlan({ tasks: [task({ cli: 'rm -rf' })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /cli/.test(e)))
})

test('invalid model_tier is rejected', () => {
  assert.equal(validatePlan({ tasks: [task({ model_tier: 'mega' })] }).valid, false)
})

test('effort is optional but must be in the vocabulary when present', () => {
  const base = { id: 't1', description: 'd', files: ['a.js'], complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'p' }
  assert.equal(validatePlan({ tasks: [{ ...base, effort: 'high' }] }).valid, true)
  assert.equal(validatePlan({ tasks: [{ ...base }] }).valid, true)            // omitted is fine
  const bad = validatePlan({ tasks: [{ ...base, effort: 'turbo' }] })
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.includes('invalid effort "turbo"')))
})

test('a dependency cycle is rejected', () => {
  const r = validatePlan({ tasks: [task({ id: 'a', dependencies: ['b'] }), task({ id: 'b', dependencies: ['a'] })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /cycle/.test(e)))
})

test('a task id with shell metacharacters is rejected', () => {
  const r = validatePlan({ tasks: [task({ id: 't1; rm -rf ~' })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /id must match/.test(e)))
})
