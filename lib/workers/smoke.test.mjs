import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { smokeTest, SMOKE_FILE } from './smoke.mjs'

// A fake adapter whose execute() simulates a worker run. `behavior(cwd)` may write the artifact,
// return a supervised-style result, or throw — exactly the shapes smokeTest must classify.
const fakeAdapter = (name, behavior) => ({
  name,
  classifyFailure: (r) => (/auth|unauthorized/.test(`${r?.stderr} ${r?.stdout}`) ? 'auth' : 'error'),
  execute: async ({ cwd }) => behavior(cwd),
})

test('smokeTest: functional when the worker writes the artifact (verify by artifact, not exit code)', async () => {
  // A noisy worker (grok-style) can exit non-zero yet still write the file; the artifact wins.
  const adapter = fakeAdapter('writer', (cwd) => { fs.writeFileSync(path.join(cwd, SMOKE_FILE), 'OK'); return { code: 1, stdout: 'ERROR noise', stderr: '' } })
  const r = await smokeTest(adapter)
  assert.equal(r.functional, true)
  assert.equal(r.kind, null)
  assert.equal(r.name, 'writer')
})

test('smokeTest: no_op when the worker exits clean but writes nothing (dead-auth-that-exits-0)', async () => {
  // This is the gemini-style failure the whole feature exists to catch: passes --version, runs, but
  // never actually produces a file.
  const adapter = fakeAdapter('noop', () => ({ code: 0, stdout: 'I would create the file…', stderr: '' }))
  const r = await smokeTest(adapter)
  assert.equal(r.functional, false)
  assert.equal(r.kind, 'no_op')
})

test('smokeTest: classifies a thrown launch failure (auth) and stays non-functional', async () => {
  const adapter = fakeAdapter('dead', () => { throw new Error('Error: unauthorized — please login') })
  const r = await smokeTest(adapter)
  assert.equal(r.functional, false)
  assert.equal(r.kind, 'auth')
})

test('smokeTest: a non-zero exit with no artifact defers to the adapter classifier', async () => {
  const adapter = fakeAdapter('crash', () => ({ code: 1, stdout: '', stderr: 'unauthorized token' }))
  const r = await smokeTest(adapter)
  assert.equal(r.functional, false)
  assert.equal(r.kind, 'auth')
})

test('smokeTest: removes its temp directory regardless of outcome', async () => {
  let seen
  const adapter = fakeAdapter('probe', (cwd) => { seen = cwd; return { code: 0 } })
  await smokeTest(adapter)
  assert.ok(seen, 'execute was invoked with a cwd')
  assert.equal(fs.existsSync(seen), false, 'the smoke temp dir is cleaned up')
})
