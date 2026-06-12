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
