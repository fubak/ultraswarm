import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mockBrainBehavior } from './mock-brain.mjs'
import { MockLlmClient } from './mock-client.mjs'
import { ENHANCED_REVIEW_SCHEMA, ADAPTIVE_JUDGE_SCHEMA, EXPERT_VERDICT_SCHEMA } from '../prompts.mjs'
import { PLAN_SCHEMA } from '../plan-schema.mjs'

describe('mockBrainBehavior', () => {
  it('returns an approving review for the review schema', () => {
    const { object, usage } = mockBrainBehavior('review:t1', { schema: ENHANCED_REVIEW_SCHEMA })
    assert.equal(object.approve, true)
    assert.equal(object.requires_expert_review, false)
    assert.equal(typeof object.quality_score, 'number')
    assert.equal(typeof usage.totalTokens, 'number')
  })

  it('returns a high judge score for the judge schema', () => {
    const { object } = mockBrainBehavior('judge:t1', { schema: ADAPTIVE_JUDGE_SCHEMA })
    assert.ok(object.score >= 7)
    assert.deepEqual(object.graft_ideas, [])
  })

  it('returns a non-refuted verdict for the expert schema', () => {
    const { object } = mockBrainBehavior('lens:correctness', { schema: EXPERT_VERDICT_SCHEMA })
    assert.equal(object.refuted, false)
    assert.equal(object.severity, 'low')
  })

  it('returns an empty task list for the decompose schema', () => {
    const { object } = mockBrainBehavior('decompose', { schema: PLAN_SCHEMA })
    assert.deepEqual(object.tasks, [])
  })

  it('returns an empty object when no known schema is given', () => {
    const { object } = mockBrainBehavior('x', {})
    assert.deepEqual(object, {})
  })

  it('works as a MockLlmClient behavior (records calls, returns { object, usage })', async () => {
    const client = new MockLlmClient(mockBrainBehavior)
    const r = await client.complete({ label: 'review:t1', model: 'mock', schema: ENHANCED_REVIEW_SCHEMA, prompt: 'p' })
    assert.equal(r.object.approve, true)
    assert.equal(client.calls.length, 1)
    assert.equal(client.calls[0].label, 'review:t1')
  })
})
