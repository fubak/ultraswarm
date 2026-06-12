import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runImplementation } from './implement.mjs'

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
