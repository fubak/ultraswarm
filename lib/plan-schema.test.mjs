import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan } from './plan-schema.mjs'

const task = (over = {}) => ({ id: 't1', description: 'd', files: ['a.js'], cli: 'codex',
  model_tier: 'simple', complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go', ...over })

test('valid plan passes', () => {
  const r = validatePlan({ tasks: [task()] })
  assert.equal(r.valid, true)
  assert.deepEqual(r.errors, [])
})

test('unknown cli is rejected', () => {
  const r = validatePlan({ tasks: [task({ cli: 'rm -rf' })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /cli/.test(e)))
})

test('invalid model_tier is rejected', () => {
  assert.equal(validatePlan({ tasks: [task({ model_tier: 'mega' })] }).valid, false)
})

test('effort is optional but must be in the vocabulary when present', () => {
  const base = { id: 't1', description: 'd', files: ['a.js'], complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'p' }
  assert.equal(validatePlan({ tasks: [{ ...base, effort: 'high' }] }).valid, true)
  assert.equal(validatePlan({ tasks: [{ ...base }] }).valid, true)            // omitted is fine
  const bad = validatePlan({ tasks: [{ ...base, effort: 'turbo' }] })
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.includes('invalid effort "turbo"')))
})

test('a dependency cycle is rejected', () => {
  const r = validatePlan({ tasks: [task({ id: 'a', dependencies: ['b'] }), task({ id: 'b', dependencies: ['a'] })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /cycle/.test(e)))
})

test('a task id with shell metacharacters is rejected', () => {
  const r = validatePlan({ tasks: [task({ id: 't1; rm -rf ~' })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /id must match/.test(e)))
})

// --- branch-coverage additions ---

test('plan missing tasks key fails AJV schema', () => {
  // Exercises the !validate(plan) early-return branch with an AJV error
  const r = validatePlan({})
  assert.equal(r.valid, false)
  assert.ok(r.errors.length > 0)
})

test('plan with non-array tasks fails AJV schema', () => {
  // Exercises !validate(plan) branch — tasks must be array
  const r = validatePlan({ tasks: 'not-an-array' })
  assert.equal(r.valid, false)
  assert.ok(r.errors.length > 0)
})

test('plan with empty tasks array fails AJV minItems', () => {
  // Exercises !validate(plan) via minItems:1 — empty array is rejected
  const r = validatePlan({ tasks: [] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.length > 0)
})

test('task id starting with dash is rejected', () => {
  // Exercises t.id.startsWith('-') branch — distinct from the regex branch
  const r = validatePlan({ tasks: [task({ id: '-bad-id' })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /id must match/.test(e)))
})

test('task with no cli field is accepted (cli is optional)', () => {
  // Exercises t.cli !== undefined === false branch (cli absent)
  const base = { id: 't1', description: 'd', files: ['a.js'], complexity_score: 10, risk: 'low', dependencies: [], prompt: 'p' }
  const r = validatePlan({ tasks: [base] })
  assert.equal(r.valid, true)
})

test('task with no model_tier field is accepted (model_tier is optional)', () => {
  // Exercises t.model_tier !== undefined === false branch
  const base = { id: 't1', description: 'd', files: ['a.js'], complexity_score: 10, risk: 'low', dependencies: [], prompt: 'p' }
  const r = validatePlan({ tasks: [base] })
  assert.equal(r.valid, true)
})

test('absolute path in files is rejected', () => {
  // Exercises file.startsWith('/') branch
  const r = validatePlan({ tasks: [task({ files: ['/etc/passwd'] })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /unsafe path/.test(e)))
})

test('path traversal (..) in files is rejected', () => {
  // Exercises file.split('/').includes('..') branch
  const r = validatePlan({ tasks: [task({ files: ['../secret.txt'] })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /unsafe path/.test(e)))
})

test('contract allowed_paths with absolute path is rejected', () => {
  // Exercises the contract?.allowed_paths spread branch with an unsafe path
  const r = validatePlan({ tasks: [task({ contract: { allowed_paths: ['/root/secret'] } })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /unsafe path/.test(e)))
})

test('contract allowed_paths with path traversal is rejected', () => {
  // Exercises the contract?.allowed_paths spread branch with .. path
  const r = validatePlan({ tasks: [task({ contract: { allowed_paths: ['src/../outside'] } })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /unsafe path/.test(e)))
})

test('contract command with embedded newline is rejected', () => {
  // Exercises the contract.commands.some(command => command.includes('\n')) branch
  const r = validatePlan({ tasks: [task({ contract: { commands: ['echo hello\nrm -rf ~'] } })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /single-line/.test(e)))
})

test('contract with valid commands and assertions is accepted', () => {
  // Exercises contract present with all valid fields — contract?.commands || [] non-empty
  const r = validatePlan({ tasks: [task({ contract: { commands: ['npm test'], assertions: ['exit 0'], allowed_paths: ['src/'] } })] })
  assert.equal(r.valid, true)
})

test('hasCycle: single task with no dependencies has no cycle', () => {
  // Exercises visit() reaching state=done without ever hitting visiting
  const r = validatePlan({ tasks: [task({ id: 'a', dependencies: [] })] })
  assert.equal(r.valid, true)
})

test('hasCycle: diamond (shared dependency, no cycle) is accepted', () => {
  // Exercises state.get(id) === 'done' early-return in hasCycle when same node visited twice
  const a = { id: 'a', description: 'd', files: [], complexity_score: 1, risk: 'low', dependencies: [], prompt: 'p' }
  const b = { id: 'b', description: 'd', files: [], complexity_score: 1, risk: 'low', dependencies: ['a'], prompt: 'p' }
  const c = { id: 'c', description: 'd', files: [], complexity_score: 1, risk: 'low', dependencies: ['a'], prompt: 'p' }
  const d = { id: 'd', description: 'd', files: [], complexity_score: 1, risk: 'low', dependencies: ['b', 'c'], prompt: 'p' }
  const r = validatePlan({ tasks: [a, b, c, d] })
  assert.equal(r.valid, true)
})

test('hasCycle: self-referential dependency is rejected', () => {
  // Exercises the cycle detection when a task depends on itself
  const r = validatePlan({ tasks: [task({ id: 'a', dependencies: ['a'] })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /cycle/.test(e)))
})

test('plan with additional top-level property is rejected by AJV', () => {
  // Exercises !validate(plan) via additionalProperties: false at the top level
  const r = validatePlan({ tasks: [task()], extra: 'bad' })
  assert.equal(r.valid, false)
  assert.ok(r.errors.length > 0)
})
