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
  assert.match(r, /t1/); assert.match(r, /t3/)
  assert.match(r, /post-merge gate regression/)
  // WHY: the worker column must surface WHICH CLI did the work — a per-task table without it can't
  // tell the operator that codex (not the dead gemini) landed t1. The verb is "integrated" (not
  // "merged"): this run-end report is printed while still awaiting_merge, so the work is on the
  // integration branch, not the checked-out branch.
  assert.match(r, /\| t1 \| codex \| integrated ✓/)
  // WHY: the value section reports the OFFLOAD, not a billing figure (Rule 12). A worker-reported
  // token figure (externalTokens > 0, here 1234) appears in the "Work offloaded" section.
  assert.match(r, /## Work offloaded/)
  assert.match(r, /off your Claude context/)
  assert.match(r, /Workers reported ≈ 1,234 tokens of usage/)
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
  assert.match(r, /Workers reported ≈ 500 tokens of usage/)
  // WHY: t2 has 3 attempts but FAILED — its retries are implied by its FAILED row, so it must NOT
  // appear under "Retried before passing" (that line is only for tasks that eventually integrated).
  assert.doesNotMatch(r, /Retried before passing/)
})

test('buildReport with zero tasks yields 0% success and no offload headline', () => {
  // WHY: total === 0 → pct stays 0 and there is no offload headline (nothing ran). The Work-offloaded
  // section must state token usage was "not reported" rather than invent a number.
  const r = buildReport({})
  assert.match(r, /0\/0 integrated/)
  assert.match(r, /0% success/)
  assert.match(r, /Token\/cost usage: not reported by these CLIs/)
  // WHY: never a fabricated/scraped token figure anywhere in the report.
  assert.doesNotMatch(r, /≈ \d/)
  // WHY: an empty run has no offload headline at all.
  assert.doesNotMatch(r, /Implementation ran on external CLIs/)
})

test('buildReport leads with a verdict + offload headline ABOVE the per-task table', () => {
  // WHY: "easy to read no matter how many agents are used" means the outcome and the value prop must
  // be visible without scrolling a table that can run to dozens of rows. The verdict + the qualitative
  // offload headline must precede the table header, not sit below it.
  const r = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }, { task: 'b', cli: 'grok', merged: true }],
    failed: ['c'], blocked: [{ task: 'd', reason: 'dep' }], externalTokens: 847200, taskCount: 4,
  })
  const headlineIdx = r.indexOf('2 of 4 tasks integrated')
  const offloadIdx = r.indexOf('Implementation ran on external CLIs')
  const tableIdx = r.indexOf('| task | worker |')
  assert.ok(headlineIdx > -1 && offloadIdx > -1, 'verdict + offload headline are present')
  assert.ok(headlineIdx < tableIdx && offloadIdx < tableIdx, 'both headline lines precede the table')
  assert.match(r, /1 failed · 1 blocked/)
  // WHY: a worker-reported token figure (full count, not a scrape) belongs in the Work-offloaded
  // section below — never invented in the headline.
  assert.match(r, /Workers reported ≈ 847,200 tokens of usage/)
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

test('Work offloaded section reports MEASURED signals (attempts, wall-clock) and tokens only when a worker reported them', () => {
  // WHY: token self-reports are unreliable (most external CLIs emit none), so the value section leads
  // with what is actually measured — worker-attempt count and total wall-clock — and only shows a
  // token figure when a worker reported one. It must NEVER fabricate "≈ N tokens" from a scrape.

  // The common case: nothing reported → measured offload (attempts + wall-clock) + "not reported".
  const typical = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }, { task: 'b', cli: 'opencode', merged: true }],
    taskCount: 2, workerAttempts: 3, externalWallMs: 229000,
  })
  assert.match(typical, /## Work offloaded/)
  assert.match(typical, /2 tasks \(3 worker attempts\) implemented by external CLIs, off your Claude context/)
  assert.match(typical, /≈ 3m 49s of external CLI compute ran off your context/)
  assert.match(typical, /Token\/cost usage: not reported by these CLIs/)
  assert.doesNotMatch(typical, /≈ \d+ tokens|≈ \d+,\d+ tokens/)   // no fabricated token figure

  // Partial structured coverage → show the figure WITH an explicit floor caveat.
  const partial = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }],
    taskCount: 1, externalTokens: 4200, workerAttempts: 2, externalWallMs: 47000,
    tokenCoverage: { captured: 1, total: 2 },
  })
  assert.match(partial, /Workers reported ≈ 4,200 tokens of usage \(only 1 of 2 attempts reported usage — a floor\)/)

  // Full structured coverage → the figure, no floor caveat.
  const full = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }],
    taskCount: 1, externalTokens: 5000, workerAttempts: 1, externalWallMs: 12000,
    tokenCoverage: { captured: 1, total: 1 },
  })
  assert.match(full, /Workers reported ≈ 5,000 tokens of usage\./)
  assert.doesNotMatch(full, /a floor/)

  // Singular wall-clock-only edge: 1 task, 1 attempt phrasing is grammatical.
  const one = buildReport({ merged: [{ task: 'a', cli: 'codex', merged: true }], taskCount: 1, workerAttempts: 1, externalWallMs: 8000 })
  assert.match(one, /1 task \(1 worker attempt\) implemented by external CLIs/)
  assert.match(one, /≈ 8s of external CLI compute/)
})

test('Work offloaded breaks usage down per CLI: landed vs spent vs overhead', () => {
  // WHY: the aggregate hides which CLI burned tokens and how much went to rejected retries /
  // competition losers. The per-CLI table shows landed (tokens for work that integrated) vs spent
  // (ALL attempts incl. retries + losers); overhead = spent − landed makes the retry/competition
  // cost legible per CLI. Numbers mirror a real run (run 6e1d049b).
  const r = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }],
    taskCount: 4, externalTokens: 274485, workerAttempts: 6, externalWallMs: 500000,
    cliUsage: [
      { cli: 'codex', attempts: 4, landed: 252925, spent: 340357 },
      { cli: 'opencode', attempts: 2, landed: 21560, spent: 43221 },
    ],
  })
  assert.match(r, /Workers used ≈ 383,578 tokens — ≈ 274,485 on work that landed, ≈ 109,093 on retries \+ competition:/)
  // Fixed-width aligned table (NOT markdown), matching the WORKER ROSTER style: header + ─ separator,
  // numeric columns right-aligned. Match data rows with flexible whitespace.
  assert.match(r, /CLI\s+attempts\s+landed\s+spent\s+overhead/)
  assert.match(r, /─{2,}/)
  assert.match(r, /codex\s+4\s+252,925\s+340,357\s+\+87,432/)
  assert.match(r, /opencode\s+2\s+21,560\s+43,221\s+\+21,661/)
  // A Total row reconciles the table; landed total === the run's externalTokens.
  assert.match(r, /Total\s+6\s+274,485\s+383,578\s+\+109,093/)
  // The per-CLI table is NOT markdown — no "| CLI |" pipe header, no "**Total**" bold.
  assert.doesNotMatch(r, /\| CLI \||\*\*Total\*\*/)
})

test('Work offloaded per-CLI table: clean single-CLI run has no overhead clause and no Total row', () => {
  // WHY: when nothing was retried or raced (landed === spent) the "on retries + competition" clause
  // and the Total row are noise — a single clean CLI shows a 0 overhead and no total.
  const r = buildReport({
    merged: [{ task: 'a', cli: 'codex', merged: true }],
    taskCount: 1, externalTokens: 5000, workerAttempts: 1,
    cliUsage: [{ cli: 'codex', attempts: 1, landed: 5000, spent: 5000 }],
  })
  assert.match(r, /Workers used ≈ 5,000 tokens of usage:/)
  assert.match(r, /codex\s+1\s+5,000\s+5,000\s+0/)
  assert.doesNotMatch(r, /on retries \+ competition/)
  assert.doesNotMatch(r, /Total/)   // single CLI → no Total row
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
