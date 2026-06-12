import { execSync } from 'node:child_process'
import { pipeline, parallel, phase, log } from '../engine.mjs'
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
    if (impl.status !== 'ok') { feedback = [...feedback, `attempt ${attempt}: ${impl.status} — ${impl.summary}`]; continue }
    const verdict = await reviewTask(cfg, agent, t, impl)
    if (verdict.approve) return { task: t.id, cli: t.cli, impl, attempts: attempt }
    feedback = [...feedback, ...verdict.issues]
    log(`${t.id}: attempt ${attempt} rejected (${verdict.issues.length} issues)`)
  }
  return { task: t.id, failed: true }
}

export async function runSwarm(cfg, brain, journal = null) {
  const agent = makeAgent(brain, journal, cfg)
  const waves = computeWaves(cfg.tasks)
  const merged = []
  const failed = []
  let externalTokens = 0
  let baseBranch = cfg.baseBranch
  for (let w = 0; w < waves.length; w++) {
    phase(`Wave ${w + 1}/${waves.length}`)
    const waveCfg = { ...cfg, baseBranch }
    const orchestrator = createOrchestrator({ agent, parallel, log, cfg: waveCfg })
    const results = (await pipeline(waves[w], (t) =>
      (t.risk === 'high' || t.complexity_score > 70)
        ? orchestrator.runIntelligentTask(t)
        : runRoutineTask(waveCfg, agent, t)
    )).filter(Boolean)
    results.forEach((r) => { externalTokens += r.impl?.cli_tokens || 0 })
    const approved = results.filter((r) => !r.failed)
    failed.push(...results.filter((r) => r.failed).map((r) => r.task))
    merged.push(...(await mergeWave(waveCfg, agent, approved)))
    baseBranch = execSync('git rev-parse HEAD', { cwd: cfg.repo }).toString().trim()  // rebase next wave on merged HEAD
  }
  return { merged, failed, externalTokens }
}
