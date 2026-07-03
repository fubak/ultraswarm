import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runImplementation, classifyWorkerError, allowedEnv } from './implement.mjs'

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-impl-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed',
    { cwd: dir, shell: '/bin/bash' })
  return dir
}
const fakeCli = path.resolve('fixtures/fake-cli.mjs')

test('runImplementation: worktree + CLI + gates → ok, no fabricated tokens', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'present', cmd: 'test -f generated.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 't1', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'ok')
  assert.ok(r.files_changed.includes('generated.js'))
  assert.equal(r.gate_results[0].pass, true)
  // WHY: cli_tokens reflects ONLY structured worker usage, never a free-text scrape. The fake CLI
  // prints a "tokens used: …" line in its output; that must NOT be scraped into a count (it was
  // noise). With no structured usage object, cli_tokens is 0. (Structured usage is covered below.)
  assert.equal(r.cli_tokens, 0)
})

test('runImplementation: failing gate → gates_failed', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'fail', cmd: 'test -f nope.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 't2', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'gates_failed')
})

// #SE4: the env passthrough used a `key.startsWith('XDG_')` wildcard, leaking any XDG_* var (e.g. a
// credential-dir override) to every worker CLI. Narrow it to the specific vars actually needed.
test('allowedEnv passes only named XDG vars, not the whole XDG_* namespace (#SE4)', () => {
  const saved = { c: process.env.XDG_CONFIG_HOME, s: process.env.XDG_SESSION_COOKIE }
  process.env.XDG_CONFIG_HOME = '/c'; process.env.XDG_SESSION_COOKIE = 'secret'
  try {
    const env = allowedEnv({})
    assert.equal(env.XDG_CONFIG_HOME, '/c', 'a needed XDG var passes through')
    assert.equal('XDG_SESSION_COOKIE' in env, false, 'an unlisted XDG var must NOT leak')
  } finally {
    if (saved.c === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.c
    if (saved.s === undefined) delete process.env.XDG_SESSION_COOKIE; else process.env.XDG_SESSION_COOKIE = saved.s
  }
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

// A fake `pnpm` on PATH (records the install via a sentinel, then exits with `code`). Proves the
// per-task worktree gets deps installed before gates without a real package manager (#36).
function withFakePnpm({ code = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-bin-'))
  fs.writeFileSync(path.join(dir, 'pnpm'), `#!/bin/sh\necho "$@" > .us-installed\nexit ${code}\n`)
  fs.chmodSync(path.join(dir, 'pnpm'), 0o755)
  const prev = process.env.PATH
  process.env.PATH = `${dir}:${prev}`
  return () => { process.env.PATH = prev }
}
function repoWithLockfile() {
  const dir = makeRepo()
  execSync('echo "lockfileVersion: 9" > pnpm-lock.yaml && git add -A && git commit -q -m lock', { cwd: dir, shell: '/bin/bash' })
  return dir
}

// Fix 1 (#36): installing deps in the per-task worktree makes the gate environment deterministic
// instead of depending on the worker incidentally running an install. Proves install ran AND the gate
// still passes, so the per-task "green" is no longer accidental.
test('runImplementation installs worktree deps before gates when a lockfile is present (#36)', async () => {
  const repo = repoWithLockfile(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'present', cmd: 'test -f generated.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 'td1', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const restore = withFakePnpm()
  try {
    const r = await runImplementation(cfg, t, 'codex', 1, [])
    assert.equal(r.status, 'ok')
    assert.ok(fs.existsSync(path.join(r.worktree, '.us-installed')), 'deps install ran in the per-task worktree')
  } finally { restore() }
})

// WHY (Rule 12): a failed worktree install must return a DISTINCT, loud status — not be mislabeled as
// gates_failed or a worker failure — so the operator sees an infra problem, not bad model output.
test('runImplementation surfaces a worktree install failure as a distinct deps_failed (#36)', async () => {
  const repo = repoWithLockfile(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'present', cmd: 'test -f generated.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 'td2', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const restore = withFakePnpm({ code: 1 })
  try {
    const r = await runImplementation(cfg, t, 'codex', 1, [])
    assert.equal(r.status, 'deps_failed')
    assert.match(r.summary, /install/i)
  } finally { restore() }
})

// #ST5: inputTokens was never recorded (the column was always null), and outputTokens read
// usage.totalTokens only — missing the common {input_tokens,output_tokens} shape. Record both, and
// pass the adapter's costUsd through unchanged.
test('finishAttempt records inputTokens + outputTokens from worker usage, passes costUsd through (#ST5)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const finished = []
  const store = { totalCost: () => 0, recordMetric: () => {}, startAttempt: () => 1, finishAttempt: (_id, r) => finished.push(r) }
  const workerManager = { get: () => ({
    execute: async ({ cwd, onStart }) => { onStart({ pid: 1, logPath: '/tmp/x' })
      fs.writeFileSync(path.join(cwd, 'generated.js'), '//x\n')
      return { code: 0, stdout: 'done', stderr: '', durationMs: 5, usage: { input_tokens: 1000, output_tokens: 2000, costUsd: 0.05 } } },
    classifyFailure: () => 'error' }) }
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: {}, workerManager, store, runId: 'r1', taskClasses: {} }
  const t = { id: 'tk', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(finished.length, 1)
  assert.equal(finished[0].inputTokens, 1000)
  assert.equal(finished[0].outputTokens, 2000)
  assert.equal(finished[0].costUsd, 0.05)
})

// WHY (Rule 12 / #S3): the per-task success commit was wrapped in an empty catch, so a genuinely
// failed commit was masked and the task still reported `ok` — leaving an empty branch that merges
// nothing while the task is reported integrated. A failed commit must surface loudly instead.
test('runImplementation surfaces a failed success-commit instead of reporting ok (#S3)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  // A pre-commit hook that always fails; worktrees share the repo's hooks, so the success commit fails.
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n'); fs.chmodSync(hook, 0o755)
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'present', cmd: 'test -f generated.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 'tcommit', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.notEqual(r.status, 'ok')
  assert.match(r.summary, /commit/i)
})

// v3.6: attempts carry the RESOLVED route (model id + tier + effort), not tier-as-model, so tokens
// are attributable per (cli, model, effort) in the report; measured usage feeds calibration.
test('startAttempt receives resolved model/tier/effort; structured usage feeds recordCalibration', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const started = [], calibrated = []
  const store = { totalCost: () => 0, recordMetric: () => {}, finishAttempt: () => {},
    startAttempt: (a) => { started.push(a); return 1 },
    recordCalibration: (c) => calibrated.push(c) }
  const workerManager = { get: () => ({
    execute: async ({ cwd, onStart }) => { onStart({ pid: 1, logPath: '/tmp/x' })
      fs.writeFileSync(path.join(cwd, 'generated.js'), '//x\n')
      return { code: 0, stdout: 'done', stderr: '', durationMs: 5, usage: { input_tokens: 700, output_tokens: 300 } } },
    classifyFailure: () => 'error' }) }
  // Modern path (empty legacy registry) → resolveRoute supplies the real model id per tier.
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot, gates: [],
    registry: {}, workerManager, store, runId: 'r1', taskClasses: {} }
  const t = { id: 'tk', description: 'd', files: ['generated.js'], model_tier: 'complex', effort: 'high', complexity_score: 80, prompt: 'go' }
  await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(started.length, 1)
  // WHY: before v3.6 the model column stored the TIER — tokens could never be attributed to a
  // model or effort level, which is the whole point of the closing report table.
  assert.equal(started[0].model, 'gpt-5.5')
  assert.equal(started[0].tier, 'complex')
  assert.equal(started[0].effort, 'high')
  assert.deepEqual(calibrated, [{ cli: 'codex', model: 'gpt-5.5', effort: 'high', tier: 'complex', tokens: 1000 }])
})

// v3.6: a FAILED attempt still burned tokens — its structured usage must land in the attempt row
// (so "spent" counts failures) and in calibration.
test('failed worker attempt records its structured usage tokens instead of dropping them', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const finished = [], calibrated = []
  const store = { totalCost: () => 0, recordMetric: () => {}, startAttempt: () => 7,
    finishAttempt: (_id, r) => finished.push(r), recordCalibration: (c) => calibrated.push(c) }
  const workerManager = { get: () => ({
    execute: async ({ onStart }) => { onStart({ pid: 1, logPath: '/tmp/x' })
      const err = Object.assign(new Error('worker exited 1'), { supervised: { code: 1, stdout: '', stderr: 'boom', durationMs: 9, usage: { input_tokens: 400, output_tokens: 100, totalTokens: 500, costUsd: null } } })
      throw err },
    classifyFailure: () => 'error' }) }
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot, gates: [],
    registry: {}, workerManager, store, runId: 'r1', taskClasses: {} }
  const t = { id: 'tk', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'cli_failed')
  assert.equal(finished.length, 1)
  assert.equal(finished[0].inputTokens, 400)
  assert.equal(finished[0].outputTokens, 100)
  assert.equal(calibrated[0].tokens, 500)
})
