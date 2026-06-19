// Parity harness for lib/orchestrator/core.mjs
// Mirrors the high-risk and escalation/retries/exhaustion assertions from
// scripts/workflow-harness.test.mjs, but drives createOrchestrator directly
// with mock agent/parallel/log and a stubbed runImplementation.
//
// Run: node --test lib/orchestrator/core.harness.test.mjs

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createOrchestrator, nextRung, nextEffort } from './core.mjs'

// ── fixtures (equivalent to workflow-harness ones) ────────────────────────────
const okImpl = (model = 'mock-model') => ({
  status: 'ok', worktree: '/w/x', branch: 'b', files_changed: ['a.js'],
  gate_results: [{ name: 'test', pass: true }], summary: 'done', concerns: [],
  cli_tokens: 1000, model_used: model, complexity_achieved: 10,
})
const failImpl = () => ({
  status: 'gates_failed', worktree: '/w/x', branch: 'b', files_changed: [],
  gate_results: [{ name: 'test', pass: false, detail: 'fail' }], summary: 'broke',
  concerns: [], cli_tokens: 500, model_used: 'mock-model', complexity_achieved: 0,
})
const approveReview = { approve: true, issues: [], quality_score: 90, complexity_assessment: 10 }
const rejectReview  = { approve: false, issues: ['bad'], quality_score: 10, complexity_assessment: 0 }
const passVerdict = (conf = 90) => ({ refuted: false, reasons: [], confidence: conf, severity: 'low' })
const judgeScore = (score = 8) => ({
  score, rationale: 'r', graft_ideas: [], complexity_handling: 8, model_efficiency: 8, code_quality: 8,
})

// ── mock harness ──────────────────────────────────────────────────────────────
/**
 * Run a task through createOrchestrator with fully mocked primitives.
 *
 * @param {object} task        - Task object
 * @param {object} cfgExtra    - Extra cfg fields merged on top of defaults
 * @param {Function} agentFn   - (label, prompt, opts) => response object|null
 * @param {Function} implFn    - (cfg, t, cli, attempt, feedback) => impl object
 * @returns {{ result, calls, logs }}
 */
async function runTask(task, cfgExtra, agentFn, implFn) {
  const calls = []
  const logs  = []

  const cfg = {
    repo: '/r', repoName: 'r', baseBranch: 'main', worktreeRoot: '/w',
    gates: [{ name: 'test', cmd: 'npm test' }],
    registry: {
      codex: {
        simple:   'c -m tier-simple "$(cat .ultraswarm-prompt.txt)"',
        moderate: 'c -m tier-moderate "$(cat .ultraswarm-prompt.txt)"',
        complex:  'c -m tier-complex "$(cat .ultraswarm-prompt.txt)"',
        expert:   'c -m tier-expert "$(cat .ultraswarm-prompt.txt)"',
      },
      grok: { simple: 'g -m s', moderate: 'g -m m', complex: 'g -m c', expert: 'g -m e' },
      opencode: 'opencode run legacy-string "$(cat .ultraswarm-prompt.txt)"',
    },
    alternates: { codex: 'grok', grok: 'codex', opencode: 'grok' },
    timeoutMs: 1000,
    timeouts: {},
    ...cfgExtra,
  }

  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, model: opts.model, schema: opts.schema, prompt })
    return agentFn(label, prompt, opts)
  }

  const parallel = async (thunks) => Promise.all(thunks.map(t => t().catch(() => null)))

  const mockImpl = (c, ta, cli, attempt, feedback) => {
    // track impl calls via the agent calls array for label inspection
    calls.push({ label: `impl:${ta.id}:${cli}:${ta.model_tier}@${ta.effort}#${attempt}`, model: 'haiku', isImpl: true })
    return Promise.resolve(implFn(c, ta, cli, attempt, feedback))
  }

  const { runIntelligentTask } = createOrchestrator({
    agent, parallel, log: (m) => logs.push(m), cfg,
    runImplementation: mockImpl,
  })

  const result = await runIntelligentTask(task)
  return { result, calls, logs }
}

const makeTask = (over = {}) => ({
  id: 't', description: 'd', files: ['a.js'], cli: 'codex', model_tier: 'simple',
  complexity_score: 10, risk: 'routine', dependencies: [], acceptance: 'x',
  prompt: 'p', estimated_tokens: 1000, ...over,
})

// Helper: extract the model tier from an impl call label
// impl label: impl:<id>:<cli>:<tier>@<effort>#<n>
const implTier = (label) => label.split(':')[3].split('@')[0]


// ── high-risk path: competition, judges, adversarial lenses ──────────────────
describe('high-risk path: competition, judges, adversarial lenses', () => {
  const highTask = makeTask({ id: 'h', model_tier: 'complex', complexity_score: 60, risk: 'high' })

  const happyAgent = (l) => {
    if (l.startsWith('judge:'))  return judgeScore()
    if (l.startsWith('verify:')) return passVerdict()
    return approveReview
  }
  const happyImpl = () => okImpl()

  test('risk:high → two CLIs compete, sonnet judges, security-opus + sonnet cascade lenses', async () => {
    const { result, calls } = await runTask(highTask, {}, happyAgent, happyImpl)

    const impls = calls.filter(c => c.isImpl)
    assert.equal(impls.length, 2, 'two impl calls for two competitors')
    assert.equal(new Set(impls.map(c => c.label.split(':')[2])).size, 2, 'two distinct CLIs')

    const judges = calls.filter(c => c.label.startsWith('judge:'))
    assert.equal(judges.length, 2)
    assert.ok(judges.every(j => j.model === 'sonnet'), 'judges always on sonnet')

    const lenses = calls.filter(c => c.label.startsWith('verify:'))
    // No escalation since all lenses return passVerdict(90) — confident passes don't escalate
    assert.equal(lenses.length, 3, 'confident passes do not escalate — exactly one call per lens')

    const lensModel = (lens) => lenses.find(l => l.label === `verify:h:${lens}`).model
    assert.equal(lensModel('security'), 'opus', 'security is the asymmetric-risk lens — always the opus ceiling')
    assert.equal(lensModel('correctness'), 'sonnet', 'correctness starts on sonnet, escalates only on doubt')
    assert.equal(lensModel('regression'), 'sonnet', 'regression starts on sonnet, escalates only on doubt')

    assert.ok(!result.failed, 'task approved')
    assert.equal(result.task, 'h')
    assert.ok(result.impl, 'result carries impl')
    assert.ok(result.cli, 'result carries cli')
  })

  test('cascade: a borderline sonnet lens escalates to a second opus verdict', async () => {
    const agentFn = (l) => {
      if (l.startsWith('judge:'))   return judgeScore()
      if (l.startsWith('verify:')) {
        // correctness comes back borderline (conf 50) on its sonnet first pass → must re-run on opus
        if (l === 'verify:h:correctness') return passVerdict(50)
        return passVerdict(90)
      }
      return approveReview
    }

    const { result, calls } = await runTask(highTask, {}, agentFn, happyImpl)

    const firstPass = calls.find(c => c.label === 'verify:h:correctness')
    assert.equal(firstPass.model, 'sonnet', 'correctness first pass runs on sonnet')

    const escalated = calls.filter(c => c.label === 'verify:h:correctness:opus')
    assert.equal(escalated.length, 1, 'borderline correctness lens re-runs once on opus')
    assert.equal(escalated[0].model, 'opus')

    assert.ok(!result.failed, 'the escalated opus verdict (conf 90) clears quorum and score')
  })

  test('quorum: a single surviving lens vote must NOT approve', async () => {
    let lensN = 0
    const agentFn = (l) => {
      if (l.startsWith('judge:'))  return judgeScore()
      if (l.startsWith('verify:')) { lensN++; return lensN % 3 === 1 ? passVerdict(95) : null }
      return rejectReview
    }

    const { result } = await runTask(highTask, {}, agentFn, happyImpl)
    assert.ok(result.failed, 'one 95-confidence vote of three must not pass quorum')
  })

  test('critical override: persistent critical refutation fails despite two confident passes', async () => {
    const agentFn = (l) => {
      if (l.startsWith('judge:'))  return judgeScore()
      if (l.startsWith('verify:')) {
        return l.includes(':security')
          ? { refuted: true, reasons: ['hardcoded secret'], confidence: 99, severity: 'critical' }
          : passVerdict(92)
      }
      return rejectReview
    }

    const { result } = await runTask(highTask, {}, agentFn, happyImpl)
    assert.ok(result.failed, 'critical security refutation must fail despite other confident passes')
    // Task tombstones after exhausting retries; the failed result carries the task id
    assert.equal(result.task, 'h')
  })

  test('all lens agents dying must not approve (and must not silently drop the task)', async () => {
    const agentFn = (l) => {
      if (l.startsWith('judge:'))  return judgeScore(5)
      if (l.startsWith('verify:')) return null
      return rejectReview
    }

    const { result } = await runTask(highTask, {}, agentFn, happyImpl)
    assert.ok(result.failed, 'all lens agents dead must not approve')
    assert.equal(result.task, 'h', 'task not silently dropped — tombstone carries id')
  })

  test('quorum: high-risk with NO usable alternate tombstones — never approves a solo impl', async () => {
    // codex has no alternate → only one usable competitor. A high-risk task must NOT be approved
    // solo: no judge, no second impl, no adversarial competition. It must tombstone instead.
    let judged = false, approved = false
    const agentFn = (l) => {
      if (l.startsWith('judge:'))  { judged = true; return judgeScore() }
      if (l.startsWith('verify:')) return passVerdict()
      approved = true                 // any review/approve path being hit is a failure here
      return approveReview
    }
    const happyImpl = () => okImpl()
    const { result, calls } = await runTask(highTask, { alternates: {} }, agentFn, happyImpl)

    assert.ok(result.failed, 'a solo high-risk task must tombstone, not be approved')
    assert.equal(result.task, 'h')
    assert.ok(/competition required/.test(result.error || ''), 'reason names the missing competition')
    assert.equal(judged, false, 'no judge runs for a solo high-risk task')
    assert.equal(approved, false, 'no approve path runs for a solo high-risk task')
    assert.equal(calls.filter(c => c.isImpl).length, 0, 'no worker is even dispatched solo')
  })
})


// ── escalation, retries, exhaustion ──────────────────────────────────────────
describe('escalation, retries, exhaustion', () => {
  test('nextRung climbs effort within a tier, then steps tier and resets effort to low', () => {
    assert.deepEqual(nextRung('moderate', 'low'), { tier: 'moderate', effort: 'medium' })
    assert.deepEqual(nextRung('moderate', 'medium'), { tier: 'moderate', effort: 'high' })
    assert.deepEqual(nextRung('moderate', 'high'), { tier: 'complex', effort: 'low' })
    assert.deepEqual(nextRung('expert', 'high'), { tier: 'expert', effort: 'high' })   // maxed
    assert.deepEqual(nextRung('complex', 'off'), { tier: 'expert', effort: 'low' })    // off → step tier
  })

  test('nextEffort climbs effort only, capped at high', () => {
    assert.equal(nextEffort('low'), 'medium')
    assert.equal(nextEffort('medium'), 'high')
    assert.equal(nextEffort('high'), 'high')   // capped — no tier escalation
    assert.equal(nextEffort('off'), 'low')     // climbs into the ladder
    assert.equal(nextEffort('xhigh'), 'xhigh') // already above the ladder
  })

  test('failed attempts climb effort within the tier (low→medium→high) before stepping tier', async () => {
    let implN = 0
    const implFn = () => { implN++; return implN < 3 ? failImpl() : okImpl() }
    const agentFn = () => approveReview

    const { result, calls, logs } = await runTask(makeTask(), {}, agentFn, implFn)

    // Effort-first: a simple@low task climbs effort within the simple tier — tier stays simple.
    const tiers = calls.filter(c => c.isImpl).map(c => implTier(c.label))
    assert.deepEqual(tiers, ['simple', 'simple', 'simple'])
    assert.ok(logs.some(l => l.includes('escalating to simple@medium')))
    assert.ok(logs.some(l => l.includes('escalating to simple@high')))
    assert.ok(!result.failed, 'task approved on third attempt')
  })

  test('primary exhausts → alternate CLI at the carried (escalated) tier → tombstone', async () => {
    const implFn = () => failImpl()
    const agentFn = () => rejectReview

    const { result, calls } = await runTask(makeTask({ id: 'x' }), {}, agentFn, implFn)

    const implLabels = calls.filter(c => c.isImpl).map(c => c.label)
    const clis = new Set(implLabels.map(l => l.split(':')[2]))
    assert.ok(clis.has('codex') && clis.has('grok'), 'reassigned to the alternate CLI')

    const grokFirst = implLabels.find(l => l.includes(':grok:'))
    assert.match(grokFirst, /:simple@high#4/, 'alternate starts at the carried escalated tier@effort (effort climbed first), not base')

    assert.ok(result.failed, 'task tombstones after exhaustion')
    assert.equal(result.task, 'x')
  })

  test('expert escalation: requires_expert_review routes a second pass to opus', async () => {
    const implFn = () => okImpl()
    const agentFn = (l) => {
      if (l.includes(':moderate')) return { ...approveReview, quality_score: 70, requires_expert_review: true }
      if (l.includes(':expert'))   return { ...approveReview, quality_score: 95 }
      return null
    }

    const task = makeTask({ model_tier: 'moderate', complexity_score: 40 })
    const { result, calls } = await runTask(task, {}, agentFn, implFn)

    const expert = calls.find(c => c.label.includes(':expert'))
    assert.ok(expert, 'expert review call was made')
    assert.equal(expert.model, 'opus', 'expert escalation uses opus ceiling')
    assert.ok(!result.failed, 'task approved via expert escalation')
  })
})

// ── audit fixes: O4 (real tier on competition win) and O3 (QA feedback into retry) ──────────────
describe('competition result reporting and retry feedback', () => {
  const highTask = makeTask({ id: 'h', model_tier: 'complex', complexity_score: 60, risk: 'high' })
  const happyAgent = (l) => {
    if (l.startsWith('judge:'))  return judgeScore()
    if (l.startsWith('verify:')) return passVerdict()
    return approveReview
  }

  // #O4: real runImplementation hardcodes model_used:'external'; a competition win must report the
  // task's resolved tier, not the literal 'external'.
  test('competition win reports the real model tier, not "external" (#O4)', async () => {
    const externalImpl = () => ({ ...okImpl(), model_used: 'external' })
    const { result } = await runTask(highTask, {}, happyAgent, externalImpl)
    assert.ok(!result.failed)
    assert.equal(result.final_model_tier, 'complex')
    assert.notEqual(result.final_model_tier, 'external')
  })

  // #O3: when the competition winner passes gates but is REJECTED by adversarial QA, the retry must be
  // seeded with the QA rejection reason — not retried blind (the old seed dropped status:'ok' impls).
  test('a QA-rejected competition winner retries WITH the QA rejection feedback (#O3)', async () => {
    const feedbacks = []
    const rejectingAgent = (l) => {
      if (l.startsWith('judge:'))  return judgeScore()
      if (l.startsWith('verify:')) return { refuted: true, reasons: ['SECURITY-HOLE-xyz'], confidence: 5, severity: 'critical' }
      return approveReview
    }
    const recordingImpl = (_c, _t, _cli, _attempt, feedback) => { feedbacks.push((feedback || []).join(' | ')); return okImpl() }
    await runTask(highTask, {}, rejectingAgent, recordingImpl)
    // feedbacks[0],[1] are the two competitors (always seeded []). feedbacks[2] is the FIRST retry —
    // it must carry the QA rejection reason, NOT be blind. (Later attempts get it from the loop's own
    // re-QA, which would mask the bug — so assert the first retry specifically.)
    assert.ok(feedbacks.length >= 3, 'competition + at least one retry occurred')
    assert.ok(feedbacks[2].includes('SECURITY-HOLE-xyz'),
      `first retry must be seeded with the QA rejection issue; got: ${JSON.stringify(feedbacks[2])}`)
  })
})
