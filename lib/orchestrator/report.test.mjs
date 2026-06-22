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
  // tell the operator that codex (not the dead gemini) landed t1. The verb is "integrated" (not
  // "merged"): this run-end report is printed while still awaiting_merge, so the work is on the
  // integration branch, not the checked-out branch.
  assert.match(r, /\| t1 \| codex \| integrated ✓/)
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
  assert.match(r, /1\/3 integrated · 1 failed · 1 blocked \(33% success\)/)
  assert.match(r, /Workers that integrated: codex \(1\)/)
  assert.match(r, /across 1\/1 tasks that reported usage/)
  // WHY: t2 has 3 attempts but FAILED — its retries are implied by its FAILED row, so it must NOT
  // appear under "Retried before passing" (that line is only for tasks that eventually integrated).
  assert.doesNotMatch(r, /Retried before passing/)
})

test('buildReport with zero tasks yields 0% success, no coverage suffix, and a zero floor', () => {
  // WHY: total === 0 → pct stays 0. No tokenCoverage object → no "across …/… runs" suffix. The
  // tokens-saved floor still renders at 0 and must never claim a precise number.
  const r = buildReport({})
  assert.match(r, /0\/0 integrated/)
  assert.match(r, /0% success/)
  assert.doesNotMatch(r, /tasks that reported usage/)
  assert.match(r, /≈ 0 external CLI tokens/)
  // WHY: an empty run has no offload headline at all — never a misleading "≈ 0 tokens offloaded".
  assert.doesNotMatch(r, /tokens\*\* offloaded/)
})

test('buildReport leads with a verdict + tokens headline ABOVE the per-task table', () => {
  // WHY: "easy to read no matter how many agents are used" means the outcome and the savings must be
  // visible without scrolling a table that can run to dozens of rows on a large swarm. The headline
  // must therefore precede the table header, not sit below it in the Summary.
  const r = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }, { task: 'b', cli: 'grok', merged: true }],
    failed: ['c'], blocked: [{ task: 'd', reason: 'dep' }], externalTokens: 847200, taskCount: 4,
  })
  const headlineIdx = r.indexOf('2 of 4 tasks integrated')
  const tableIdx = r.indexOf('| task | worker |')
  assert.ok(headlineIdx > -1, 'a merged-count verdict is present')
  assert.ok(headlineIdx < tableIdx, 'the verdict headline precedes the per-task table')
  // WHY: the headline token figure is compact (847K, not 847,200) so it scans at a glance; the exact
  // count still appears in the Tokens-saved detail block below.
  assert.match(r, /≈ 847K tokens\*\* offloaded/)
  assert.match(r, /1 failed · 1 blocked/)
})

test('buildReport headline reads "All N merged" on a clean sweep and "nothing landed" on a wipeout', () => {
  // WHY: the verdict must read differently for full success vs total failure so "where ultraswarm
  // succeeded" is unambiguous — not just a percentage the operator has to interpret.
  const allOk = buildReport({ merged: [{ task: 'a', cli: 'codex', merged: true }], taskCount: 1 })
  // WHY: a single-task run must read "1 task" (singular), not the ungrammatical "1 tasks".
  assert.match(allOk, /✓ All 1 task integrated \(100%\)/)
  const wipeout = buildReport({ failed: ['a', 'b'], taskCount: 2 })
  assert.match(wipeout, /✗ 0 of 2 tasks integrated — nothing landed \(2 failed\)/)
  // WHY: a wipeout integrated nothing, so there is no staging line and no merge to approve.
  assert.doesNotMatch(wipeout, /Staged on this run/)
})

test('buildReport offload headline never overclaims: partial coverage is a floor, zero coverage is "not measurable"', () => {
  // WHY: externalTokens is a floor summed only from the CLIs that report usage. A bare "≈ N tokens"
  // hero badly understates the work when coverage is partial, and "≈ 0 tokens" is actively MISLEADING
  // when no worker reported at all (the real-world case: most CLIs emit no counts). The headline must
  // be only as precise as the data honestly supports (Rule 12).
  const partial = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }, { task: 'b', cli: 'opencode', merged: true },
      { task: 'c', cli: 'codex', merged: true }, { task: 'd', cli: 'codex', merged: true }],
    externalTokens: 21, taskCount: 4, tokenCoverage: { captured: 1, total: 4 },
  })
  // Floor framing: the "+" and the explicit ratio stop the reader treating 21 as the true total.
  assert.match(partial, /≈ 21\+ tokens\*\* offloaded to external CLIs — a floor: only 1 of 4 tasks reported usage/)

  const none = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }],
    externalTokens: 0, taskCount: 1, tokenCoverage: { captured: 0, total: 1 },
  })
  // No fabricated number when nothing was reported — state the offload happened but isn't measurable.
  assert.doesNotMatch(none, /≈ 0 tokens\*\* offloaded/)
  assert.match(none, /Implementation ran on external CLIs.*offload isn't measurable here/)

  const full = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }],
    externalTokens: 5000, taskCount: 1, tokenCoverage: { captured: 1, total: 1 },
  })
  // Full coverage → the plain figure, no floor caveat in the headline.
  assert.match(full, /≈ 5K tokens\*\* offloaded to external CLIs — Claude ran orchestration \+ QA only/)
  assert.doesNotMatch(full, /a floor: only/)
})

test('buildReport surfaces a retry only for a task that eventually integrated, with its attempt count', () => {
  // WHY: an "attempts: 2" cell is a silent mystery — the operator can't tell a clean first-try task
  // from one that was rejected and re-run. Naming the retried task (and that it failed gates/review
  // first) makes the extra attempt legible, mirroring what the live stream showed.
  const r = buildReport({
    merged: [{ task: 'clean', cli: 'codex', merged: true }, { task: 'flaky', cli: 'opencode', merged: true }],
    externalTokens: 10, attempts: { clean: 1, flaky: 2 }, taskCount: 2,
  })
  assert.match(r, /Retried before passing: flaky \(2 attempts\) — an earlier attempt failed gates or review\./)
  // A first-try task must NOT be listed as retried.
  assert.doesNotMatch(r, /clean \(1 attempts\)/)
})

test('buildReport adds the staging clarification whenever anything integrated', () => {
  // WHY: the single biggest source of confusion is reading "integrated" as "it's on my branch now".
  // One unmissable line between the headline and the table removes that ambiguity and points at the
  // merge-approval step the CLI prints next.
  const r = buildReport({ merged: [{ task: 'a', cli: 'codex', merged: true }], taskCount: 1 })
  const stagingIdx = r.indexOf('Staged on this run')
  const tableIdx = r.indexOf('| task | worker |')
  assert.ok(stagingIdx > -1 && stagingIdx < tableIdx, 'staging note sits above the per-task table')
  assert.match(r, /nothing lands on your checked-out branch until you approve the merge/)
})

test('buildReport headline accounts for every task, including a "not integrated" post-merge regression', () => {
  // WHY: a task can pass review yet regress at the integration gate (merged:false). If the headline
  // only counts failed + blocked, the numbers silently don't add up (2 integrated + 1 failed +
  // 1 blocked = 4, but total is 5). The operator must be able to reconcile the headline against the
  // total at a glance — every dropped task is named with its category.
  const r = buildReport({
    merged: [
      { task: 'a', cli: 'codex', merged: true },
      { task: 'b', cli: 'opencode', merged: true },
      { task: 'c', cli: 'codex', merged: false, reason: 'post-merge gate regression' },
    ],
    failed: ['d'], blocked: [{ task: 'e', reason: 'dep d did not land' }], taskCount: 5,
  })
  assert.match(r, /✓ 2 of 5 tasks integrated \(40%\) · 1 failed · 1 blocked · 1 not integrated/)
  assert.match(r, /\| c \| codex \| NOT integrated — post-merge gate regression/)
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
