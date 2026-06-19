import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { buildReport, cleanup } from './report.mjs'

test('buildReport summarizes merged, failed, the winning worker, and tokens saved', () => {
  const r = buildReport({
    merged: [{ task: 't1', cli: 'codex', merged: true }, { task: 't2', cli: 'grok', merged: false, reason: 'post-merge gate regression' }],
    failed: ['t3'], externalTokens: 1234,
  })
  assert.match(r, /t1/); assert.match(r, /t3/); assert.match(r, /1,?234/)
  assert.match(r, /post-merge gate regression/)
  // WHY: the worker column must surface WHICH CLI did the work — a per-task table without it can't
  // tell the operator that codex (not the dead gemini) landed t1.
  assert.match(r, /\| t1 \| codex \| merged ✓/)
  // WHY: the tokens-saved block is the headline value prop; it must be framed as an OFFLOAD estimate,
  // never a billing figure (Rule 12 — don't overclaim).
  assert.match(r, /Tokens saved/)
  assert.match(r, /off your Claude context/)
})

test('buildReport renders blocked tasks, attempts, per-worker contribution, and coverage (#10/#11)', () => {
  const r = buildReport({
    merged: [{ task: 't1', cli: 'codex', merged: true }],
    failed: ['t2'],
    blocked: [{ task: 't3', reason: 'dependency t2 did not merge' }],
    externalTokens: 500, attempts: { t1: 1, t2: 3 }, taskCount: 3,
    tokenCoverage: { captured: 1, total: 1 },
  })
  assert.match(r, /t3 \| — \| blocked — dependency t2 did not merge/)
  assert.match(r, /1\/3 merged · 1 failed · 1 blocked \(33% success\)/)
  assert.match(r, /Workers that merged: codex \(1\)/)
  assert.match(r, /across 1\/1 runs that report usage/)
})

test('buildReport with zero tasks yields 0% success, no coverage suffix, and a zero floor', () => {
  // WHY: total === 0 → pct stays 0. No tokenCoverage object → no "across …/… runs" suffix. The
  // tokens-saved floor still renders at 0 and must never claim a precise number.
  const r = buildReport({})
  assert.match(r, /0\/0 merged/)
  assert.match(r, /0% success/)
  assert.doesNotMatch(r, /runs that report usage/)
  assert.match(r, /≈ 0 external CLI tokens/)
})

test('cleanup deletes only THIS run\'s branches, not another run\'s (#SE2)', () => {
  // Per-task branches are ultraswarm/<taskId>-<cli> (not run-namespaced), so scope by this run's task
  // ids + its integration branch. A concurrent/paused other run's branches must survive.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-scope-'))
  const run = (c) => execSync(c, { cwd: repo, shell: '/bin/bash' })
  run('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed')
  run('git branch ultraswarm/t1-codex && git branch ultraswarm/run-OTHER && git branch ultraswarm/t2-other-run')
  cleanup({ repo, repoName: 'myrepo', runId: 'THIS', tasks: [{ id: 't1', cli: 'codex' }] })
  const branches = execFileSync('git', ['branch', '--list', 'ultraswarm/*'], { cwd: repo, encoding: 'utf8' })
  assert.doesNotMatch(branches, /t1-codex/, "this run's task branch is removed")
  assert.match(branches, /run-OTHER/, "another run's integration branch survives")
  assert.match(branches, /t2-other-run/, "another run's task branch survives")
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

  cleanup({ repo, repoName: 'myrepo', runId: 'r', tasks: [{ id: 't1', cli: 'codex' }] })

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
  // repoName='norepo' so the worktree remove is skipped (repoName-us- won't match 'other-us-'), but
  // task t3 IS in this run's plan, so cleanup tries to delete ultraswarm/t3-codex.
  // Since the branch is checked out in the worktree, -D fails → inner catch swallows it.
  assert.doesNotThrow(() => cleanup({ repo, repoName: 'norepo', runId: 'r', tasks: [{ id: 't3', cli: 'codex' }] }))
})

test('cleanup outer catch: swallows error when repo is not a git directory', () => {
  // WHY: line 35 outer `catch { /* cleanup is best-effort; never fail the run on it */ }` is
  // taken when `git worktree list --porcelain` itself fails (e.g. cwd is not a git repo).
  // cleanup() must never throw regardless of what goes wrong inside.
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-clean-notgit-'))
  assert.doesNotThrow(() => cleanup({ repo: notARepo, repoName: 'myrepo' }))
})
