import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateTaskTokens, TIER_TOKEN_CURVE } from './estimate.mjs'

test('estimateTaskTokens prefers exact (cli,model,effort) calibration match', () => {
  const calibration = [
    { cli: 'codex', model: 'gpt-5', effort: 'medium', tier: 'moderate', attempts: 2, total_tokens: 4000 },
    { cli: 'codex', model: 'gpt-5', effort: 'high', tier: 'complex', attempts: 1, total_tokens: 90000 },
  ]
  const route = { cli: 'codex', model: 'gpt-5', effort: 'medium', tier: 'moderate' }
  assert.equal(estimateTaskTokens(route, calibration), 2000)
})

test('estimateTaskTokens falls back to (cli,model) aggregate across efforts when no exact match', () => {
  const calibration = [
    { cli: 'codex', model: 'gpt-5', effort: 'medium', tier: 'moderate', attempts: 2, total_tokens: 4000 },
    { cli: 'codex', model: 'gpt-5', effort: 'high', tier: 'complex', attempts: 1, total_tokens: 8000 },
  ]
  const route = { cli: 'codex', model: 'gpt-5', effort: 'low', tier: 'simple' }
  // aggregate mean = (4000+8000)/(2+1) = 4000
  assert.equal(estimateTaskTokens(route, calibration), 4000)
})

test('estimateTaskTokens falls back to the static tier curve when no calibration matches', () => {
  const route = { cli: 'codex', model: 'gpt-5', effort: 'medium', tier: 'complex' }
  assert.equal(estimateTaskTokens(route, []), TIER_TOKEN_CURVE.complex)
})

test('estimateTaskTokens treats a missing tier as simple', () => {
  const route = { cli: 'codex', model: 'gpt-5', effort: 'medium' }
  assert.equal(estimateTaskTokens(route, []), TIER_TOKEN_CURVE.simple)
})

test('estimateTaskTokens ignores calibration rows with zero attempts', () => {
  const calibration = [{ cli: 'codex', model: 'gpt-5', effort: 'medium', tier: 'moderate', attempts: 0, total_tokens: 0 }]
  const route = { cli: 'codex', model: 'gpt-5', effort: 'medium', tier: 'moderate' }
  assert.equal(estimateTaskTokens(route, calibration), TIER_TOKEN_CURVE.moderate)
})
