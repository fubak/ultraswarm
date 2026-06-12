// Behavioral test harness for the Workflow JS embedded in skills/ultraswarm/SKILL.md.
// Extracts the ```js block, replaces agent()/parallel()/pipeline()/log()/phase()
// with mocks, and verifies the orchestration logic: model-tier routing, adaptive
// QA depths, escalation, competition, exhaustion, validation guards, quorum and
// critical-override rules, task immutability, and the dependency-wave guard.
//
// Run: node --test scripts/workflow-harness.test.mjs   (CI check [11])

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// --- extract the embedded Workflow JS (same fence contract as validate.sh) ---
const skillPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'ultraswarm', 'SKILL.md')
const md = readFileSync(skillPath, 'utf8')
const body = []
let grab = false
for (const line of md.split('\n')) {
  if (!grab && line === '```js') { grab = true; continue }
  if (grab && line === '```') break
  if (grab) body.push(line)
}
const src = body.join('\n').replace(/^export const meta = \{[\s\S]*?\n\}\n/, '')
assert.ok(src.length > 1000, 'extracted a non-trivial Workflow JS body from SKILL.md')

// --- mock runtime: each run() gets isolated call/log capture ---
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
async function run(argsValue, behavior) {
  const calls = []
  const logs = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ label: opts.label || '', phase: opts.phase, model: opts.model, prompt })
    return behavior(opts.label || '', prompt, opts)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(t => t().catch(() => null)))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item) => {
    let v = item
    for (const s of stages) v = await s(v, item)
    return v
  }))
  const result = await new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'log', 'phase', src)(
    argsValue, agent, parallel, pipeline, (m) => logs.push(m), () => {})
  return { result, calls, logs }
}

// --- fixtures ---
const makeCfg = (tasks, extra = {}) => ({
  repo: '/r', repoName: 'r', baseBranch: 'main', worktreeRoot: '/w',
  gates: [{ name: 'test', cmd: 'npm test' }],
  registry: {
    codex: {
      simple: 'c -m tier-simple "$(cat .ultraswarm-prompt.txt)"',
      moderate: 'c -m tier-moderate "$(cat .ultraswarm-prompt.txt)"',
      complex: 'c -m tier-complex "$(cat .ultraswarm-prompt.txt)"',
      expert: 'c -m tier-expert "$(cat .ultraswarm-prompt.txt)"',
    },
    grok: { simple: 'g -m s', moderate: 'g -m m', complex: 'g -m c', expert: 'g -m e' },
    opencode: 'opencode run legacy-string "$(cat .ultraswarm-prompt.txt)"',
  },
  alternates: { codex: 'grok', grok: 'codex', opencode: 'grok' },
  timeoutMs: 1000, timeouts: {}, tasks,
  ...extra,
})
const makeTask = (over = {}) => ({
  id: 't', description: 'd', files: ['a.js'], cli: 'codex', model_tier: 'simple',
  complexity_score: 10, risk: 'routine', dependencies: [], acceptance: 'x',
  prompt: 'p', estimated_tokens: 1000, ...over,
})
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
const rejectReview = { approve: false, issues: ['bad'], quality_score: 10, complexity_assessment: 0 }
const passVerdict = (conf = 90) => ({ refuted: false, reasons: [], confidence: conf, severity: 'low' })
const judgeScore = (score = 8) => ({ score, rationale: 'r', graft_ideas: [], complexity_handling: 8, model_efficiency: 8, code_quality: 8 })
const implTier = (label) => label.split(':')[3].split('#')[0]   // impl:<id>:<cli>:<tier>#<n>

describe('model-tier routing', () => {
  test('simple task: haiku wrapper, tier-correct command, haiku simple QA, metrics returned', async () => {
    const { result, calls } = await run(JSON.stringify(makeCfg([makeTask()])),
      (l) => l.startsWith('impl:') ? okImpl() : approveReview)
    assert.equal(result.approved.length, 1)
    assert.equal(result.failed.length, 0)
    const impl = calls.find(c => c.label.startsWith('impl:'))
    assert.equal(impl.model, 'haiku', 'impl wrapper runs on haiku')
    assert.match(impl.prompt, /tier-simple/, 'simple-tier command embedded in wrapper prompt')
    const review = calls.find(c => c.label.startsWith('review:'))
    assert.equal(review.model, 'haiku')
    assert.match(review.label, /:simple/)
    assert.equal(typeof result.intelligence_metrics.complexity_efficiency, 'number')
    assert.equal(result.external_tokens, 1000)
    assert.deepEqual(result.token_coverage, { captured: 1, total: 1 })
  })

  test('moderate task (complexity 40): moderate QA label and moderate-tier command', async () => {
    const { result, calls } = await run(JSON.stringify(makeCfg([makeTask({ model_tier: 'moderate', complexity_score: 40 })])),
      (l) => l.startsWith('impl:') ? okImpl() : approveReview)
    assert.equal(result.approved.length, 1)
    assert.match(calls.find(c => c.label.startsWith('review:')).label, /:moderate/)
    assert.match(calls.find(c => c.label.startsWith('impl:')).prompt, /tier-moderate/)
  })

  test('legacy single-string registry entry is used verbatim', async () => {
    const { result, calls } = await run(JSON.stringify(makeCfg([makeTask({ cli: 'opencode' })])),
      (l) => l.startsWith('impl:') ? okImpl() : approveReview)
    assert.equal(result.approved.length, 1)
    assert.match(calls.find(c => c.label.startsWith('impl:')).prompt, /legacy-string/)
  })
})

describe('high-risk path: competition, judges, adversarial lenses', () => {
  const highTask = makeTask({ id: 'h', model_tier: 'complex', complexity_score: 60, risk: 'high' })
  const happy = (l) => {
    if (l.startsWith('impl:')) return okImpl()
    if (l.startsWith('judge:')) return judgeScore()
    if (l.startsWith('verify:')) return passVerdict()
    return approveReview
  }

  test('risk:high → two CLIs compete, sonnet judges, security-opus + sonnet cascade lenses', async () => {
    const { result, calls } = await run(JSON.stringify(makeCfg([highTask])), happy)
    const impls = calls.filter(c => c.label.startsWith('impl:'))
    assert.equal(impls.length, 2)
    assert.equal(new Set(impls.map(c => c.label.split(':')[2])).size, 2, 'two distinct CLIs')
    const judges = calls.filter(c => c.label.startsWith('judge:'))
    assert.equal(judges.length, 2)
    assert.ok(judges.every(j => j.model === 'sonnet'))
    const lenses = calls.filter(c => c.label.startsWith('verify:'))
    assert.equal(lenses.length, 3, 'confident passes do not escalate — exactly one call per lens')
    const lensModel = (lens) => lenses.find(l => l.label === `verify:h:${lens}`).model
    assert.equal(lensModel('security'), 'opus', 'security is the asymmetric-risk lens — always the opus ceiling')
    assert.equal(lensModel('correctness'), 'sonnet', 'correctness starts on sonnet, escalates only on doubt')
    assert.equal(lensModel('regression'), 'sonnet', 'regression starts on sonnet, escalates only on doubt')
    assert.equal(result.approved.length, 1)
  })

  test('cascade: a borderline sonnet lens escalates to a second opus verdict (why: catch what sonnet is unsure about without paying opus on every lens)', async () => {
    const { result, calls } = await run(JSON.stringify(makeCfg([highTask])), (l) => {
      if (l.startsWith('impl:')) return okImpl()
      if (l.startsWith('judge:')) return judgeScore()
      if (l.startsWith('verify:')) {
        // correctness comes back borderline (conf 50) on its sonnet first pass → must re-run on opus
        if (l === 'verify:h:correctness') return passVerdict(50)
        return passVerdict(90)
      }
      return approveReview
    })
    const firstPass = calls.find(c => c.label === 'verify:h:correctness')
    assert.equal(firstPass.model, 'sonnet', 'correctness first pass runs on sonnet')
    const escalated = calls.filter(c => c.label === 'verify:h:correctness:opus')
    assert.equal(escalated.length, 1, 'borderline correctness lens re-runs once on opus')
    assert.equal(escalated[0].model, 'opus')
    assert.equal(result.approved.length, 1, 'the escalated opus verdict (conf 90) clears quorum and score')
  })

  test('complexity > 70 triggers competition even at routine risk', async () => {
    const { result, calls } = await run(JSON.stringify(makeCfg([makeTask({ model_tier: 'complex', complexity_score: 80 })])), happy)
    assert.equal(calls.filter(c => c.label.startsWith('impl:')).length, 2)
    assert.equal(result.approved.length, 1)
  })

  test('quorum: a single surviving lens vote must NOT approve', async () => {
    let lensN = 0
    const { result } = await run(JSON.stringify(makeCfg([highTask])), (l) => {
      if (l.startsWith('impl:')) return okImpl()
      if (l.startsWith('judge:')) return judgeScore()
      if (l.startsWith('verify:')) { lensN++; return lensN % 3 === 1 ? passVerdict(95) : null }
      return rejectReview
    })
    assert.equal(result.approved.length, 0, 'one 95-confidence vote of three must not pass quorum')
  })

  test('critical override: persistent critical refutation fails despite two confident passes', async () => {
    const { result } = await run(JSON.stringify(makeCfg([highTask])), (l) => {
      if (l.startsWith('impl:')) return okImpl()
      if (l.startsWith('judge:')) return judgeScore()
      if (l.startsWith('verify:')) {
        return l.includes(':security')
          ? { refuted: true, reasons: ['hardcoded secret'], confidence: 99, severity: 'critical' }
          : passVerdict(92)   // old scoring: (0+92+92)/3 = 61.3 >= 60 would have approved
      }
      return rejectReview
    })
    assert.equal(result.approved.length, 0)
    assert.deepEqual(result.failed, ['h'], 'tombstones after exhausting retries against the critical finding')
  })

  test('all lens agents dying must not approve (and must not silently drop the task)', async () => {
    const { result } = await run(JSON.stringify(makeCfg([highTask])), (l) => {
      if (l.startsWith('impl:')) return okImpl()
      if (l.startsWith('judge:')) return judgeScore(5)
      if (l.startsWith('verify:')) return null
      return rejectReview
    })
    assert.equal(result.approved.length, 0)
    assert.equal(result.failed.length, 1)
  })
})

describe('escalation, retries, exhaustion', () => {
  test('failed attempts escalate the model tier simple→moderate→complex', async () => {
    let implN = 0
    const { result, calls, logs } = await run(JSON.stringify(makeCfg([makeTask()])), (l) => {
      if (l.startsWith('impl:')) { implN++; return implN < 3 ? failImpl() : okImpl() }
      return approveReview
    })
    const tiers = calls.filter(c => c.label.startsWith('impl:')).map(c => implTier(c.label))
    assert.deepEqual(tiers, ['simple', 'moderate', 'complex'])
    assert.ok(logs.some(l => l.includes('escalating to moderate')))
    assert.equal(result.approved.length, 1)
  })

  test('primary exhausts → alternate CLI at the carried (escalated) tier → tombstone', async () => {
    const { result, calls } = await run(JSON.stringify(makeCfg([makeTask({ id: 'x' })])),
      (l) => l.startsWith('impl:') ? failImpl() : rejectReview)
    const implLabels = calls.filter(c => c.label.startsWith('impl:')).map(c => c.label)
    const clis = new Set(implLabels.map(l => l.split(':')[2]))
    assert.ok(clis.has('codex') && clis.has('grok'), 'reassigned to the alternate CLI')
    const grokFirst = implLabels.find(l => l.includes(':grok:'))
    assert.match(grokFirst, /:complex#4/, 'alternate starts at the carried escalated tier, not base')
    assert.deepEqual(result.failed, ['x'])
    assert.equal(result.approved.length, 0)
  })

  test('expert escalation: requires_expert_review routes a second pass to opus', async () => {
    const { result, calls } = await run(JSON.stringify(makeCfg([makeTask({ model_tier: 'moderate', complexity_score: 40 })])), (l) => {
      if (l.startsWith('impl:')) return okImpl()
      if (l.includes(':moderate')) return { ...approveReview, quality_score: 70, requires_expert_review: true }
      if (l.includes(':expert')) return { ...approveReview, quality_score: 95 }
      return null
    })
    const expert = calls.find(c => c.label.includes(':expert'))
    assert.equal(expert.model, 'opus')
    assert.equal(result.approved.length, 1)
  })
})

describe('validation and immutability guards', () => {
  test('injection-style CLI name fails the task safely (no crash, loud tombstone)', async () => {
    const { result } = await run(JSON.stringify(makeCfg([makeTask({ cli: 'rm -rf /; codex' })])),
      (l) => l.startsWith('impl:') ? okImpl() : approveReview)
    assert.equal(result.failed.length, 1)
    assert.equal(result.approved.length, 0)
  })

  test('invalid model tier fails the task safely', async () => {
    const { result } = await run(JSON.stringify(makeCfg([makeTask({ model_tier: 'ultra-mega' })])),
      (l) => l.startsWith('impl:') ? okImpl() : approveReview)
    assert.equal(result.failed.length, 1)
  })

  test('escalation never mutates the shared task object (frozen task, args passed as object)', async () => {
    let implN = 0
    const task = makeTask({ id: 'frozen' })
    const cfgObj = makeCfg([task])
    Object.freeze(task)
    const { result, calls } = await run(cfgObj, (l) => {   // object args → cfg shares refs
      if (l.startsWith('impl:')) { implN++; return implN < 3 ? failImpl() : okImpl() }
      return approveReview
    })
    assert.equal(result.approved.length, 1)
    assert.equal(task.model_tier, 'simple', 'task untouched despite escalation')
    const tiers = calls.filter(c => c.label.startsWith('impl:')).map(c => implTier(c.label))
    assert.deepEqual(tiers, ['simple', 'moderate', 'complex'], 'escalation works via per-attempt copy')
  })
})

describe('dependency-wave guard', () => {
  test('intra-invocation dependency edges throw before any agent runs', async () => {
    const cfgObj = makeCfg([
      makeTask({ id: 'a' }),
      makeTask({ id: 'b', dependencies: ['a'] }),
    ], { taskGraph: { dependencies: { b: ['a'] }, independent_clusters: [['a'], ['b']], critical_path: ['a', 'b'] } })
    let calls
    await assert.rejects(
      async () => { ({ calls } = await run(JSON.stringify(cfgObj), () => okImpl())) },
      /chained Workflow runs/, 'guard explains the wave-chaining fix')
    await assert.rejects(
      async () => run(JSON.stringify(cfgObj), () => okImpl()),
      /\[b\]/, 'guard names the offending task')
  })

  test('dependencies on prior-wave task ids (not in this invocation) are allowed', async () => {
    const cfgObj = makeCfg([
      makeTask({ id: 'a' }),
      makeTask({ id: 'b', files: ['b.js'], dependencies: ['t0-from-previous-wave'] }),
    ], { taskGraph: { dependencies: {}, independent_clusters: [['a'], ['b']], critical_path: [] } })
    const { result, logs } = await run(JSON.stringify(cfgObj),
      (l) => l.startsWith('impl:') ? okImpl() : approveReview)
    assert.equal(result.approved.length, 2)
    assert.ok(logs.some(l => l.includes('Processing cluster')))
    assert.equal(result.intelligence_metrics.task_parallelization, 2)
  })
})
