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

test('a dependency cycle is rejected', () => {
  const r = validatePlan({ tasks: [task({ id: 'a', dependencies: ['b'] }), task({ id: 'b', dependencies: ['a'] })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /cycle/.test(e)))
})
