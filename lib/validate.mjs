import Ajv from 'ajv'
const ajv = new Ajv({ allErrors: true, strict: false })

export function validateOrThrow(object, schema) {
  const v = ajv.compile(schema)
  if (!v(object)) throw new Error(`schema validation failed: ${ajv.errorsText(v.errors)}`)
  return object
}

// rawComplete(feedback?) -> { object, usage }. Retries feeding the validation error back.
export async function completeWithSchema(rawComplete, { schema, maxRetries = 2 }) {
  let feedback = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { object, usage } = await rawComplete(feedback)
    try { validateOrThrow(object, schema); return { object, usage } }
    catch (e) { feedback = `Your previous output was invalid: ${e.message}. Return JSON matching the schema exactly.` }
  }
  return null
}
