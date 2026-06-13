import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { commandMain, detectGates, exitCode, EXIT, routePlan, requireNode22, cleanupPerTaskWorktrees } from './cli.mjs'
import { openRepoStore } from '../lib/state/store.mjs'
import { resolvePolicy } from '../lib/policy.mjs'

const captureLog = async (fn) => {
  const orig = console.log, lines = []
  console.log = (...a) => lines.push(a.join(' '))
  try { return { result: await fn(), out: lines.join('\n') } } finally { console.log = orig }
}

function seedRun(repo, { status = 'running', attemptStatus = 'running', pid = null } = {}) {
  const store = openRepoStore(repo)
  const runId = 'seed-run'
  store.createRun({ id: runId, repo, baseSha: 'base', plan: { tasks: [{ id: 't1' }] }, policy: resolvePolicy(), waves: [[{ id: 't1' }]] })
  store.setRunStatus(runId, status)
  const attemptId = store.startAttempt({ runId, taskId: 't1', number: 1, worker: 'codex', model: 'm', pid })
  if (attemptStatus !== 'running') store.finishAttempt(attemptId, { status: attemptStatus })
  store.close()
  return { runId, attemptId }
}

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

// Task 6: routePlan must BLOCK when fewer healthy workers than the policy minimum exist, instead of
// silently routing to dead workers.
test('routePlan throws BLOCKED when healthy workers are below the minimum', () => {
  const plan = { tasks: [{ id: 't1', description: 'd', files: ['a.txt'], complexity_score: 10, risk: 'low', dependencies: [], prompt: 'p' }] }
  const context = { config: { enabled: ['codex', 'gemini'] }, policy: { ...resolvePolicy(), minimumHealthyWorkers: 2 } }
  const manager = { probes: () => [{ name: 'codex', healthy: true }, { name: 'gemini', healthy: false }] }
  assert.throws(() => routePlan(plan, context, manager), (error) => error.code === 'BLOCKED' && /healthy/.test(error.message))
})

// Task 5: startup guard surfaces a clear message on pre-22 Node rather than a cryptic node:sqlite crash.
test('requireNode22 rejects old Node and accepts current', () => {
  assert.match(requireNode22('18.19.0'), /requires Node >= 22/)
  assert.match(requireNode22('20.11.1'), /requires Node >= 22/)
  assert.equal(requireNode22('22.0.0'), null)
  assert.equal(requireNode22(process.versions.node), null)
})

// Task 2: cancel must flip the run to cancelled AND mark running attempts not-running so a later
// cancel can't re-target dead pids.
test('cancel marks running attempts cancelled and sets run cancelled', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-'))
  const { runId, attemptId } = seedRun(repo, { status: 'running', attemptStatus: 'running', pid: null })
  assert.equal(await commandMain(['cancel', runId], repo), EXIT.OK)
  const store = openRepoStore(repo)
  assert.equal(store.getRun(runId).status, 'cancelled')
  const attempt = store.getAttempts(runId).find((a) => a.id === attemptId)
  assert.notEqual(attempt.status, 'running')
  assert.equal(attempt.status, 'cancelled')
  store.close()
})

// Task 3: export of an unknown run id must fail (USAGE), not exit 0 with run:null.
test('export of an unknown run id throws USAGE', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-'))
  await assert.rejects(() => commandMain(['export', 'nope'], repo), (error) => error.code === 'USAGE')
  assert.equal(exitCode({ code: 'USAGE' }), EXIT.USAGE)
})

// Task 3: export of a real run includes the full bundle, including approvals.
test('export of a seeded run includes run, tasks, attempts, events and approvals', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-'))
  const { runId } = seedRun(repo, { status: 'awaiting_merge', attemptStatus: 'passed', pid: null })
  const store = openRepoStore(repo); store.approve(runId, 'plan'); store.close()
  const { out } = await captureLog(() => commandMain(['export', runId], repo))
  const bundle = JSON.parse(out)
  assert.equal(bundle.run.id, runId)
  assert.ok(Array.isArray(bundle.tasks) && bundle.tasks.length >= 1)
  assert.ok(Array.isArray(bundle.attempts) && bundle.attempts.length >= 1)
  assert.ok(Array.isArray(bundle.events) && bundle.events.length >= 1)
  assert.ok(bundle.approvals.some((a) => a.gate === 'plan'))
})

// Task 1: after a run leaves cleanup, per-task ultraswarm/* worktrees + branches are gone.
test('cleanupPerTaskWorktrees removes per-task worktrees and branches but keeps integration', async () => {
  // Exercises the per-task cleanup path indirectly via a real git repo: create one per-task and one
  // integration worktree/branch, run the per-task cleanup, assert per-task gone + integration kept.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo b > b.txt && git add -A && git commit -q -m seed', { cwd: repo, shell: '/bin/bash' })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const name = path.basename(repo)
  const taskWt = path.join(root, `${name}-us-t1-codex`), intWt = path.join(root, `${name}-us-integration-seed-run`)
  execFileSync('git', ['worktree', 'add', taskWt, '-b', 'ultraswarm/t1-codex', 'HEAD'], { cwd: repo })
  execFileSync('git', ['worktree', 'add', intWt, '-b', 'ultraswarm/run-seed-run', 'HEAD'], { cwd: repo })
  cleanupPerTaskWorktrees(repo, 'seed-run')
  const branches = execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf8' })
  assert.ok(!branches.includes('ultraswarm/t1-codex'), 'per-task branch should be deleted')
  assert.ok(branches.includes('ultraswarm/run-seed-run'), 'integration branch should remain')
  assert.equal(fs.existsSync(taskWt), false)
  assert.equal(fs.existsSync(intWt), true)
})
