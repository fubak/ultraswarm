import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { commandMain, detectGates, exitCode, EXIT } from './cli.mjs'

test('CLI exit codes distinguish failure classes', () => {
  assert.equal(exitCode({ code: 'USAGE' }), EXIT.USAGE)
  assert.equal(exitCode({ code: 'APPROVAL_REQUIRED' }), EXIT.APPROVAL)
  assert.equal(exitCode({ code: 'STALE_BASE' }), EXIT.BLOCKED)
  assert.equal(exitCode({}), EXIT.RUNTIME)
})

test('status initializes and reads an empty durable store', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-'))
  assert.equal(await commandMain(['status'], repo), EXIT.OK)
  assert.ok(fs.existsSync(path.join(repo, '.ultraswarm', 'state.sqlite')))
})

test('merge requires separate explicit approval', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-'))
  await assert.rejects(() => commandMain(['merge', 'r1'], repo), (error) => error.code === 'APPROVAL_REQUIRED')
})

test('detectGates selects conventional package scripts', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-'))
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'x', lint: 'y', deploy: 'z' } }))
  assert.deepEqual(detectGates(repo), [{ name: 'test', cmd: 'npm run test' }, { name: 'lint', cmd: 'npm run lint' }])
})
