import { execSync } from 'node:child_process'
import { pipeline, parallel, phase, log, makeLimiter } from '../engine.mjs'
import { computeWaves } from './waves.mjs'
import { runImplementation } from './implement.mjs'
import { mergeWave } from './merge.mjs'
import { completeWithSchema } from '../validate.mjs'
import { adaptiveReviewPrompt, ENHANCED_REVIEW_SCHEMA } from '../prompts.mjs'
import { createOrchestrator } from './core.mjs'
import { resolveBrainModel } from '../llm/brain-router.mjs'

// Brain agent for review/judge/lens labels. Impl labels never reach here (see runRoutineTask).
function makeAgent(brain, journal, cfg) {
  return async (prompt, { label, model, schema }) => {
    const resolvedModel = resolveBrainModel(model, cfg).model
    const run = async () => {
      const r = await completeWithSchema(
        (fb) => brain.complete({ prompt: fb ? `${prompt}\n\n${fb}` : prompt, model: resolvedModel, schema, label }),
        { schema, maxRetries: 2 })
      return r ? r.object : null
    }
    return journal ? journal.step(label, prompt, run) : run()
  }
}

async function reviewTask(cfg, agent, t, impl) {
  const model = t.complexity_score <= 30 ? 'haiku' : 'sonnet'
  const r = await agent(adaptiveReviewPrompt(cfg, t, impl), { label: `review:${t.id}`, model, schema: ENHANCED_REVIEW_SCHEMA })
  return r ? { approve: r.approve, issues: r.issues || [] } : { approve: false, issues: ['reviewer died'] }
}

async function runRoutineTask(cfg, agent, t) {
  let feedback = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    const impl = await runImplementation(cfg, t, t.cli, attempt, feedback)
    if (impl.status !== 'ok') {
      feedback = [...feedback, `attempt ${attempt}: ${impl.status} — ${impl.summary}`]
      continue
    }
    // Mechanical relevant-changes gate (catches empty/no-op worker results before expensive review)
    const changed = new Set(impl.files_changed || [])
    const requested = t.files || []
    const hasRelevant = requested.length === 0 || requested.some(f => changed.has(f))
    if (!hasRelevant) {
      feedback = [...feedback, `attempt ${attempt}: worker produced no relevant changes to the requested files ${JSON.stringify(requested)} (got: ${JSON.stringify(impl.files_changed)})`]
      continue
    }
    const verdict = await reviewTask(cfg, agent, t, impl)
    if (verdict.approve) return { task: t.id, cli: t.cli, impl, attempts: attempt }
    feedback = [...feedback, ...verdict.issues]
    log(`${t.id}: attempt ${attempt} rejected (${verdict.issues.length} issues)`)
  }
  return { task: t.id, failed: true }
}

export async function runSwarm(cfg, brain, journal = null) {
  const agent = makeAgent(brain, journal, cfg)
  // Cap concurrent worker subprocesses at the operator's policy. One limiter is shared across the
  // whole run (wave pipeline AND high-risk competition) so total live workers never exceed the cap.
  // It gates only the leaf worker invocation (see implement.mjs), never the orchestration coroutines,
  // so a high-risk task that nests parallel() inside the wave pipeline can never deadlock on it.
  const workerLimit = makeLimiter(Math.max(1, cfg.policy?.maxParallelWorkers ?? 4))
  const waves = computeWaves(cfg.tasks)
  const planIds = new Set(cfg.tasks.map((t) => t.id))
  const merged = []          // [{ task, merged, reason? }]
  const failed = []          // task ids that exhausted attempts
  const blocked = []         // [{ task, reason }] — a prerequisite didn't merge (#10)
  const mergedOk = new Set() // ids that merged successfully (the only "satisfied dependency")
  const attempts = {}        // task id -> attempt count (#11 metrics)
  let externalTokens = 0
  let tokensCaptured = 0, tokenAttempts = 0
  let baseBranch = cfg.baseBranch
  for (let w = 0; w < waves.length; w++) {
    phase(`Wave ${w + 1}/${waves.length}`)
    // Block any task whose in-plan dependency did not merge — never run a dependent blind (#10).
    const runnable = []
    for (const t of waves[w]) {
      const badDep = (t.dependencies || []).find((d) => planIds.has(d) && !mergedOk.has(d))
      if (badDep) {
        blocked.push({ task: t.id, reason: `dependency ${badDep} did not merge` })
        log(`${t.id}: BLOCKED — dependency ${badDep} did not merge`)
      } else {
        runnable.push(t)
      }
    }
    const waveCfg = { ...cfg, baseBranch, workerLimit }
    const orchestrator = createOrchestrator({ agent, parallel, log, cfg: waveCfg })
    const results = (await pipeline(runnable, (t) =>
      (t.risk === 'high' || t.complexity_score > 70)
        ? orchestrator.runIntelligentTask(t)
        : runRoutineTask(waveCfg, agent, t)
    )).filter(Boolean)
    results.forEach((r) => {
      externalTokens += r.impl?.cli_tokens || 0
      if (r.attempts) attempts[r.task] = r.attempts
      if (!r.failed) { tokenAttempts += 1; if (r.impl?.cli_tokens > 0) tokensCaptured += 1 }
    })
    const approved = results.filter((r) => !r.failed)
    failed.push(...results.filter((r) => r.failed).map((r) => r.task))
    const wmerged = await mergeWave(waveCfg, agent, approved)
    merged.push(...wmerged)
    wmerged.filter((m) => m.merged).forEach((m) => mergedOk.add(m.task))
    baseBranch = execSync('git rev-parse HEAD', { cwd: cfg.integrationRepo ?? cfg.repo }).toString().trim()
  }
  return {
    merged, failed, blocked, externalTokens, attempts,
    taskCount: cfg.tasks.length,
    tokenCoverage: { captured: tokensCaptured, total: tokenAttempts },
  }
}
