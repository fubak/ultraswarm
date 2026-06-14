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

test('buildReport with zero tasks yields 0% success and no tokenCoverage suffix', () => {
  // WHY: line 11 `total > 0` false branch → pct stays 0. Line 12 `tokenCoverage` false branch
  // (no coverage object) → no " (captured …)" suffix. Both branches uncovered by existing tests.
  const r = buildReport({})
  assert.match(r, /0\/0 merged/)
  assert.match(r, /0% success/)
  assert.doesNotMatch(r, /captured/)
  // External tokens defaults to 0.
  assert.match(r, /~0$/)
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

test('cleanup inner catch: swallows error when worktree remove fails (locked worktree)', () => {
  // WHY: line 25 inner `catch { /* best-effort */ }` is only taken when git worktree remove
  // throws. git worktree lock prevents removal even with --force, reliably triggering the catch.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-lock-'))
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-lock-wt-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed',
    { cwd: repo, shell: '/bin/bash' })
  const wt = path.join(wtRoot, 'myrepo-us-t2-codex')
  execFileSync('git', ['worktree', 'add', wt, '-b', 'ultraswarm/t2-codex', 'HEAD'], { cwd: repo })
  // Lock the worktree — git worktree remove --force will fail; inner catch must swallow it.
  execFileSync('git', ['worktree', 'lock', wt], { cwd: repo })
  // cleanup() must not throw despite the inner worktree remove failure.
  assert.doesNotThrow(() => cleanup({ repo, repoName: 'myrepo' }))
})

test('cleanup inner catch: swallows error when branch delete fails (branch checked out in worktree)', () => {
  // WHY: line 32 inner `catch { /* best-effort */ }` is only taken when `git branch -D` throws.
  // A branch that is currently checked out in a worktree cannot be deleted; this reliably
  // triggers the catch without touching the outer try/catch.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-bd-'))
  const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-bd-wt-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed',
    { cwd: repo, shell: '/bin/bash' })
  // Create a worktree that checks out an ultraswarm/* branch directly (branch IS the worktree HEAD).
  const wt = path.join(wtRoot, 'other-us-t3-codex')
  execFileSync('git', ['worktree', 'add', wt, '-b', 'ultraswarm/t3-codex', 'HEAD'], { cwd: repo })
  // Verify the branch exists in the branch list before cleanup.
  assert.match(execFileSync('git', ['branch', '--list', 'ultraswarm/*'], { cwd: repo, encoding: 'utf8' }), /ultraswarm\/t3-codex/)
  // cleanup uses repoName='other' so it skips the worktree remove (repoName-us- pattern won't match
  // 'other-us-'), but the branch listing still picks up ultraswarm/t3-codex and tries -D.
  // Since the branch is checked out in the worktree, -D fails → inner catch swallows it.
  assert.doesNotThrow(() => cleanup({ repo, repoName: 'norepo' }))
})

test('cleanup outer catch: swallows error when repo is not a git directory', () => {
  // WHY: line 35 outer `catch { /* cleanup is best-effort; never fail the run on it */ }` is
  // taken when `git worktree list --porcelain` itself fails (e.g. cwd is not a git repo).
  // cleanup() must never throw regardless of what goes wrong inside.
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-notgit-'))
  assert.doesNotThrow(() => cleanup({ repo: notARepo, repoName: 'myrepo' }))
})
