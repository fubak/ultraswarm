import { completeWithSchema } from '../validate.mjs'
import { PLAN_SCHEMA } from '../plan-schema.mjs'
import { VALID_MODEL_TIERS, VALID_EFFORTS, DEFAULT_EFFORT } from '../prompts.mjs'
import { buildRegistry } from '../router.mjs'

// Aggregate worker_metrics rows (per cli, per task_class) into a single runs/passes total per CLI,
// so the roster line can show one measured win rate regardless of how many task classes it covers.
function aggregateMetrics(metrics) {
  const byCli = {}
  for (const row of metrics) {
    const agg = (byCli[row.worker] ??= { runs: 0, passes: 0 })
    agg.runs += row.runs
    agg.passes += row.passes
  }
  return byCli
}

function rosterFor(registry, metrics = []) {
  const byCli = aggregateMetrics(metrics)
  return Object.entries(registry)
    .map(([cli, r]) => {
      const agg = byCli[cli]
      const track = agg && agg.runs > 0 ? `; track record: ${agg.runs} runs, ${Math.round((agg.passes / agg.runs) * 100)}% pass` : ''
      return `${cli} (${r.specialty}${r.maxTier ? `; max tier: ${r.maxTier}` : ''}${track})`
    })
    .join('; ')
}

function tierFromComplexity(score) {
  const n = Number(score)
  if (!Number.isFinite(n) || n <= 20) return 'simple'
  if (n <= 50) return 'moderate'
  if (n <= 100) return 'complex'
  return 'expert'
}

// Coerce a brain-produced task to valid runner values. Brains often emit a Claude model name
// (e.g. "haiku") for model_tier, or "low"/"medium" for risk; the runner's vocabulary is
// model_tier ∈ {simple,moderate,complex,expert} and risk ∈ {routine,high}. Belt-and-suspenders
// on top of the explicit prompt so the bare-shell --decompose path always yields a valid plan.
export function normalizeTask(t) {
  const model_tier = VALID_MODEL_TIERS.includes(t.model_tier) ? t.model_tier : tierFromComplexity(t.complexity_score)
  const risk = t.risk === 'high' ? 'high' : 'routine'
  const effort = VALID_EFFORTS.includes(t.effort) ? t.effort : DEFAULT_EFFORT
  return { ...t, model_tier, risk, effort }
}

export function normalizePlan(plan) {
  return plan && Array.isArray(plan.tasks) ? { ...plan, tasks: plan.tasks.map(normalizeTask) } : plan
}

// Bare-shell fallback ONLY: single brain call, no repo exploration. Hosts should pass --plan-file.
export async function decompose(brain, task, repo, model, config = {}, metrics = []) {
  const registry = buildRegistry(config)
  const roster = rosterFor(registry, metrics)
  const prompt = `Decompose this task into atomic, independent subtasks for external coding CLIs.
TASK: ${task}
REPO: ${repo}

Return JSON: {"tasks":[{id, description, files, cli, model_tier, effort, complexity_score, risk, dependencies, prompt}]}
Use EXACTLY these field vocabularies:
- id: short slug, [A-Za-z0-9._-] only (e.g. "t1", "add-util").
- files: array of repo-relative paths the task will create or modify.
- cli: ONE of: ${Object.keys(registry).join(', ')}. Choose by specialty — ${roster}.
- complexity_score: integer 1-150 (1-20 trivial, 21-50 moderate, 51-100 complex, 101+ expert).
- model_tier: ONE of: simple, moderate, complex, expert. This is NOT a Claude model name — match it to complexity: <=20 simple, <=50 moderate, <=100 complex, else expert.
- effort: ONE of off, low, medium, high. DEFAULT to "low" — most tasks produce the same result at low effort, far cheaper and faster. Use "medium" for moderate logic, and reserve "high" only for genuinely hard reasoning, architecture, or security work. Effort is independent of model_tier.
- risk: ONE of: routine, high. Use "high" ONLY for auth/security/payments, shared interfaces/data models, or architectural change; everything else is routine.
- dependencies: array of other task ids that must complete first (usually []).
- prompt: a self-contained instruction for the coding CLI — it has no other context about the repo or task.`
  const r = await completeWithSchema(
    (fb) => brain.complete({ model, schema: PLAN_SCHEMA, prompt: fb ? `${prompt}\n\n${fb}` : prompt }),
    { schema: PLAN_SCHEMA, maxRetries: 2 })
  return r ? normalizePlan(r.object) : null
}
