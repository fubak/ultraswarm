import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { execSync } from 'node:child_process'
import { StateStore } from '../state/store.mjs'
import { resolvePolicy } from '../policy.mjs'
import { createIntegrationWorktree, mergeApprovedRun } from './integration.mjs'

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
