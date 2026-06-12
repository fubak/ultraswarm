import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTask, normalizePlan } from './decompose.mjs'
import { validatePlan } from '../plan-schema.mjs'

test('normalizeTask coerces a Claude model name in model_tier to a valid tier by complexity', () => {
  assert.equal(normalizeTask({ model_tier: 'haiku', complexity_score: 10 }).model_tier, 'simple')
  assert.equal(normalizeTask({ model_tier: 'sonnet', complexity_score: 40 }).model_tier, 'moderate')
  assert.equal(normalizeTask({ model_tier: 'opus', complexity_score: 75 }).model_tier, 'complex')
  assert.equal(normalizeTask({ model_tier: 'fable', complexity_score: 130 }).model_tier, 'expert')
})

test('normalizeTask coerces non-standard risk to routine, preserves high', () => {
  assert.equal(normalizeTask({ model_tier: 'simple', complexity_score: 10, risk: 'low' }).risk, 'routine')
  assert.equal(normalizeTask({ model_tier: 'simple', complexity_score: 10, risk: 'medium' }).risk, 'routine')
  assert.equal(normalizeTask({ model_tier: 'simple', complexity_score: 10, risk: 'high' }).risk, 'high')
})

test('normalizeTask leaves an already-valid tier untouched', () => {
  assert.equal(normalizeTask({ model_tier: 'moderate', complexity_score: 40, risk: 'routine' }).model_tier, 'moderate')
})

test('a normalized brain plan with bad tier/risk now passes validatePlan (Finding #1)', () => {
  const raw = { tasks: [{ id: 't1', description: 'd', files: ['a.js'], cli: 'codex',
    model_tier: 'haiku', complexity_score: 10, risk: 'low', dependencies: [], prompt: 'p' }] }
  assert.equal(validatePlan(raw).valid, false, 'raw brain output is invalid')
  assert.equal(validatePlan(normalizePlan(raw)).valid, true, 'normalized plan is valid')
})
