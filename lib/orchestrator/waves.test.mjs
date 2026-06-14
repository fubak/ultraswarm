import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeWaves } from './waves.mjs'
const t = (id, deps = []) => ({ id, dependencies: deps })

test('independent tasks form one wave', () => {
  assert.deepEqual(computeWaves([t('a'), t('b')]).map((w) => w.map((x) => x.id)), [['a', 'b']])
})

test('a→b→c forms three ordered waves', () => {
  assert.deepEqual(computeWaves([t('c', ['b']), t('a'), t('b', ['a'])]).map((w) => w.map((x) => x.id)),
    [['a'], ['b'], ['c']])
})

test('a cycle throws', () => {
  assert.throws(() => computeWaves([t('a', ['b']), t('b', ['a'])]), /cycle/)
})

test('task with no dependencies property at all is treated as independent (covers || [] branch)', () => {
  // WHY: line 5 `(t.dependencies || [])` — when `dependencies` is undefined (not just an empty
  // array), the `||` short-circuits to `[]`. The helper `t(id, deps=[])` always supplies `[]`,
  // so this branch was never taken. Build the object directly to omit the property.
  const r = computeWaves([{ id: 'x' }, { id: 'y', dependencies: ['x'] }])
  assert.deepEqual(r.map((w) => w.map((n) => n.id)), [['x'], ['y']])
})
