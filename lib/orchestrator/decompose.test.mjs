import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTask, normalizePlan, decompose } from './decompose.mjs'
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

test('normalizeTask defaults effort to low and coerces invalid effort', () => {
  assert.equal(normalizeTask({ complexity_score: 10 }).effort, 'low')
  assert.equal(normalizeTask({ complexity_score: 10, effort: 'bogus' }).effort, 'low')
  assert.equal(normalizeTask({ complexity_score: 10, effort: 'high' }).effort, 'high')
})

test('a normalized brain plan with bad tier/risk now passes validatePlan (Finding #1)', () => {
  const raw = { tasks: [{ id: 't1', description: 'd', files: ['a.js'], cli: 'codex',
    model_tier: 'haiku', complexity_score: 10, risk: 'low', dependencies: [], prompt: 'p' }] }
  assert.equal(validatePlan(raw).valid, false, 'raw brain output is invalid')
  assert.equal(validatePlan(normalizePlan(raw)).valid, true, 'normalized plan is valid')
})

describe('decompose roster with aliases', () => {
  it('lists configured aliases (with maxTier annotation) in the brain prompt', async () => {
    let seenPrompt = '';
    const brain = { complete: async ({ prompt }) => { seenPrompt = prompt; return { object: { tasks: [] } }; } };
    const cfg = {
      aliases: {
        'pi-qwen-coder': {
          extends: 'pi',
          specialty: 'local coding',
          maxTier: 'moderate',
          models: { simple: { model: 'q', invocation: 'pi --model q "$(cat .ultraswarm-prompt.txt)"' } },
        },
      },
    };
    await decompose(brain, 'do a thing', '/tmp/repo', 'opus', cfg);
    assert.match(seenPrompt, /pi-qwen-coder/);
    assert.match(seenPrompt, /max tier: moderate/);
  });

  it('omits the alias roster entirely when no config is passed (parity)', async () => {
    let seenPrompt = '';
    const brain = { complete: async ({ prompt }) => { seenPrompt = prompt; return { object: { tasks: [] } }; } };
    await decompose(brain, 'do a thing', '/tmp/repo', 'opus');
    assert.doesNotMatch(seenPrompt, /pi-qwen-coder/);
  });
});

describe('decompose roster with metrics (Feature E)', () => {
  it('is byte-identical to today when no metrics are passed (parity)', async () => {
    let withMetrics = '', withoutMetrics = '';
    const brain = { complete: async ({ prompt }) => { withoutMetrics = prompt; return { object: { tasks: [] } }; } };
    await decompose(brain, 'do a thing', '/tmp/repo', 'opus', {});
    const brain2 = { complete: async ({ prompt }) => { withMetrics = prompt; return { object: { tasks: [] } }; } };
    await decompose(brain2, 'do a thing', '/tmp/repo', 'opus', {}, []);
    assert.equal(withMetrics, withoutMetrics);
  });

  it('appends a measured win rate to the roster line for a CLI with recorded runs', async () => {
    let seenPrompt = '';
    const brain = { complete: async ({ prompt }) => { seenPrompt = prompt; return { object: { tasks: [] } }; } };
    const metrics = [
      { worker: 'codex', task_class: 'backend', runs: 10, passes: 9 },
      { worker: 'codex', task_class: 'frontend', runs: 2, passes: 2 },
    ];
    await decompose(brain, 'do a thing', '/tmp/repo', 'opus', {}, metrics);
    assert.match(seenPrompt, /codex \([^)]*track record: 12 runs, 92% pass\)/);
    // A CLI with no recorded runs must be untouched.
    assert.doesNotMatch(seenPrompt, /gemini \([^)]*track record/);
  });
});
