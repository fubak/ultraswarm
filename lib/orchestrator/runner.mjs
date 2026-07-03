import { execSync } from 'node:child_process'
import { pipeline, parallel, phase, log, makeLimiter } from '../engine.mjs'
import { computeWaves } from './waves.mjs'
import { runImplementation } from './implement.mjs'
import { mergeWave } from './merge.mjs'
import { completeWithSchema } from '../validate.mjs'
import { adaptiveReviewPrompt, ENHANCED_REVIEW_SCHEMA, DEFAULT_EFFORT } from '../prompts.mjs'
import { createOrchestrator, nextEffort } from './core.mjs'
import { resolveBrainModel } from '../llm/brain-router.mjs'
import { priceUsd } from '../llm/pricing.mjs'
import { estimateTaskTokens } from '../llm/estimate.mjs'
import { resolveRoute } from '../router.mjs'

const fmtElapsed = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

// Periodic "who's active now" line so the operator sees EVERY worker's state continuously — which
// tasks are running (with elapsed time) and which enabled workers are idle. Returns a stop fn.
// No-op without a durable store (mock/store-less runs) so it can't throw there.
export function startHeartbeat(cfg, now = () => Date.now()) {
  const enabled = cfg.enabled ?? cfg.workerManager?.names?.() ?? []
  if (!cfg.store || !cfg.runId) return () => {}
  const tick = () => {
    try {
      const running = cfg.store.getAttempts(cfg.runId).filter((a) => a.status === 'running')
      if (!running.length) return
      const active = running.map((a) => `${a.task_id}(${a.worker} ${fmtElapsed(now() - Date.parse(a.started_at))})`).join(', ')
      const busy = new Set(running.map((a) => a.worker))
      const idle = enabled.filter((name) => !busy.has(name))
      log(`⏱ active: ${active}${idle.length ? ` · idle: ${idle.join(', ')}` : ''}`)
    } catch { /* heartbeat is best-effort, never break a run */ }
  }
  const timer = setInterval(tick, cfg.heartbeatMs ?? 15000)
  timer.unref?.()
  return () => clearInterval(timer)
}

// Brain agent for review/judge/lens labels. Impl labels never reach here (see runRoutineTask).
function makeAgent(brain, journal, cfg) {
  return async (prompt, { label, model, schema }) => {
    const resolvedModel = resolveBrainModel(model, cfg).model
    const run = async () => {
      const r = await completeWithSchema(
        (fb) => brain.complete({ prompt: fb ? `${prompt}\n\n${fb}` : prompt, model: resolvedModel, schema, label }),
        { schema, maxRetries: 2 })
      // Account brain spend so the run isn't blind to maxCostUsd. recordBrainCost is added by the
      // store layer — guard with ?. so tests/runs without a store still work.
      if (r?.usage) cfg.store?.recordBrainCost?.({ runId: cfg.runId, costUsd: priceUsd(resolvedModel, r.usage, cfg) })
      return r ? r.object : null
    }
    return journal ? journal.step(label, prompt, run) : run()
  }
}

async function reviewTask(cfg, agent, t, impl) {
  const model = t.complexity_score <= 30 ? 'haiku' : 'sonnet'
  try {
    const r = await agent(adaptiveReviewPrompt(cfg, t, impl), { label: `review:${t.id}`, model, schema: ENHANCED_REVIEW_SCHEMA })
    return r ? { approve: r.approve, issues: r.issues || [] } : { approve: false, issues: ['reviewer died'] }
  } catch (e) {
    // A reviewer agent throw must never escape — reject this attempt instead of killing the wave.
    return { approve: false, issues: [`reviewer error: ${String(e?.message || e)}`] }
  }
}

export async function runRoutineTask(cfg, agent, t, runImpl = runImplementation) {
  try {
  let feedback = []
  // Routine tasks keep their model tier but climb reasoning effort on retry (effort-first
  // escalation for the common path): low → medium → high. The brain-assigned effort (default
  // low) is the starting rung; a task that fails cheap gets more compute before tombstoning.
  let currentEffort = t.effort || DEFAULT_EFFORT
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      const climbed = nextEffort(currentEffort)
      if (climbed !== currentEffort) {
        currentEffort = climbed
        log(`↑ ${t.id}: escalating to ${t.model_tier || 'simple'}@${currentEffort} for attempt ${attempt}`)
      }
    }
    const tAttempt = { ...t, effort: currentEffort }
    const impl = await runImpl(cfg, tAttempt, t.cli, attempt, feedback)
    if (impl.status !== 'ok') {
      feedback = [...feedback, `attempt ${attempt} (@${currentEffort}): ${impl.status} — ${impl.summary}`]
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
    const verdict = await reviewTask(cfg, agent, tAttempt, impl)
    if (verdict.approve) { log(`✔ ${t.id} approved by review (${t.cli}, attempt ${attempt})`); return { task: t.id, cli: t.cli, impl, attempts: attempt } }
    // Name what the rejected attempt actually touched so the retry converges on fixing it
    // instead of re-exploring the repo from scratch (cheaper retries).
    feedback = [...feedback, ...verdict.issues,
      ...(impl.files_changed?.length ? [`attempt ${attempt} changed: ${impl.files_changed.join(', ')}`] : [])]
    log(`✗ ${t.id}: attempt ${attempt} on @${currentEffort} rejected (${verdict.issues.length} issues)`)
  }
  return { task: t.id, failed: true }
  } catch (e) {
    // Any throw escaping the attempt loop (dispatch/agent/impl) must surface as a failed
    // result, never a dropped task (#B4).
    log(`✗ ${t.id}: routine task error — ${String(e?.message || e)}`)
    return { task: t.id, failed: true, error: String(e?.message || e) }
  }
}

// Estimated-vs-used buckets by (cli, model, effort) for the report's closing table.
// `used` stays null for a bucket until an attempt reports STRUCTURED usage — never backfilled
// from the estimate (v3.5.13 honesty invariant). `estimated` sums a calibration-informed
// heuristic per planned task routed to that bucket; a task whose route can't resolve (legacy
// registry entry) is skipped rather than given an invented figure.
export function computeRouteUsage(cfg, calibrationSnapshot = null) {
  const buckets = new Map()
  const bucket = (cli, model, effort) => {
    const key = `${cli}|${model ?? '—'}|${effort ?? '—'}`
    if (!buckets.has(key)) buckets.set(key, { cli, model: model ?? '—', effort: effort ?? '—', estimated: 0, used: null, attempts: 0 })
    return buckets.get(key)
  }
  if (cfg.store && cfg.runId) {
    try {
      for (const a of cfg.store.getAttempts(cfg.runId)) {
        const b = bucket(a.worker, a.model, a.effort)
        b.attempts += 1
        if (a.input_tokens != null || a.output_tokens != null) b.used = (b.used ?? 0) + (a.input_tokens || 0) + (a.output_tokens || 0)
      }
    } catch { /* metrics are best-effort; never fail a run on them */ }
  }
  // Estimates must come from calibration as it stood BEFORE this run — reading it after the run
  // would fold this run's own measured usage into its "estimate", making Δ self-fulfilling (~0%)
  // and the est-vs-used comparison meaningless on the very run that produced the data.
  let calibration = calibrationSnapshot
  if (calibration == null) { try { calibration = cfg.store?.getCalibration?.() ?? [] } catch { calibration = [] } }
  for (const t of cfg.tasks ?? []) {
    try {
      const route = resolveRoute(t, cfg)
      bucket(route.cli, route.model, route.effort).estimated += estimateTaskTokens(route, calibration)
    } catch { /* no estimate for unresolvable routes */ }
  }
  return [...buckets.values()]
    .filter((b) => b.estimated > 0 || b.used != null || b.attempts > 0)
    .sort((a, b) => (b.used ?? 0) - (a.used ?? 0) || b.estimated - a.estimated)
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
  const landedByCli = {}     // cli -> tokens for the attempt that produced each task's final result
  let baseBranch = cfg.baseBranch
  // Persist a task outcome the moment it's known so a later crash can't lose the record.
  // Mirrors how bin/cli.mjs persists the final result; guarded so a store-less run is a no-op.
  const persist = (taskId, status, data) => {
    if (cfg.store && cfg.runId) { try { cfg.store.updateTask(cfg.runId, taskId, status, data) } catch { /* persistence is best-effort */ } }
  }
  const stopHeartbeat = startHeartbeat(cfg)
  // Snapshot calibration BEFORE any attempt runs: this run's own usage lands in route_calibration
  // as attempts finish, and an estimate computed from post-run calibration would trivially match
  // the measured figure (see computeRouteUsage).
  let calibrationAtStart = null
  try { calibrationAtStart = cfg.store?.getCalibration?.() ?? [] } catch { calibrationAtStart = [] }
  try {
  for (let w = 0; w < waves.length; w++) {
    phase(`Wave ${w + 1}/${waves.length} — ${waves[w].length} task(s): ${waves[w].map((t) => t.id).join(', ')}`)
    // Block any task whose in-plan dependency did not merge — never run a dependent blind (#10).
    const runnable = []
    for (const t of waves[w]) {
      const badDep = (t.dependencies || []).find((d) => planIds.has(d) && !mergedOk.has(d))
      if (badDep) {
        const reason = `dependency ${badDep} did not merge`
        blocked.push({ task: t.id, reason })
        log(`⊘ ${t.id}: BLOCKED — ${reason}`)
        persist(t.id, 'blocked', { lastError: reason })
      } else {
        runnable.push(t)
      }
    }
    const waveCfg = { ...cfg, baseBranch, workerLimit }
    const orchestrator = createOrchestrator({ agent, parallel, log, cfg: waveCfg })
    // Wrap every per-task thunk so a THROW becomes a failed result instead of a null that
    // .filter(Boolean) would silently drop (#B4 silent task loss).
    const results = await pipeline(runnable, (t) =>
      ((t.risk === 'high' || t.complexity_score > 70)
        ? orchestrator.runIntelligentTask(t)
        : runRoutineTask(waveCfg, agent, t))
        .then((r) => r ?? { task: t.id, failed: true, error: 'task produced no result' })
        .catch((e) => ({ task: t.id, failed: true, error: String(e?.message || e) }))
    )
    // RECONCILE: every runnable task id MUST appear in results. Any missing id is recorded as a
    // loud failure rather than vanishing (#B4 / #14 report completeness).
    const seen = new Set(results.map((r) => r.task))
    for (const t of runnable) {
      if (!seen.has(t.id)) {
        log(`✗ ${t.id}: MISSING from wave results — recording as failed (silent task loss guard)`)
        results.push({ task: t.id, failed: true, error: 'task missing from wave results' })
      }
    }
    results.forEach((r) => {
      externalTokens += r.impl?.cli_tokens || 0
      if (r.cli && r.impl?.cli_tokens > 0) landedByCli[r.cli] = (landedByCli[r.cli] || 0) + r.impl.cli_tokens
      if (r.attempts) attempts[r.task] = r.attempts
      if (!r.failed) { tokenAttempts += 1; if (r.impl?.cli_tokens > 0) tokensCaptured += 1 }
    })
    const approved = results.filter((r) => !r.failed)
    const waveFailed = results.filter((r) => r.failed)
    failed.push(...waveFailed.map((r) => r.task))
    waveFailed.forEach((r) => persist(r.task, 'failed', r.error ? { lastError: r.error } : {}))
    // Guard the merge + rev-parse: a throw here previously rejected runSwarm so cli.mjs never
    // persisted any state. Instead, mark this wave's approved tasks (and every remaining task)
    // blocked/failed and still return a COMPLETE result object.
    try {
      const wmerged = await mergeWave(waveCfg, agent, approved)
      merged.push(...wmerged)
      wmerged.forEach((m) => {
        if (m.merged) { mergedOk.add(m.task); persist(m.task, 'integrated', { result: m }) }
        else persist(m.task, 'failed', { result: m })
      })
      baseBranch = execSync('git rev-parse HEAD', { cwd: cfg.integrationRepo ?? cfg.repo }).toString().trim()
    } catch (e) {
      const reason = `wave ${w + 1} merge/checkpoint failed: ${String(e?.message || e)}`
      log(`✗ ${reason}`)
      // This wave's approved tasks couldn't be merged → blocked. They are not in `failed`.
      for (const r of approved) {
        blocked.push({ task: r.task, reason })
        persist(r.task, 'blocked', { lastError: reason })
      }
      // Everything in later waves can no longer run → blocked too. Account for ALL of them.
      for (let rest = w + 1; rest < waves.length; rest++) {
        for (const t of waves[rest]) {
          blocked.push({ task: t.id, reason })
          persist(t.id, 'blocked', { lastError: reason })
        }
      }
      break
    }
  }
  } finally { stopHeartbeat() }
  // Real offload signals from the durable store — every attempt (including competition losers): how
  // many worker invocations ran and their total wall-clock. These are reliable (unlike worker token
  // self-reports, which most CLIs don't emit), so the report leads with them. A store-less run (mock
  // harness) falls back to 0 cleanly.
  let workerAttempts = 0, externalWallMs = 0
  const spentByCli = {}, attemptsByCli = {}   // ALL attempts incl. retries + competition losers
  if (cfg.store && cfg.runId) {
    try {
      const atts = cfg.store.getAttempts(cfg.runId)
      workerAttempts = atts.length
      externalWallMs = atts.reduce((sum, a) => sum + (a.duration_ms || 0), 0)
      for (const a of atts) {
        attemptsByCli[a.worker] = (attemptsByCli[a.worker] || 0) + 1
        spentByCli[a.worker] = (spentByCli[a.worker] || 0) + (a.input_tokens || 0) + (a.output_tokens || 0)
      }
    } catch { /* metrics are best-effort; never fail a run on them */ }
  }
  const routeUsage = computeRouteUsage(cfg, calibrationAtStart)
  // Per-CLI token breakdown for the report: "landed" = tokens for the attempt that produced each
  // task's final result (sums to externalTokens); "spent" = ALL attempts for that CLI (from the
  // store) incl. rejected retries and competition losers. spent − landed = the overhead the
  // retry/competition machinery cost on that CLI. Only CLIs that reported usage appear.
  const cliUsage = [...new Set([...Object.keys(landedByCli), ...Object.keys(spentByCli)])]
    .map((cli) => ({ cli, attempts: attemptsByCli[cli] || 0, landed: landedByCli[cli] || 0, spent: spentByCli[cli] || 0 }))
    .filter((u) => u.spent > 0 || u.landed > 0)
    .sort((a, b) => b.spent - a.spent || b.landed - a.landed)
  return {
    merged, failed, blocked, externalTokens, attempts,
    taskCount: cfg.tasks.length,
    workerAttempts, externalWallMs, cliUsage, routeUsage,
    tokenCoverage: { captured: tokensCaptured, total: tokenAttempts },
  }
}
