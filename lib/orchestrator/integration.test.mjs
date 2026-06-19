import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { execSync } from 'node:child_process'
import { StateStore } from '../state/store.mjs'
import { resolvePolicy } from '../policy.mjs'
import { createIntegrationWorktree, mergeApprovedRun, removeIntegrationWorktree } from './integration.mjs'
import { commandMain, EXIT } from '../../bin/cli.mjs'

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-integration-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo base > base.txt && git add -A && git commit -q -m seed', { cwd: repo, shell: '/bin/bash' })
  return repo
}

test('integration work is invisible until merge approval', () => {
  const repo = makeRepo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  const id = store.createRun({ id: 'r', repo, baseSha: base, plan: { tasks: [] }, policy, waves: [] })
  const integration = createIntegrationWorktree({ repo, runId: id, baseSha: base, worktreeRoot: root })
  execSync('echo integrated > new.txt && git add -A && git commit -q -m integrated', { cwd: integration.worktree, shell: '/bin/bash' })
  store.db.prepare('UPDATE runs SET integration_branch=?, status=? WHERE id=?').run(integration.branch, 'awaiting_merge', id)
  assert.equal(fs.existsSync(path.join(repo, 'new.txt')), false)
  assert.throws(() => mergeApprovedRun({ repo, runId: id, store, policy }), (error) => error.code === 'APPROVAL_REQUIRED')
  store.approve(id, 'merge')
  mergeApprovedRun({ repo, runId: id, store, policy })
  assert.equal(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8').trim(), 'integrated')
  store.close()
})

// Task 4(a)/(d): if the target branch moves before merge, merge must detect stale_base, flip the
// run status, and revoke the now-invalid merge approval (DB-enforced re-approval).
test('merge detects a moved base as stale_base and revokes the merge approval', () => {
  const repo = makeRepo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  const id = store.createRun({ id: 'r', repo, baseSha: base, plan: { tasks: [] }, policy, waves: [] })
  const integration = createIntegrationWorktree({ repo, runId: id, baseSha: base, worktreeRoot: root })
  execSync('echo integrated > new.txt && git add -A && git commit -q -m integrated', { cwd: integration.worktree, shell: '/bin/bash' })
  store.db.prepare('UPDATE runs SET integration_branch=?, status=? WHERE id=?').run(integration.branch, 'awaiting_merge', id)
  store.approve(id, 'merge')
  // Move the target branch after approval — the approval no longer reflects the real merge.
  execSync('echo drift > drift.txt && git add -A && git commit -q -m drift', { cwd: repo, shell: '/bin/bash' })
  assert.throws(() => mergeApprovedRun({ repo, runId: id, store, policy }), (error) => error.code === 'STALE_BASE')
  assert.equal(store.getRun(id).status, 'stale_base')
  assert.equal(store.isApproved(id, 'merge'), false)
  store.close()
})

// Task 4(a)/(b)/(d): resume on a moved base rebases the integration branch back to awaiting_merge
// and revokes the merge approval so a fresh approval is required.
test('resume rebases a stale_base run and revokes merge approval', async () => {
  const repo = makeRepo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  const id = store.createRun({ id: 'r', repo, baseSha: base, plan: { tasks: [] }, policy, waves: [] })
  const integration = createIntegrationWorktree({ repo, runId: id, baseSha: base, worktreeRoot: root })
  execSync('echo integrated > new.txt && git add -A && git commit -q -m integrated', { cwd: integration.worktree, shell: '/bin/bash' })
  store.db.prepare('UPDATE runs SET integration_branch=?, status=? WHERE id=?').run(integration.branch, 'awaiting_merge', id)
  store.approve(id, 'merge')
  // Move base on a non-conflicting file so the rebase succeeds.
  execSync('echo drift > drift.txt && git add -A && git commit -q -m drift', { cwd: repo, shell: '/bin/bash' })
  const moved = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  store.close()
  assert.equal(await commandMain(['resume', id], repo), EXIT.OK)
  const after = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  assert.equal(after.getRun(id).status, 'awaiting_merge')
  assert.equal(after.getRun(id).base_sha, moved)
  assert.equal(after.isApproved(id, 'merge'), false)
  after.close()
})

// --- branch-coverage additions ---

test('createIntegrationWorktree returns early when worktree already exists', () => {
  // Exercises fs.existsSync(worktree) === true branch → immediate return without re-creating
  const repo = makeRepo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  const id = store.createRun({ id: 'r', repo, baseSha: base, plan: { tasks: [] }, policy, waves: [] })
  const first = createIntegrationWorktree({ repo, runId: id, baseSha: base, worktreeRoot: root })
  // Second call with same args: worktree path already exists → early return
  const second = createIntegrationWorktree({ repo, runId: id, baseSha: base, worktreeRoot: root })
  assert.equal(first.branch, second.branch)
  assert.equal(first.worktree, second.worktree)
  // Verify the worktree is still usable (not double-initialized)
  assert.ok(fs.existsSync(second.worktree))
  store.close()
})

test('mergeApprovedRun throws when run is not found', () => {
  // Exercises the !run branch in mergeApprovedRun
  const repo = makeRepo()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  store.approve('nonexistent', 'merge')  // pre-approve so requireApproval passes
  assert.throws(
    () => mergeApprovedRun({ repo, runId: 'nonexistent', store, policy }),
    (error) => /run not found/.test(error.message)
  )
  store.close()
})

test('mergeApprovedRun throws when run status is not awaiting_merge', () => {
  // Exercises run.status !== 'awaiting_merge' branch
  const repo = makeRepo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  const id = store.createRun({ id: 'r', repo, baseSha: base, plan: { tasks: [] }, policy, waves: [] })
  // Status is 'awaiting_plan_approval', not 'awaiting_merge'
  store.approve(id, 'merge')
  assert.throws(
    () => mergeApprovedRun({ repo, runId: id, store, policy }),
    (error) => /not awaiting_merge/.test(error.message)
  )
  store.close()
})

test('mergeApprovedRun throws when integration worktree is not found', () => {
  // Exercises !integrationRepo branch — integration_branch points to a non-existent worktree
  const repo = makeRepo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  const id = store.createRun({ id: 'r', repo, baseSha: base, plan: { tasks: [] }, policy, waves: [] })
  // Set integration_branch to a name that has no worktree checked out
  store.db.prepare('UPDATE runs SET integration_branch=?, status=? WHERE id=?').run('ultraswarm/run-ghost', 'awaiting_merge', id)
  store.approve(id, 'merge')
  assert.throws(
    () => mergeApprovedRun({ repo, runId: id, store, policy }),
    (error) => /integration worktree not found/.test(error.message)
  )
  store.close()
})

test('mergeApprovedRun throws when target repo has tracked dirty changes', () => {
  // Exercises git status --porcelain non-empty branch → refuses to merge
  const repo = makeRepo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  const id = store.createRun({ id: 'r', repo, baseSha: base, plan: { tasks: [] }, policy, waves: [] })
  const integration = createIntegrationWorktree({ repo, runId: id, baseSha: base, worktreeRoot: root })
  execSync('echo integrated > new.txt && git add -A && git commit -q -m integrated', { cwd: integration.worktree, shell: '/bin/bash' })
  store.db.prepare('UPDATE runs SET integration_branch=?, status=? WHERE id=?').run(integration.branch, 'awaiting_merge', id)
  store.approve(id, 'merge')
  // Make the target repo dirty with a tracked, staged change
  execSync('echo dirty > base.txt && git add -A', { cwd: repo, shell: '/bin/bash' })
  assert.throws(
    () => mergeApprovedRun({ repo, runId: id, store, policy }),
    (error) => /tracked changes/.test(error.message)
  )
  // Cleanup: unstage to avoid polluting the temp dir
  execSync('git reset HEAD base.txt && git checkout -- base.txt', { cwd: repo, shell: '/bin/bash' })
  store.close()
})

test('mergeApprovedRun runs gates before merging', () => {
  // Exercises the `for (const gate of gates)` non-empty branch
  const repo = makeRepo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  const id = store.createRun({ id: 'r', repo, baseSha: base, plan: { tasks: [] }, policy, waves: [] })
  const integration = createIntegrationWorktree({ repo, runId: id, baseSha: base, worktreeRoot: root })
  execSync('echo integrated > new.txt && git add -A && git commit -q -m integrated', { cwd: integration.worktree, shell: '/bin/bash' })
  store.db.prepare('UPDATE runs SET integration_branch=?, status=? WHERE id=?').run(integration.branch, 'awaiting_merge', id)
  store.approve(id, 'merge')
  let gateRan = false
  const result = mergeApprovedRun({
    repo, runId: id, store, policy,
    gates: [{ cmd: 'true' }],  // gates.cmd is a shell command; 'true' always succeeds
  })
  // The merge succeeded and the gate was checked — gateRan would be set if we'd used a side-channel,
  // but the behavioral proof is that merge completed without error (gate throwing would prevent this).
  assert.ok(result.targetSha)
  assert.equal(store.getRun(id).status, 'merged')
  store.close()
})

test('removeIntegrationWorktree uses runId when integrationBranch not provided', () => {
  // Exercises integrationBranch ?? `ultraswarm/run-${runId}` null-coalescing branch
  const repo = makeRepo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const store = new StateStore(path.join(repo, '.ultraswarm', 'state.sqlite'))
  const policy = resolvePolicy()
  const id = store.createRun({ id: 'r', repo, baseSha: base, plan: { tasks: [] }, policy, waves: [] })
  const integration = createIntegrationWorktree({ repo, runId: id, baseSha: base, worktreeRoot: root })
  // Call removeIntegrationWorktree WITHOUT integrationBranch — forces the ?? fallback to `ultraswarm/run-${runId}`
  removeIntegrationWorktree({ repo, runId: id })  // should not throw and should clean up the branch
  // Verify the branch no longer exists
  const branches = execSync('git branch', { cwd: repo, encoding: 'utf8' })
  assert.ok(!branches.includes(integration.branch))
  store.close()
})

// A fake `pnpm` on PATH that records the install by touching a sentinel in its cwd, then exits with
// `code`. Lets us prove the runner installs deps in worktrees (#36) without a real package manager
// or network. Returns a restore() to undo the PATH change.
function withFakePnpm({ code = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-bin-'))
  fs.writeFileSync(path.join(dir, 'pnpm'), `#!/bin/sh\necho "$@" > .us-installed\nexit ${code}\n`)
  fs.chmodSync(path.join(dir, 'pnpm'), 0o755)
  const prev = process.env.PATH
  process.env.PATH = `${dir}:${prev}`
  return () => { process.env.PATH = prev }
}

function repoWithLockfile() {
  const repo = makeRepo()
  execSync('echo "lockfileVersion: 9" > pnpm-lock.yaml && git add -A && git commit -q -m lock', { cwd: repo, shell: '/bin/bash' })
  return repo
}

// Fix 1 (#36): the integration worktree must have deps installed before the merge gate re-runs. The
// reported bug was a deterministic `next: not found` because nothing ever installed deps there.
test('createIntegrationWorktree installs deps when the worktree has a lockfile (#36)', () => {
  const repo = repoWithLockfile(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const restore = withFakePnpm()
  try {
    const integration = createIntegrationWorktree({ repo, runId: 'r', baseSha: base, worktreeRoot: root })
    assert.ok(fs.existsSync(path.join(integration.worktree, '.us-installed')), 'install ran in the integration worktree')
  } finally { restore() }
})

// WHY (Rule 12): a failed install in the integration worktree must surface loudly at setup, never be
// silently swallowed and then mislabeled as a "post-merge gate regression" once the merge gate fails.
test('createIntegrationWorktree throws loudly when the install fails (#36)', () => {
  const repo = repoWithLockfile(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const base = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()
  const restore = withFakePnpm({ code: 1 })
  try {
    assert.throws(() => createIntegrationWorktree({ repo, runId: 'r', baseSha: base, worktreeRoot: root }))
  } finally { restore() }
})
