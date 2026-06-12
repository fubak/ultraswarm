// lib/orchestrator/core.mjs
// Factory that encapsulates the high-risk QA cascade + competition logic lifted
// from skills/ultraswarm/SKILL.md.  All Workflow globals (agent/parallel/log/cfg)
// are injected via the factory — no phase() calls in here.

import {
  adaptiveReviewPrompt,
  intelligentJudgePrompt,
  expertLensPrompt,
  ENHANCED_REVIEW_SCHEMA,
  ADAPTIVE_JUDGE_SCHEMA,
  EXPERT_VERDICT_SCHEMA,
  EXPERT_LENSES,
  VALID_MODEL_TIERS,
} from '../prompts.mjs'
import { runImplementation as _runImplementation } from './implement.mjs'

// ── constants ──────────────────────────────────────────────────────────────────
const QA_CONFIDENCE_THRESHOLD   = 60
const SIMPLE_COMPLEXITY_THRESHOLD = 30
const EXPERT_COMPLEXITY_THRESHOLD = 50
const COMPLEX_THRESHOLD          = 70
const COMPLEXITY_WEIGHT          = 0.4
const EFFICIENCY_WEIGHT          = 0.3
const MODEL_WEIGHT               = 0.3
const LENS_BORDERLINE            = 75

const ALLOWED_CLIS = ['codex', 'gemini', 'grok', 'agy', 'droid', 'opencode']

// ── input validation (exact copies from SKILL.md) ────────────────────────────
function validateCliName(cli) {
  if (!cli || typeof cli !== 'string') {
    throw new Error('CLI name must be a non-empty string')
  }
  if (!ALLOWED_CLIS.includes(cli)) {
    throw new Error(`Invalid CLI name: ${cli}. Allowed: ${ALLOWED_CLIS.join(', ')}`)
  }
  return cli
}

function validateModelTier(tier) {
  if (!tier || typeof tier !== 'string') {
    throw new Error('Model tier must be a non-empty string')
  }
  if (!VALID_MODEL_TIERS.includes(tier)) {
    throw new Error(`Invalid model tier: ${tier}. Allowed: ${VALID_MODEL_TIERS.join(', ')}`)
  }
  return tier
}

/**
 * createOrchestrator — factory that closes over injected primitives.
 *
 * @param {object} opts
 * @param {Function} opts.agent   - async (prompt, { label, model, schema }) => object|null
 * @param {Function} opts.parallel - async (thunks[]) => results[]  (same contract as engine.mjs)
 * @param {Function} opts.log     - (message: string) => void
 * @param {object}   opts.cfg     - wave config (registry, alternates, baseBranch, intelligence, …)
 * @param {Function} [opts.runImplementation] - optional override for tests; defaults to real impl
 */
export function createOrchestrator({ agent, parallel, log, cfg, runImplementation = _runImplementation }) {

  // A cli is usable if it's a known worker (resolvable via DEFAULT_REGISTRY + overrides) or has an
  // explicit legacy registry entry. The high-risk path must NOT gate on cfg.registry alone — the
  // documented `enabled`/`overrides` config has no `registry` map, so doing so made high-risk tasks
  // always tombstone and made a missing alternate throw (issues #6 / #13).
  const cliUsable = (c) => !!c && (ALLOWED_CLIS.includes(c) || !!(cfg.registry && cfg.registry[c]))

  // ── simple QA: fast review with Haiku ──────────────────────────────────────
  async function runSimpleQA(t, impl) {
    try {
      const r = await agent(adaptiveReviewPrompt(cfg, t, impl), {
        label: `review:${t.id}:simple`,
        schema: ENHANCED_REVIEW_SCHEMA,
        model: 'haiku',
      })
      return r ? { approve: r.approve, issues: r.issues } : { approve: false, issues: ['reviewer agent died'] }
    } catch (error) {
      return { approve: false, issues: [`QA error: ${error.message}`] }
    }
  }

  // ── moderate QA: thorough review with potential expert escalation ──────────
  async function runModerateQA(t, impl) {
    try {
      const useExpertReview = t.complexity_score > EXPERT_COMPLEXITY_THRESHOLD || t.risk === 'high'
      const reviewModel = useExpertReview ? 'sonnet' : 'haiku'

      const r = await agent(adaptiveReviewPrompt(cfg, t, impl), {
        label: `review:${t.id}:moderate`,
        schema: ENHANCED_REVIEW_SCHEMA,
        model: reviewModel,
      })

      if (r?.requires_expert_review) {
        return await runExpertEscalation(t, impl)
      }

      return r ? { approve: r.approve, issues: r.issues } : { approve: false, issues: ['reviewer agent died'] }
    } catch (error) {
      return { approve: false, issues: [`QA error: ${error.message}`] }
    }
  }

  // ── expert escalation QA ───────────────────────────────────────────────────
  async function runExpertEscalation(t, impl) {
    try {
      const ceiling = cfg.intelligence?.maxIntelligence ? 'fable' : 'opus'
      const expert = await agent(
        adaptiveReviewPrompt(cfg, t, impl) + '\n\nEXPERT ESCALATION: Provide detailed analysis for complex edge cases.', {
          label: `review:${t.id}:expert`,
          schema: ENHANCED_REVIEW_SCHEMA,
          model: ceiling,
        })
      return expert ? { approve: expert.approve, issues: expert.issues } : { approve: false, issues: ['expert review failed'] }
    } catch (error) {
      return { approve: false, issues: [`Expert QA error: ${error.message}`] }
    }
  }

  // ── high-risk adversarial QA: FrugalGPT-style cascade ────────────────────
  async function runAdversarialQA(t, impl) {
    try {
      const ceiling = cfg.intelligence?.maxIntelligence ? 'fable' : 'opus'
      const firstModel = lens => lens === 'security' ? ceiling : 'sonnet'

      // First pass: security on ceiling model, rest on sonnet — all in parallel.
      const firstPass = (await parallel(EXPERT_LENSES.map(lens => () =>
        agent(expertLensPrompt(lens, t, impl, cfg.baseBranch), {
          label: `verify:${t.id}:${lens}`,
          schema: EXPERT_VERDICT_SCHEMA,
          model: firstModel(lens),
        }).then(v => v && { lens, v })))).filter(Boolean)

      // Escalate any sonnet lens that refuted or is borderline to ceiling; keep sonnet verdict if escalated agent dies.
      const votes = (await parallel(firstPass.map(({ lens, v }) => async () => {
        if (firstModel(lens) === ceiling) return v
        if (!v.refuted && v.confidence >= LENS_BORDERLINE) return v
        const escalated = await agent(expertLensPrompt(lens, t, impl, cfg.baseBranch), {
          label: `verify:${t.id}:${lens}:${ceiling}`,
          schema: EXPERT_VERDICT_SCHEMA,
          model: ceiling,
        })
        return escalated || v
      }))).filter(Boolean)

      // Quorum guard: a high-risk task must never pass without at least 2 lens votes
      if (votes.length < 2) {
        return { approve: false, issues: [`adversarial verification could not complete (${votes.length}/${EXPERT_LENSES.length} lens agents responded)`] }
      }

      const weightedScore = votes.reduce((sum, v) => sum + (v.refuted ? 0 : v.confidence), 0) / votes.length
      const criticalIssues = votes.filter(v => v.refuted && v.severity === 'critical')
      // Any critical refutation is an instant fail regardless of other lenses' confidence
      const ok = weightedScore >= QA_CONFIDENCE_THRESHOLD && criticalIssues.length === 0

      const issues = [
        ...votes.filter(v => v.refuted).flatMap(v => v.reasons),
        ...(criticalIssues.length > 0 ? ['CRITICAL issues found - requires immediate attention'] : []),
      ]
      return { approve: ok, issues }
    } catch (error) {
      return { approve: false, issues: [`Adversarial QA error: ${error.message}`] }
    }
  }

  // ── main adaptive QA dispatcher ────────────────────────────────────────────
  async function adaptiveQA(t, impl) {
    if (t.risk === 'high') {
      return await runAdversarialQA(t, impl)
    }

    if (t.complexity_score <= SIMPLE_COMPLEXITY_THRESHOLD) {
      return await runSimpleQA(t, impl)
    }

    return await runModerateQA(t, impl)
  }

  /**
   * Enhanced attempt loop with intelligent model escalation.
   * @param {object} t - Task object
   * @param {string} cli - CLI name
   * @param {number} maxAttempts - Maximum number of attempts
   * @param {string[]} seedFeedback - Initial feedback from prior attempts
   * @param {number} attemptOffset - Starting attempt number offset
   * @param {string|null} startTier - Tier to begin at (carries escalation across CLI reassignment)
   * @returns {Promise<object>} success {task, cli, impl, attempts, feedback, final_model_tier, complexity_achieved}
   *                            or exhaustion {exhausted:true, feedback, final_model_tier}
   */
  async function intelligentAttemptLoop(t, cli, maxAttempts, seedFeedback, attemptOffset = 0, startTier = null) {
    try {
      const validCli = validateCliName(cli)
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error('maxAttempts must be a positive integer')
      }
      if (!Array.isArray(seedFeedback)) {
        throw new Error('seedFeedback must be an array')
      }

      let feedback = seedFeedback
      let currentModelTier = validateModelTier(startTier || t.model_tier || 'simple')

      for (let n = 1; n <= maxAttempts; n++) {
        const attempt = attemptOffset + n

        // Model escalation on retry attempts
        if (n > 1 && currentModelTier !== 'expert') {
          const tiers = ['simple', 'moderate', 'complex', 'expert']
          const currentIndex = tiers.indexOf(currentModelTier)
          if (currentIndex < tiers.length - 1) {
            currentModelTier = tiers[currentIndex + 1]
            log(`${t.id}: escalating to ${currentModelTier} model for attempt ${attempt}`)
          }
        }

        // Immutable per-attempt view: never mutate the shared task object
        const tAttempt = { ...t, model_tier: currentModelTier }

        const impl = await runImplementation(cfg, tAttempt, validCli, attempt, feedback)
        if (!impl || impl.status !== 'ok') {
          const gates = impl ? (impl.gate_results || []).filter(g => !g.pass)
            .map(g => `${g.name}: ${g.detail || 'failed'}${g.duration ? ` (${g.duration}ms)` : ''}`)
            .join('; ') : ''
          feedback = [...feedback, impl
            ? `attempt ${attempt} (${validCli}/${currentModelTier}): ${impl.status} — ${impl.summary}${gates ? ` · gates: ${gates}` : ''}`
            : `attempt ${attempt} (${validCli}): wrapper agent died`]
          continue
        }

        const verdict = await adaptiveQA(tAttempt, impl)
        if (verdict.approve) return {
          task: t.id, cli: validCli, impl, attempts: attempt, feedback,
          final_model_tier: currentModelTier, complexity_achieved: impl.complexity_achieved,
        }
        feedback = [...feedback, ...verdict.issues]
        log(`${t.id}: attempt ${attempt} on ${validCli}/${currentModelTier} rejected (${verdict.issues.length} issues)`)
      }
      return { exhausted: true, feedback, final_model_tier: currentModelTier }
    } catch (error) {
      log(`Attempt loop failed for ${t.id}: ${error.message}`)
      return { exhausted: true, feedback: [...seedFeedback, `Attempt loop error: ${error.message}`], final_model_tier: t.model_tier || 'simple' }
    }
  }

  // ── judge competition between implementations ──────────────────────────────
  async function judgeCompetition(t, impls) {
    let winner = impls[0], graft = []

    if (impls.length > 1) {
      try {
        const scores = (await parallel(impls.map(i => () =>
          agent(intelligentJudgePrompt(cfg, t, i), {
            label: `judge:${t.id}:${i.cli}`,
            schema: ADAPTIVE_JUDGE_SCHEMA,
            model: 'sonnet',
          }).then(s => ({ i, s }))))).filter(x => x && x.s)

        // Weight by complexity handling and model efficiency
        scores.forEach(x => {
          x.weighted_score = x.s.score * COMPLEXITY_WEIGHT +
                             x.s.complexity_handling * EFFICIENCY_WEIGHT +
                             x.s.model_efficiency * MODEL_WEIGHT
        })
        scores.sort((a, b) => b.weighted_score - a.weighted_score)

        winner = scores[0]?.i ?? winner
        graft = scores.slice(1).flatMap(x => x.s.graft_ideas)
      } catch (error) {
        log(`Judging failed for ${t.id}: ${error.message}`)
      }
    }

    return { winner, graft }
  }

  // ── handle failed competition with retry logic ─────────────────────────────
  async function handleFailedCompetition(t, all, winner = null) {
    const retryCli = winner ? winner.cli : t.cli
    const seed = all.filter(i => i.status !== 'ok').map(i => {
      const gates = (i.gate_results || []).filter(g => !g.pass).map(g => `${g.name}: ${g.detail}`).join('; ')
      return `competition attempt (${i.cli}): ${i.status} — ${i.summary}${gates ? ` · gates: ${gates}` : ''}`
    })

    const retried = await intelligentAttemptLoop(t, retryCli, 2, seed, 1)
    if (!retried.exhausted) return { ...retried, graft: [] }

    // Carry the escalated tier into the alternate CLI (don't restart at the task's base tier).
    // Guard a missing/unusable/self alternate (issue #13) — tombstone cleanly instead of passing
    // undefined into the attempt loop (which threw "CLI name must be a non-empty string").
    const altCli = cfg.alternates[retryCli]
    if (!cliUsable(altCli) || altCli === retryCli) return { task: t.id, failed: true }
    const fallback = await intelligentAttemptLoop(t, altCli, 2,
      [...retried.feedback, `prior CLI (${retryCli}) exhausted`], 3, retried.final_model_tier)
    return fallback.exhausted ? { task: t.id, failed: true } : fallback
  }

  // ── competition between multiple CLIs for high-risk/complex tasks ──────────
  async function runCompetitiveTask(t) {
    try {
      const competitors = [...new Set([t.cli, cfg.alternates[t.cli]])].filter(cliUsable)
      log(`${t.id} (${t.risk === 'high' ? 'high risk' : 'complex'}): competing on ${competitors.join(' vs ')}`)

      const all = (await parallel(competitors.map(c => () =>
        runImplementation(cfg, t, c, 1, []).then(i => i && { ...i, cli: c })))).filter(Boolean)
      const impls = all.filter(i => i.status === 'ok')

      if (impls.length === 0) {
        return await handleFailedCompetition(t, all)
      }

      const { winner, graft } = await judgeCompetition(t, impls)

      if (winner) {
        const verdict = await adaptiveQA(t, winner)
        if (verdict.approve) {
          return {
            task: t.id, cli: winner.cli, impl: winner, attempts: 1, graft,
            final_model_tier: winner.model_used, complexity_achieved: winner.complexity_achieved,
          }
        }
      }

      return await handleFailedCompetition(t, all, winner)
    } catch (error) {
      log(`Competition failed for ${t.id}: ${error.message}`)
      return { task: t.id, failed: true, error: error.message }
    }
  }

  // ── standard single-CLI task execution ────────────────────────────────────
  async function runStandardTask(t) {
    try {
      const primary = await intelligentAttemptLoop(t, t.cli, 3, [])
      if (!primary.exhausted) return primary

      const altCli = cfg.alternates[t.cli]
      if (!cliUsable(altCli) || altCli === t.cli) return { task: t.id, failed: true }
      log(`${t.id}: ${t.cli} exhausted, reassigning to ${altCli}`)
      // Carry the escalated tier into the alternate CLI (don't restart at the task's base tier)
      const fallback = await intelligentAttemptLoop(t, altCli, 2,
        [...primary.feedback, `prior CLI (${t.cli}) exhausted`], 3, primary.final_model_tier)
      return fallback.exhausted ? { task: t.id, failed: true } : fallback
    } catch (error) {
      log(`Standard task failed for ${t.id}: ${error.message}`)
      return { task: t.id, failed: true, error: error.message }
    }
  }

  /**
   * Main intelligent task execution dispatcher.
   * Routes tasks to appropriate execution strategy based on risk and complexity.
   * @param {object} t - Task object with complexity scoring and metadata
   * @returns {Promise<object>} {task, cli, impl, attempts, ...} or {task, failed:true}
   */
  async function runIntelligentTask(t) {
    log(`Starting ${t.id}: complexity ${t.complexity_score}/100, model tier ${t.model_tier}, deps: ${t.dependencies?.join(',') || 'none'}`)

    if (t.risk === 'high' || t.complexity_score > COMPLEX_THRESHOLD) {
      return await runCompetitiveTask(t)
    }

    return await runStandardTask(t)
  }

  return { runIntelligentTask, adaptiveQA }
}
