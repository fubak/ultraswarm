import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parallel, pipeline, makeLimiter } from './engine.mjs'

test('parallel resolves all and maps a throwing thunk to null', async () => {
  const r = await parallel([() => Promise.resolve(1), () => { throw new Error('x') }, async () => 3])
  assert.deepEqual(r, [1, null, 3])
})

// #S5: a rejected parallel task is still mapped to null (correctness), but the error must be LOGGED
// rather than vanishing — otherwise a transport/auth failure in a lens/judge agent is invisible.
test('parallel logs a swallowed task error instead of dropping it silently (#S5)', async () => {
  const errs = []; const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (s) => (errs.push(String(s)), true)
  let r
  try { r = await parallel([() => { throw new Error('boom-xyz') }, () => Promise.resolve(1)]) }
  finally { process.stderr.write = orig }
  assert.deepEqual(r, [null, 1])
  assert.ok(errs.join('').includes('boom-xyz'), 'the swallowed error message must be logged')
})

test('pipeline runs each item through all stages, no barrier', async () => {
  assert.deepEqual(await pipeline([1, 2], (v) => v + 1, (v) => v * 10), [20, 30])
})

test('pipeline passes (prev, originalItem, index) — index correct for duplicate primitives', async () => {
  const r = await pipeline([2, 2], (_v, _item, idx) => idx)
  assert.deepEqual(r, [0, 1])   // indexOf would wrongly give [0, 0]
})

test('limiter caps concurrency', async () => {
  let active = 0, peak = 0
  const limit = makeLimiter(2)
  const job = () => limit(async () => { active++; peak = Math.max(peak, active)
    await new Promise(r => setTimeout(r, 5)); active--; return 1 })
  await Promise.all([job(), job(), job(), job()])
  assert.ok(peak <= 2, `peak ${peak} must be <= 2`)
})

test('pipeline maps a throwing stage to null (covers line-25 catch branch)', async () => {
  // WHY: line 25 `catch { return null }` — when any pipeline stage throws, the item maps to null
  // and processing stops for that item. Existing tests only cover the happy path. This verifies
  // the catch branch: throwing in stage 1 short-circuits stage 2 and yields null at that slot.
  const r = await pipeline(
    [1, 2, 3],
    (v) => { if (v === 2) throw new Error('stage-fail'); return v * 10 },
    (v) => v + 1,
  )
  assert.deepEqual(r, [11, null, 31])
})

test('makeLimiter(1) serialises even a single concurrent job', async () => {
  // WHY: covers the `active >= max` guard branch when max=1 — next() is called with active=1
  // and must enqueue rather than start immediately.
  const limit = makeLimiter(1)
  const order = []
  await Promise.all([
    limit(async () => { order.push('a'); await new Promise(r => setTimeout(r, 5)) }),
    limit(async () => { order.push('b') }),
  ])
  assert.deepEqual(order, ['a', 'b'])
})

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('DEADLOCK: timed out')), ms))])

// #O1: a wave task (pipeline) that itself calls parallel() — the high-risk/complex path
// (competition/judge/adversarial-QA) — must not deadlock. With ONE shared re-entrant limiter, the
// outer pipeline tasks hold every slot while awaiting inner parallel() work that can never acquire a
// slot. Using more items than the maximum possible cap (16) makes this deterministic on any machine.
test('nested parallel inside pipeline does not deadlock when items exceed the concurrency cap (#O1)', async () => {
  const N = 40   // > Math.min(16, cpus-2), so a shared limiter is fully saturated by outer tasks
  const result = await withTimeout(pipeline(Array.from({ length: N }, (_, i) => i), async (n) => {
    const inner = await parallel([() => Promise.resolve(n), () => Promise.resolve(1)])
    return inner[0] + inner[1]
  }), 5000)
  assert.equal(result.length, N)
  assert.equal(result[5], 6)   // 5 + 1
})
