import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { execSync } from 'node:child_process'
import { StateStore } from '../state/store.mjs'
import { resolvePolicy } from '../policy.mjs'
import { createIntegrationWorktree, mergeApprovedRun } from './integration.mjs'
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
