import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { buildReport, cleanup } from './report.mjs'

test('buildReport summarizes merged, failed, and external tokens', () => {
  const r = buildReport({
    merged: [{ task: 't1', merged: true }, { task: 't2', merged: false, reason: 'post-merge gate regression' }],
    failed: ['t3'], externalTokens: 1234,
  })
  assert.match(r, /t1/); assert.match(r, /t3/); assert.match(r, /1234/)
  assert.match(r, /post-merge gate regression/)
})

test('buildReport renders blocked tasks, attempts, and a metrics summary (#10/#11)', () => {
  const r = buildReport({
    merged: [{ task: 't1', merged: true }],
    failed: ['t2'],
    blocked: [{ task: 't3', reason: 'dependency t2 did not merge' }],
    externalTokens: 500, attempts: { t1: 1, t2: 3 }, taskCount: 3,
    tokenCoverage: { captured: 1, total: 1 },
  })
  assert.match(r, /t3 \| blocked — dependency t2 did not merge/)
  assert.match(r, /Summary: 1\/3 merged · 1 failed · 1 blocked \(33% success\)/)
  assert.match(r, /captured 1\/1 runs/)
})

test('cleanup removes ultraswarm worktrees + branches from a throwaway repo (B2-partial)', () => {
  // WHY: cleanup() is the post-run teardown the CLI agent will wire in. It must actually remove the
  // us- worktrees and ultraswarm/* branches — asserting they're gone afterward proves the teardown,
  // not just that the function runs.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-'))
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-wt-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed',
    { cwd: repo, shell: '/bin/bash' })
  const wt = path.join(wtRoot, 'myrepo-us-t1-codex')
  execFileSync('git', ['worktree', 'add', wt, '-b', 'ultraswarm/t1-codex', 'HEAD'], { cwd: repo })
  // Sanity: the worktree + branch exist before cleanup.
  assert.match(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }), /myrepo-us-t1-codex/)
  assert.match(execFileSync('git', ['branch', '--list', 'ultraswarm/*'], { cwd: repo, encoding: 'utf8' }), /ultraswarm\/t1-codex/)

  cleanup({ repo, repoName: 'myrepo' })

  assert.doesNotMatch(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }), /myrepo-us-t1-codex/)
  assert.equal(execFileSync('git', ['branch', '--list', 'ultraswarm/*'], { cwd: repo, encoding: 'utf8' }).trim(), '')
})
