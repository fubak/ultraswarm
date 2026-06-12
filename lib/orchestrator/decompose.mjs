import { completeWithSchema } from '../validate.mjs'
import { PLAN_SCHEMA } from '../plan-schema.mjs'
import { VALID_MODEL_TIERS } from '../prompts.mjs'
import { DEFAULT_REGISTRY } from '../../scripts/router.mjs'

const ROSTER = Object.entries(DEFAULT_REGISTRY).map(([cli, r]) => `${cli} (${r.specialty})`).join('; ')

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
  return { ...t, model_tier, risk }
}

export function normalizePlan(plan) {
  return plan && Array.isArray(plan.tasks) ? { ...plan, tasks: plan.tasks.map(normalizeTask) } : plan
}

// Bare-shell fallback ONLY: single brain call, no repo exploration. Hosts should pass --plan-file.
export async function decompose(brain, task, repo, model) {
  const prompt = `Decompose this task into atomic, independent subtasks for external coding CLIs.
TASK: ${task}
REPO: ${repo}

Return JSON: {"tasks":[{id, description, files, cli, model_tier, complexity_score, risk, dependencies, prompt}]}
Use EXACTLY these field vocabularies:
- id: short slug, [A-Za-z0-9._-] only (e.g. "t1", "add-util").
- files: array of repo-relative paths the task will create or modify.
- cli: ONE of: ${Object.keys(DEFAULT_REGISTRY).join(', ')}. Choose by specialty — ${ROSTER}.
- complexity_score: integer 1-150 (1-20 trivial, 21-50 moderate, 51-100 complex, 101+ expert).
- model_tier: ONE of: simple, moderate, complex, expert. This is NOT a Claude model name — match it to complexity: <=20 simple, <=50 moderate, <=100 complex, else expert.
- risk: ONE of: routine, high. Use "high" ONLY for auth/security/payments, shared interfaces/data models, or architectural change; everything else is routine.
- dependencies: array of other task ids that must complete first (usually []).
- prompt: a self-contained instruction for the coding CLI — it has no other context about the repo or task.`
  const r = await completeWithSchema(
    (fb) => brain.complete({ model, schema: PLAN_SCHEMA, prompt: fb ? `${prompt}\n\n${fb}` : prompt }),
    { schema: PLAN_SCHEMA, maxRetries: 2 })
  return r ? normalizePlan(r.object) : null
}
