import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceUsd } from './pricing.mjs'

test('opus: 1M input + 1M output = 15 + 75 = 90 USD', () => {
  const cost = priceUsd('claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 1_000_000 })
  assert.equal(cost, 90)
})

test('unknown model prices to 0 (accounting keeps going)', () => {
  assert.equal(priceUsd('gpt-tomorrow', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 0)
})

test('config override replaces the default rate for that model', () => {
  const config = { intelligence: { pricing: { 'claude-haiku-4-5': { input: 2, output: 10 } } } }
  const cost = priceUsd('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, config)
  assert.equal(cost, 12, 'override (2+10) must win over default (1+5)')
})

test('camelCase usage shape is handled', () => {
  const cost = priceUsd('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
  assert.equal(cost, 18)   // 3 + 15
})

test('total-only usage is priced conservatively at the output rate', () => {
  const cost = priceUsd('claude-haiku-4-5', { totalTokens: 1_000_000 })
  assert.equal(cost, 5, 'unknown split → output rate')
})

test('missing/empty usage costs nothing', () => {
  assert.equal(priceUsd('claude-opus-4-8', undefined), 0)
  assert.equal(priceUsd('claude-opus-4-8', {}), 0)
})
