import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runImplementation, classifyWorkerError } from './implement.mjs'

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-impl-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed',
    { cwd: dir, shell: '/bin/bash' })
  return dir
}
const fakeCli = path.resolve('fixtures/fake-cli.mjs')

test('runImplementation: worktree + CLI + gates → ok, tokens parsed', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'present', cmd: 'test -f generated.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 't1', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'ok')
  assert.ok(r.files_changed.includes('generated.js'))
  assert.equal(r.gate_results[0].pass, true)
  assert.equal(r.cli_tokens, 1234)
})

test('runImplementation: failing gate → gates_failed', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'fail', cmd: 'test -f nope.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 't2', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'gates_failed')
})

test('classifyWorkerError tags auth / transport / not_installed / timeout / error (#8)', () => {
  assert.equal(classifyWorkerError({ message: 'Auth(AuthorizationRequired)' }), 'auth')
  assert.equal(classifyWorkerError({ stderr: 'Transport channel closed; MCP proxy error' }), 'transport')
  assert.equal(classifyWorkerError({ message: 'command not found: grok' }), 'not_installed')
  assert.equal(classifyWorkerError({ message: 'process timed out' }), 'timeout')
  assert.equal(classifyWorkerError({ message: 'some syntax problem' }), 'error')
})

test('runImplementation never THROWS on an unknown cli — returns a loud cli_failed (no silent loss, Finding #3)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot, gates: [], registry: {} }
  const t = { id: 't3', description: 'd', files: ['a.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  // 'notacli' isn't in DEFAULT_REGISTRY → resolveCommand throws internally; must be caught → cli_failed
  const r = await runImplementation(cfg, t, 'notacli', 1, [])
  assert.equal(r.status, 'cli_failed')
  assert.ok(typeof r.summary === 'string' && r.summary.length > 0)
})
