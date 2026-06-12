import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parallel, pipeline, makeLimiter } from './engine.mjs'

test('parallel resolves all and maps a throwing thunk to null', async () => {
  const r = await parallel([() => Promise.resolve(1), () => { throw new Error('x') }, async () => 3])
  assert.deepEqual(r, [1, null, 3])
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
