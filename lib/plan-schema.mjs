import Ajv from 'ajv'
import { DEFAULT_REGISTRY } from '../scripts/router.mjs'
import { VALID_MODEL_TIERS } from './prompts.mjs'

const ajv = new Ajv({ allErrors: true, strict: false })

export const PLAN_SCHEMA = {
  type: 'object',
  required: ['tasks'],
  properties: {
    tasks: { type: 'array', minItems: 1, items: {
      type: 'object',
      required: ['id', 'description', 'files', 'cli', 'model_tier', 'complexity_score', 'risk', 'dependencies', 'prompt'],
      properties: {
        id: { type: 'string' }, description: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        cli: { type: 'string' }, model_tier: { type: 'string' },
        complexity_score: { type: 'number' }, risk: { type: 'string' },
        dependencies: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' },
      },
    } },
  },
}

function hasCycle(tasks) {
  const ids = new Set(tasks.map((t) => t.id))
  const deps = new Map(tasks.map((t) => [t.id, (t.dependencies || []).filter((d) => ids.has(d))]))
  const state = new Map()   // id -> 'visiting' | 'done'
  const visit = (id) => {
    if (state.get(id) === 'done') return false
    if (state.get(id) === 'visiting') return true
    state.set(id, 'visiting')
    for (const d of deps.get(id) || []) if (visit(d)) return true
    state.set(id, 'done')
    return false
  }
  return tasks.some((t) => visit(t.id))
}

export function validatePlan(plan) {
  const errors = []
  const validate = ajv.compile(PLAN_SCHEMA)
  if (!validate(plan)) return { valid: false, errors: [ajv.errorsText(validate.errors)] }
  for (const t of plan.tasks) {
    if (!/^[A-Za-z0-9._-]+$/.test(t.id) || t.id.startsWith('-'))
      errors.push(`task "${t.id}": id must match [A-Za-z0-9._-] and not start with '-'`)
    if (!Object.hasOwn(DEFAULT_REGISTRY, t.cli)) errors.push(`task ${t.id}: unknown cli "${t.cli}"`)
    if (!VALID_MODEL_TIERS.includes(t.model_tier)) errors.push(`task ${t.id}: invalid model_tier "${t.model_tier}"`)
  }
  if (hasCycle(plan.tasks)) errors.push('dependency cycle detected in the task graph')
  return { valid: errors.length === 0, errors }
}
