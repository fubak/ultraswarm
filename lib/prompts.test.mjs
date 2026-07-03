import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IMPL_SCHEMA, enhancedImplPrompt, expertLensPrompt, EXPERT_LENSES, buildWorkerTaskPrompt, VALID_EFFORTS, DEFAULT_EFFORT, adaptiveReviewPrompt, intelligentJudgePrompt } from './prompts.mjs'

test('effort vocabulary is exported with low as the default', () => {
  assert.deepEqual(VALID_EFFORTS, ['off', 'low', 'medium', 'high', 'xhigh'])
  assert.equal(DEFAULT_EFFORT, 'low')
})

test('IMPL_SCHEMA requires the fields the runner consumes', () => {
  for (const f of ['status', 'gate_results', 'cli_tokens', 'worktree', 'branch']) {
    assert.ok(IMPL_SCHEMA.required.includes(f), `missing ${f}`)
  }
})

test('enhancedImplPrompt embeds the resolved command and worktree path', () => {
  const cfg = { repo: '/r', baseBranch: 'HEAD', worktreeRoot: '/w', repoName: 'r',
    gates: [{ name: 'test', cmd: 'npm test' }] }
  const t = { id: 't1', description: 'd', files: ['a.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const s = enhancedImplPrompt(cfg, t, 'codex', 1, [], 'codex exec -m gpt-5.4-mini ...', 900000)
  assert.match(s, /codex exec -m gpt-5\.4-mini/)
  assert.match(s, /\/w\/r-us-t1-codex/)
})

test('buildWorkerTaskPrompt is the clean inner task only — no wrapper meta-instructions (#7)', () => {
  const s = buildWorkerTaskPrompt({ description: 'add a slugify util', files: ['src/slug.js'], prompt: 'implement slugify(s)' }, [])
  assert.match(s, /add a slugify util/)
  assert.match(s, /src\/slug\.js/)
  assert.match(s, /implement slugify/)
  // must NOT carry the orchestration wrapper that confuses external CLIs
  assert.doesNotMatch(s, /worktree|IMPL schema|housekeeping|git commit|git add|WRAPPER|orchestration|return.*JSON schema/i)
})

test('buildWorkerTaskPrompt folds prior-attempt feedback in', () => {
  const s = buildWorkerTaskPrompt({ description: 'd', files: ['a.js'], prompt: 'p' }, ['tests failed', 'lint error'])
  assert.match(s, /FIX ALL/)
  assert.match(s, /tests failed/)
})

test('EXPERT_LENSES are correctness/security/regression and the security lens prompt sets polarity', () => {
  assert.deepEqual(EXPERT_LENSES, ['correctness', 'security', 'regression'])
  const s = expertLensPrompt('security', { id: 't1', description: 'd', complexity_score: 60 },
    { worktree: '/w/x', branch: 'b', model_used: 'm' }, 'HEAD')
  assert.match(s, /refuted=true ONLY if/)
})

// coverage-lift: lines 64-65 — enhancedImplPrompt with non-empty feedback array
test('enhancedImplPrompt embeds feedback items when feedback is non-empty (branch at line 63-66)', () => {
  const cfg = { repo: '/r', baseBranch: 'HEAD', worktreeRoot: '/w', repoName: 'r',
    gates: [{ name: 'test', cmd: 'npm test' }] }
  const t = { id: 't1', description: 'd', files: ['a.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const s = enhancedImplPrompt(cfg, t, 'codex', 1, ['tests failed', 'lint error'], 'codex exec -m gpt-5.4-mini ...', 900000)
  // With non-empty feedback the "FIX ALL" block must appear inside the prompt file section
  assert.match(s, /FIX ALL of these issues from prior attempts:/)
  assert.match(s, /1\. tests failed/)
  assert.match(s, /2\. lint error/)
})

test('enhancedImplPrompt omits FIX ALL section when feedback is empty (false branch)', () => {
  const cfg = { repo: '/r', baseBranch: 'HEAD', worktreeRoot: '/w', repoName: 'r',
    gates: [{ name: 'test', cmd: 'npm test' }] }
  const t = { id: 't1', description: 'd', files: ['a.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const s = enhancedImplPrompt(cfg, t, 'codex', 1, [], 'codex exec -m gpt-5.4-mini ...', 900000)
  assert.doesNotMatch(s, /FIX ALL/)
})

// coverage-lift: lines 109-113 — adaptiveReviewPrompt with complexity_score > 50 (COMPLEX branch)
const baseImpl = { worktree: '/w/x', branch: 'us/t1-codex', model_used: 'gpt-5.4' }
const baseCfg = { baseBranch: 'main' }

test('adaptiveReviewPrompt: complexity_score <= 20 emits SIMPLE TASK REVIEW, no MODERATE/COMPLEX sections', () => {
  const t = { id: 't1', description: 'small fix', files: ['a.js'], complexity_score: 10 }
  const s = adaptiveReviewPrompt(baseCfg, t, baseImpl)
  assert.match(s, /SIMPLE TASK REVIEW:/)
  assert.doesNotMatch(s, /MODERATE\+ ADDITIONAL CHECKS/)
  assert.doesNotMatch(s, /COMPLEX ADDITIONAL CHECKS/)
})

test('adaptiveReviewPrompt: complexity_score = 21 (> 20) emits MODERATE TASK REVIEW and MODERATE+ section, but no COMPLEX section', () => {
  const t = { id: 't2', description: 'medium task', files: ['b.js'], complexity_score: 21 }
  const s = adaptiveReviewPrompt(baseCfg, t, baseImpl)
  assert.match(s, /MODERATE TASK REVIEW:/)
  assert.match(s, /MODERATE\+ ADDITIONAL CHECKS/)
  assert.doesNotMatch(s, /COMPLEX ADDITIONAL CHECKS/)
})

test('adaptiveReviewPrompt: complexity_score > 50 emits COMPLEX TASK REVIEW, MODERATE+ section, and COMPLEX section (lines 108-114)', () => {
  const t = { id: 't3', description: 'complex task', files: ['c.js'], complexity_score: 75 }
  const s = adaptiveReviewPrompt(baseCfg, t, baseImpl)
  assert.match(s, /COMPLEX TASK REVIEW:/)
  assert.match(s, /MODERATE\+ ADDITIONAL CHECKS/)
  assert.match(s, /COMPLEX ADDITIONAL CHECKS/)
  // Specific content from the COMPLEX branch (lines 110-113)
  assert.match(s, /Architectural impact assessment/)
  assert.match(s, /Scalability considerations/)
})

test('adaptiveReviewPrompt: complexity_score = 51 is sufficient to enter COMPLEX branch', () => {
  const t = { id: 't4', description: 'edge complexity', files: ['d.js'], complexity_score: 51 }
  const s = adaptiveReviewPrompt(baseCfg, t, baseImpl)
  assert.match(s, /COMPLEX ADDITIONAL CHECKS/)
})

test('adaptiveReviewPrompt: complexity_score = 50 does NOT enter COMPLEX branch (boundary)', () => {
  const t = { id: 't5', description: 'boundary', files: ['e.js'], complexity_score: 50 }
  const s = adaptiveReviewPrompt(baseCfg, t, baseImpl)
  assert.doesNotMatch(s, /COMPLEX ADDITIONAL CHECKS/)
  // But moderate section IS present (50 > 20)
  assert.match(s, /MODERATE\+ ADDITIONAL CHECKS/)
})

// coverage-lift: intelligentJudgePrompt (lines 119-136) — untested function
test('intelligentJudgePrompt embeds task id, complexity target, and model tier', () => {
  const cfg = { baseBranch: 'main' }
  const t = { id: 'task-42', description: 'refactor auth', files: ['src/auth.js'], complexity_score: 65, model_tier: 'complex' }
  const impl = { worktree: '/w/repo-us-task-42-codex', branch: 'ultraswarm/task-42-codex', model_used: 'gpt-5.5' }
  const s = intelligentJudgePrompt(cfg, t, impl)
  assert.match(s, /task-42/)
  assert.match(s, /65\/100/)
  assert.match(s, /complex/)
  assert.match(s, /graft_ideas/)
  assert.match(s, /Correctness/)
})

// coverage-lift: expertLensPrompt correctness lens (lines 144-148)
test('expertLensPrompt: correctness lens includes CORRECTNESS LENS section, not security/regression', () => {
  const t = { id: 't1', description: 'd', complexity_score: 40 }
  const impl = { worktree: '/w/x', branch: 'b', model_used: 'm' }
  const s = expertLensPrompt('correctness', t, impl, 'main')
  assert.match(s, /CORRECTNESS LENS/)
  assert.doesNotMatch(s, /SECURITY LENS/)
  assert.doesNotMatch(s, /REGRESSION LENS/)
  assert.match(s, /edge case/)
})

// coverage-lift: expertLensPrompt regression lens (lines 156-160)
test('expertLensPrompt: regression lens includes REGRESSION LENS section, not correctness/security', () => {
  const t = { id: 't1', description: 'd', complexity_score: 40 }
  const impl = { worktree: '/w/x', branch: 'b', model_used: 'm' }
  const s = expertLensPrompt('regression', t, impl, 'main')
  assert.match(s, /REGRESSION LENS/)
  assert.doesNotMatch(s, /CORRECTNESS LENS/)
  assert.doesNotMatch(s, /SECURITY LENS/)
  assert.match(s, /backward compatibility/)
})

// v3.6: worker prompts are hard-capped with a LOUD truncation marker (no silent caps).
test('capWorkerPrompt: under the cap passes through; over the cap truncates with an explicit marker', async () => {
  const { capWorkerPrompt } = await import('./prompts.mjs')
  const small = capWorkerPrompt('hello', 100)
  assert.equal(small.text, 'hello'); assert.equal(small.truncated, 0)
  const big = capWorkerPrompt('x'.repeat(150), 100)
  assert.equal(big.truncated, 50)
  // WHY: the marker makes the cut visible to the worker AND the reviewer — a silently clipped
  // prompt would read as full task coverage (Rule 12).
  assert.match(big.text, /\[ultraswarm: prompt truncated — 50 chars dropped\]/)
  assert.equal(big.text.startsWith('x'.repeat(100)), true)
})

// v3.6: retry feedback is bounded — last 10 items, 500 chars each — so retries stay cheap.
test('buildWorkerTaskPrompt bounds feedback to the newest 10 items at 500 chars each', () => {
  const t = { description: 'd', files: ['a.js'], prompt: 'p' }
  const feedback = Array.from({ length: 15 }, (_, i) => `issue-${i}-${'y'.repeat(600)}`)
  const s = buildWorkerTaskPrompt(t, feedback)
  // WHY: oldest items are stale (already addressed or superseded); the newest feedback is what the
  // retry must fix. Unbounded feedback ballooned prompts across attempts.
  assert.doesNotMatch(s, /issue-4-/)
  assert.match(s, /issue-5-/); assert.match(s, /issue-14-/)
  for (const line of s.split('\n')) assert.ok(line.length <= 520, `feedback line too long: ${line.length}`)
})
