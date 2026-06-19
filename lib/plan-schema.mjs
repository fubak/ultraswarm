import Ajv from 'ajv'
import { buildRegistry } from './router.mjs'
import { VALID_MODEL_TIERS, VALID_EFFORTS } from './prompts.mjs'

const ajv = new Ajv({ allErrors: true, strict: false })

export const PLAN_SCHEMA = {
  type: 'object',
  required: ['tasks'],
  properties: {
    tasks: { type: 'array', minItems: 1, items: {
      type: 'object',
      required: ['id', 'description', 'files', 'complexity_score', 'risk', 'dependencies', 'prompt'],
      properties: {
        id: { type: 'string' }, description: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        cli: { type: 'string' }, model_tier: { type: 'string' }, effort: { type: 'string' },
        complexity_score: { type: 'number' }, risk: { type: 'string' },
        dependencies: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' },
        competition: { type: 'boolean' },
        requirements: { type: 'array', items: { type: 'string' } },
        contract: {
          type: 'object',
          properties: {
            commands: { type: 'array', items: { type: 'string', minLength: 1 } },
            assertions: { type: 'array', items: { type: 'string', minLength: 1 } },
            allowed_paths: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    } },
  },
  additionalProperties: false,
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

export function validatePlan(plan, config = {}) {
  const errors = []
  const registry = buildRegistry(config)   // built-ins + user-defined aliases
  const validate = ajv.compile(PLAN_SCHEMA)
  if (!validate(plan)) return { valid: false, errors: [ajv.errorsText(validate.errors)] }
  for (const t of plan.tasks) {
    if (!/^[A-Za-z0-9._-]+$/.test(t.id) || t.id.startsWith('-'))
      errors.push(`task "${t.id}": id must match [A-Za-z0-9._-] and not start with '-'`)
    if (t.cli !== undefined && !Object.hasOwn(registry, t.cli)) errors.push(`task ${t.id}: unknown cli "${t.cli}"`)
    if (t.model_tier !== undefined && !VALID_MODEL_TIERS.includes(t.model_tier)) errors.push(`task ${t.id}: invalid model_tier "${t.model_tier}"`)
    if (t.effort !== undefined && !VALID_EFFORTS.includes(t.effort)) errors.push(`task ${t.id}: invalid effort "${t.effort}"`)
    for (const file of [...(t.files || []), ...(t.contract?.allowed_paths || [])]) {
      if (file.startsWith('/') || file.split('/').includes('..')) errors.push(`task ${t.id}: unsafe path "${file}"`)
    }
    if ((t.contract?.commands || []).some((command) => command.includes('\n'))) errors.push(`task ${t.id}: contract commands must be single-line`)
    // Contract commands run via /bin/bash (implement.mjs) and, on the --decompose path, are
    // LLM-generated — so reject shell metacharacters that enable injection (e.g. "npm test; rm -rf ~").
    // Plain `npm run x` / `vitest run src/` style commands still pass. Newline is handled above. (#SE1)
    const SHELL_META = /[;|&$`><()]/
    for (const command of t.contract?.commands || []) {
      if (SHELL_META.test(command)) errors.push(`task ${t.id}: contract command contains shell metacharacters (not allowed): ${JSON.stringify(command)}`)
    }
  }
  if (hasCycle(plan.tasks)) errors.push('dependency cycle detected in the task graph')
  return { valid: errors.length === 0, errors }
}
