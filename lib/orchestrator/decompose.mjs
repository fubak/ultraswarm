import { completeWithSchema } from '../validate.mjs'
import { PLAN_SCHEMA } from '../plan-schema.mjs'

// Bare-shell fallback ONLY: single brain call, no repo exploration. Hosts should pass --plan-file.
export async function decompose(brain, task, repo, model) {
  const r = await completeWithSchema(
    (fb) => brain.complete({ model, schema: PLAN_SCHEMA,
      prompt: `Decompose into atomic, independent subtasks for external coding CLIs.\nTask: ${task}\nRepo: ${repo}\n` +
        `Return JSON {tasks:[{id,description,files,cli,model_tier,complexity_score,risk,dependencies,prompt}]}.${fb ? '\n' + fb : ''}` }),
    { schema: PLAN_SCHEMA, maxRetries: 2 })
  return r ? r.object : null
}
