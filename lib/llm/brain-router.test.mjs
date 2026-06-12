import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBrainModel } from './brain-router.mjs'

test('default tiers map to current Anthropic ids', () => {
  assert.deepEqual(resolveBrainModel('haiku'), { provider: 'anthropic', model: 'claude-haiku-4-5' })
  assert.deepEqual(resolveBrainModel('opus'),  { provider: 'anthropic', model: 'claude-opus-4-8' })
  assert.deepEqual(resolveBrainModel('fable'), { provider: 'anthropic', model: 'claude-fable-5' })
})

test('config can override a tier model', () => {
  const cfg = { intelligence: { modelRouting: { models: { sonnet: 'claude-sonnet-4-6' } } } }
  assert.equal(resolveBrainModel('sonnet', cfg).model, 'claude-sonnet-4-6')
})

test('unknown tier throws', () => {
  assert.throws(() => resolveBrainModel('mega'), /Unknown brain tier/)
})
