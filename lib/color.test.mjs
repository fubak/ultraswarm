import { test } from 'node:test'
import assert from 'node:assert/strict'
import { c, colorizeLine } from './color.mjs'

const withEnv = (env, fn) => {
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR }
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  try { return fn() } finally {
    for (const k of ['NO_COLOR', 'FORCE_COLOR']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

test('color is OFF without a TTY (so piped/redirected output stays clean)', () => {
  // WHY: node --test is not a TTY; without FORCE_COLOR there must be NO escape codes, or every
  // report/stream assertion in the suite would have to account for ANSI noise.
  withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, () => {
    assert.equal(c.green('ok'), 'ok')
    assert.equal(colorizeLine('✔ approved'), '✔ approved')
  })
})

test('NO_COLOR wins even when FORCE_COLOR is set', () => {
  // WHY: NO_COLOR is the user's hard opt-out (no-color.org) and must override FORCE_COLOR.
  withEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }, () => assert.equal(c.red('x'), 'x'))
})

test('FORCE_COLOR=1 wraps in ANSI; colorizeLine picks the color by leading glyph', () => {
  withEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => {
    assert.equal(c.green('ok'), '\x1b[32mok\x1b[0m')
    assert.match(colorizeLine('✔ approved'), /^\x1b\[32m✔ approved\x1b\[0m$/)   // green
    assert.match(colorizeLine('✗ rejected'), /^\x1b\[31m/)                       // red
    assert.match(colorizeLine('↑ escalating'), /^\x1b\[33m/)                     // yellow
    assert.match(colorizeLine('⏱ active: …'), /^\x1b\[2m/)                       // dim
    assert.equal(colorizeLine('▶ dispatch'), '▶ dispatch')                       // no glyph match → unchanged
  })
})
