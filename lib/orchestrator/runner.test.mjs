import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runSwarm } from './runner.mjs'
import { MockLlmClient } from '../llm/client.mjs'

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-run-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed',
    { cwd: dir, shell: '/bin/bash' })
  return dir
}
const fakeCli = path.resolve('fixtures/fake-cli.mjs')

test('runSwarm: one routine task implements, passes review, MERGES to branch', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: { codex: `node ${fakeCli}` }, alternates: { codex: 'codex' },
    tasks: [{ id: 't1', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient((label) => label.startsWith('review')
    ? { object: { approve: true, issues: [], quality_score: 90, complexity_assessment: 10 }, usage: {} }
    : { object: {}, usage: {} })
  const result = await runSwarm(cfg, brain)
  assert.equal(result.merged.filter((m) => m.merged).length, 1)
  assert.ok(fs.existsSync(path.join(repo, 'generated.js')), 'approved file landed on the working branch')
})

test('runSwarm: review brain call uses resolved model id, not tier label', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: { codex: `node ${fakeCli}` }, alternates: { codex: 'codex' },
    tasks: [{ id: 't3', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient((label) => label.startsWith('review')
    ? { object: { approve: true, issues: [], quality_score: 90, complexity_assessment: 10 }, usage: {} }
    : { object: {}, usage: {} })
  await runSwarm(cfg, brain)
  const calls = brain.calls.filter(c => c.label?.startsWith('review'))
  assert.ok(calls.length > 0, 'at least one review call must be made')
  assert.equal(calls[0].model, 'claude-haiku-4-5', 'tier label must be resolved to a real model id before hitting the brain')
  assert.notEqual(calls[0].model, 'haiku', 'raw tier label must NOT reach the brain')
})

test('runSwarm: review rejection 3x → task tombstones, nothing merges', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: { codex: `node ${fakeCli}` }, alternates: { codex: 'codex' },
    tasks: [{ id: 't2', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient(() => ({ object: { approve: false, issues: ['bad'], quality_score: 10, complexity_assessment: 0 }, usage: {} }))
  const result = await runSwarm(cfg, brain)
  assert.deepEqual(result.failed, ['t2'])
  assert.equal(result.merged.length, 0)
})

test('runSwarm resolves the DOCUMENTED config shape (overrides, NO registry) and merges (#6 seam)', async () => {
  // This is the seam that silently broke in v2.4.0: bin assembled an empty registry and the
  // implement path never used resolveRoute(overrides). A config with `overrides` (no `registry`)
  // must resolve to the worker command and run end-to-end.
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    enabled: ['codex'], overrides: { codex: { invocation: `node ${fakeCli}` } }, alternates: { codex: 'codex' },
    tasks: [{ id: 't1', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient((label) => label.startsWith('review')
    ? { object: { approve: true, issues: [], quality_score: 90, complexity_assessment: 10 }, usage: {} }
    : { object: {}, usage: {} })
  const result = await runSwarm(cfg, brain)
  assert.equal(result.merged.filter((m) => m.merged).length, 1, 'overrides-config task merged')
  assert.ok(fs.existsSync(path.join(repo, 'generated.js')))
})

test('runSwarm: a no-op worker (no file changes) never reaches review or merge (#9)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [],
    registry: { codex: 'true' }, alternates: { codex: 'codex' },  // 'true' exits 0, changes nothing
    tasks: [{ id: 'n', description: 'd', files: ['x.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  // brain would APPROVE — but the no_changes gate must short-circuit before any review call
  const brain = new MockLlmClient(() => ({ object: { approve: true, issues: [], quality_score: 99, complexity_assessment: 10 }, usage: {} }))
  const result = await runSwarm(cfg, brain)
  assert.equal(result.merged.filter((m) => m.merged).length, 0, 'a no-op must not merge')
  assert.deepEqual(result.failed, ['n'])
  assert.equal(brain.calls.filter((c) => c.label?.startsWith('review')).length, 0, 'reviewer is never called for a no-op')
})

test('runSwarm: a dependent of a failed task is BLOCKED, never run blind (#10)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: { codex: `node ${fakeCli}` }, alternates: { codex: 'codex' },
    tasks: [
      { id: 'a', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple', complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' },
      { id: 'b', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple', complexity_score: 10, risk: 'routine', dependencies: ['a'], prompt: 'go' },
    ] }
  // reject every review → 'a' exhausts and fails; 'b' depends on 'a' and must be blocked, not run
  const brain = new MockLlmClient(() => ({ object: { approve: false, issues: ['bad'], quality_score: 10, complexity_assessment: 0 }, usage: {} }))
  const result = await runSwarm(cfg, brain)
  assert.deepEqual(result.failed, ['a'])
  assert.equal(result.blocked.length, 1)
  assert.equal(result.blocked[0].task, 'b')
  assert.match(result.blocked[0].reason, /dependency a/)
  assert.equal(result.merged.filter((m) => m.merged).length, 0)
})

test('runSwarm: concurrent workers never exceed policy.maxParallelWorkers', async () => {
  // Wiring proof: the limiter is built from policy and threaded into the leaf worker invocation.
  // Four independent routine tasks in one wave, cap of 2 → peak live workers must be exactly 2.
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  let active = 0, peak = 0
  const workerManager = {
    get: () => ({
      // Each task writes its OWN file so the four squash-merges are independent (no conflicts) —
      // keeps the test focused on the concurrency cap, not on merge behavior.
      execute: async ({ task, cwd }) => {
        active++; peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 25))
        fs.writeFileSync(path.join(cwd, `${task.id}.js`), 'export const x = 1\n')
        active--
        return { code: 0, stdout: 'tokens used: 1', stderr: '', durationMs: 25, usage: {} }
      },
      classifyFailure: () => 'error',
    }),
  }
  const mkTask = (id) => ({ id, description: 'd', files: [`${id}.js`], cli: 'codex', model_tier: 'simple',
    complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' })
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [],
    registry: { codex: 'unused-supervised' }, alternates: { codex: 'codex' },
    workerManager, policy: { maxParallelWorkers: 2 },
    tasks: [mkTask('w1'), mkTask('w2'), mkTask('w3'), mkTask('w4')] }
  const brain = new MockLlmClient((label) => label.startsWith('review')
    ? { object: { approve: true, issues: [], quality_score: 90, complexity_assessment: 10 }, usage: {} }
    : { object: {}, usage: {} })
  await runSwarm(cfg, brain)
  assert.ok(peak <= 2, `peak live workers ${peak} must not exceed maxParallelWorkers=2`)
  assert.equal(peak, 2, `4 independent tasks should saturate the cap (peak was ${peak})`)
})

test('runSwarm: a HIGH-RISK task runs competition+judge+lenses with an overrides config and merges (#6/#13)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    enabled: ['codex', 'grok'],
    overrides: { codex: { invocation: `node ${fakeCli}` }, grok: { invocation: `node ${fakeCli}` } },
    alternates: { codex: 'grok', grok: 'codex' },
    tasks: [{ id: 'h', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'complex',
      complexity_score: 80, risk: 'high', dependencies: [], prompt: 'go' }] }  // risk high → competition path
  const brain = new MockLlmClient((label) => {
    if (label.startsWith('judge')) return { object: { score: 8, rationale: 'r', graft_ideas: [], complexity_handling: 8, model_efficiency: 8, code_quality: 8 }, usage: {} }
    if (label.startsWith('verify')) return { object: { refuted: false, reasons: [], confidence: 90, severity: 'low' }, usage: {} }
    return { object: { approve: true, issues: [], quality_score: 90, complexity_assessment: 80 }, usage: {} }
  })
  const result = await runSwarm(cfg, brain)
  assert.equal(result.merged.filter((m) => m.merged).length, 1, 'high-risk task competed, was judged + verified, and merged')
  assert.ok(brain.calls.some((c) => c.label?.startsWith('judge')), 'a judge ran (competition happened, not an instant tombstone)')
  assert.ok(brain.calls.some((c) => c.label?.startsWith('verify')), 'adversarial lenses ran')
})

test('runSwarm: a HIGH-RISK task whose workers fail with NO alternate tombstones cleanly — no crash (#13)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    enabled: ['codex'], overrides: { codex: { invocation: 'false' } }, alternates: {},  // worker fails, NO alternate
    tasks: [{ id: 'h', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'complex',
      complexity_score: 80, risk: 'high', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient(() => ({ object: {}, usage: {} }))
  const result = await runSwarm(cfg, brain)  // must NOT throw 'CLI name must be a non-empty string'
  assert.deepEqual(result.failed, ['h'])
  assert.equal(result.merged.length, 0)
})

test('runSwarm: a dependent of a FAILED high-risk task is blocked across waves; every task is accounted for (#14)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    enabled: ['codex'], overrides: { codex: { invocation: 'false' } }, alternates: {},
    tasks: [
      { id: 'h', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'complex', complexity_score: 80, risk: 'high', dependencies: [], prompt: 'go' },
      { id: 'd', description: 'd', files: ['other.js'], cli: 'codex', model_tier: 'simple', complexity_score: 10, risk: 'routine', dependencies: ['h'], prompt: 'go' },
    ] }
  const brain = new MockLlmClient(() => ({ object: {}, usage: {} }))
  const result = await runSwarm(cfg, brain)
  assert.deepEqual(result.failed, ['h'])
  assert.equal(result.blocked.length, 1)
  assert.equal(result.blocked[0].task, 'd')
  const accounted = new Set([...result.merged.map((m) => m.task), ...result.failed, ...result.blocked.map((b) => b.task)])
  assert.ok(accounted.has('h') && accounted.has('d'), 'every task appears in the final result (#14 report completeness)')
})
