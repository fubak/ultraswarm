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

test('runImplementation: worker writing a forbidden path → policy_blocked, no commit (B1)', async () => {
  // WHY: forbiddenPaths must be enforced against what the worker ACTUALLY wrote, independent of
  // task.files. The fake CLI writes .env (a default forbidden path) → must block before the success commit.
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const writesEnv = `node -e "require('fs').writeFileSync('.env','SECRET=1\\n');console.log('tokens used: 5')"`
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot, gates: [],
    policy: { forbiddenPaths: ['.env'] }, registry: { codex: writesEnv } }
  const t = { id: 'tb1', description: 'd', files: ['ok.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'policy_blocked')
  assert.match(r.summary, /forbidden path/)
  // No commit should have landed: the worktree was reset, so HEAD == base seed only.
  const log = execSync('git log --oneline', { cwd: r.worktree, shell: '/bin/bash', encoding: 'utf8' })
  assert.doesNotMatch(log, /ultraswarm: tb1/)
})

test('runImplementation: a policy-blocked attempt is finished, not left stuck at running', async () => {
  // WHY: startAttempt opens an attempt row; an early policy_blocked return must close it, or the row
  // stays 'running' forever and pollutes accounting / the crash-recovery heuristic.
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const started = [], finished = []; let nextId = 0
  const store = { totalCost: () => 0, recordMetric: () => {},
    startAttempt: (a) => { const id = ++nextId; started.push({ id, ...a }); return id },
    finishAttempt: (id, r) => finished.push({ id, ...r }) }
  const workerManager = { get: () => ({
    execute: async ({ cwd, onStart }) => { onStart({ pid: 4242, logPath: '/tmp/x.log' })
      fs.writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n')
      return { code: 0, stdout: 'tokens used: 5', stderr: '', durationMs: 3, usage: {} } },
    classifyFailure: () => 'error' }) }
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot, gates: [],
    policy: { forbiddenPaths: ['.env'] }, workerManager, store, runId: 'run1' }
  const t = { id: 'tb2', description: 'd', files: ['ok.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'policy_blocked')
  assert.equal(started.length, 1)
  assert.equal(finished.length, 1, 'the attempt row must be finished, not left running')
  assert.equal(finished[0].id, started[0].id)
  assert.equal(finished[0].errorKind, 'policy_blocked')
})

test('runImplementation: failed attempt resets the worktree clean for retry (HIGH)', async () => {
  // WHY: a crashed worker can leave partial files; the next attempt reuses the same worktree and must
  // start clean. CLI writes a partial file then exits non-zero → catch path must reset --hard + clean -fd.
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const crashes = `node -e "require('fs').writeFileSync('partial.js','// half-written\\n');process.exit(7)"`
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot, gates: [], registry: { codex: crashes } }
  const t = { id: 'th1', description: 'd', files: ['partial.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'cli_failed')
  // Worktree must be clean: no leftover partial file, no leftover prompt file.
  assert.equal(fs.existsSync(path.join(r.worktree, 'partial.js')), false)
  assert.equal(fs.existsSync(path.join(r.worktree, '.ultraswarm-prompt.txt')), false)
  const porcelain = execSync('git status --porcelain', { cwd: r.worktree, shell: '/bin/bash', encoding: 'utf8' })
  assert.equal(porcelain.trim(), '')
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
