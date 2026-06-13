# Per-Task Effort Levels + Effort-First Escalation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reasoning effort a per-task axis decoupled from model tier — assigned by the decomposition brain, defaulting to `low`, injected per-CLI, and escalated *before* model/tier on QA failure.

**Architecture:** `effort` becomes an optional task field (`off|low|medium|high|xhigh`). `resolveRoute` substitutes a per-CLI `effortFlags` fragment into a `{{EFFORT}}` slot in the invocation. The decomposition brain emits `effort` per task. The QA-retry loop in `core.mjs` climbs effort within a tier before stepping up a tier.

**Tech Stack:** Node 22+ (ESM, `node:test`, `node:assert/strict`). No new dependencies.

**Reference spec:** `docs/specs/2026-06-13-effort-levels-design.md`. **Git:** this branch (`feature/effort-levels`) is stacked on `feature/pi-worker-local-models` (PR #18).

---

## File Structure

| File | Change |
|---|---|
| `lib/prompts.mjs` | Export `VALID_EFFORTS`, `DEFAULT_EFFORT` |
| `lib/plan-schema.mjs` | Optional `effort` field + validation |
| `scripts/router.mjs` | Local `VALID_EFFORTS`/`DEFAULT_EFFORT`; `effortFlags` for codex/droid/pi; `{{EFFORT}}` in their templates; `resolveRoute` substitution + return |
| `scripts/router.test.mjs` | New effort routing tests; **update PR #18 `pi` tests** (commands now carry `--thinking low`) |
| `lib/orchestrator/decompose.mjs` | Brain prompt + `normalizeTask` effort default |
| `lib/orchestrator/decompose.test.mjs` | `normalizeTask` effort tests |
| `lib/orchestrator/core.mjs` | Effort-first escalation ladder + `startEffort` carry + logs |
| `lib/orchestrator/core.harness.test.mjs` | Escalation ladder test |
| `README.md`, `CHANGELOG.md`, `ultraswarm.config.advanced.json` | Docs |

**Unchanged:** gemini/grok/agy/opencode/pi-local invocations, host contract/skills, `explain-routing`.

---

## Task 1: Effort vocabulary constants

**Files:**
- Modify: `lib/prompts.mjs:32` (after `VALID_MODEL_TIERS`)
- Modify: `scripts/router.mjs:5-7` (near `VALID_TIERS`)
- Test: `lib/prompts.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `lib/prompts.test.mjs`:

```javascript
import { VALID_EFFORTS, DEFAULT_EFFORT } from './prompts.mjs'

test('effort vocabulary is exported with low as the default', () => {
  assert.deepEqual(VALID_EFFORTS, ['off', 'low', 'medium', 'high', 'xhigh'])
  assert.equal(DEFAULT_EFFORT, 'low')
})
```

(If `lib/prompts.test.mjs` does not already import `test`/`assert`, add `import { test } from 'node:test'` and `import assert from 'node:assert/strict'` at the top, matching the existing test files.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/prompts.test.mjs`
Expected: FAIL — `VALID_EFFORTS`/`DEFAULT_EFFORT` not exported.

- [ ] **Step 3: Export the constants from prompts.mjs**

In `lib/prompts.mjs`, immediately after the `VALID_MODEL_TIERS` line (`export const VALID_MODEL_TIERS = ['simple', 'moderate', 'complex', 'expert']`), add:

```javascript
export const VALID_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh']
export const DEFAULT_EFFORT = 'low'
```

- [ ] **Step 4: Add the local copies in router.mjs**

In `scripts/router.mjs`, just after `const VALID_TIERS = [...]` and its related consts (around line 5-8), add:

```javascript
const VALID_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'];
const VALID_EFFORT_SET = new Set(VALID_EFFORTS);
const DEFAULT_EFFORT = 'low';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test lib/prompts.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/prompts.mjs lib/prompts.test.mjs scripts/router.mjs
git commit -m "feat(effort): add effort vocabulary constants"
```

---

## Task 2: Plan-schema effort validation

**Files:**
- Modify: `lib/plan-schema.mjs` (schema properties + `validatePlan`)
- Test: `lib/plan-schema.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `lib/plan-schema.test.mjs` (follow the file's existing style for building a minimal valid plan):

```javascript
test('effort is optional but must be in the vocabulary when present', () => {
  const base = { id: 't1', description: 'd', files: ['a.js'], complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'p' }
  assert.equal(validatePlan({ tasks: [{ ...base, effort: 'high' }] }).valid, true)
  assert.equal(validatePlan({ tasks: [{ ...base }] }).valid, true)            // omitted is fine
  const bad = validatePlan({ tasks: [{ ...base, effort: 'turbo' }] })
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.includes('invalid effort "turbo"')))
})
```

(Ensure `validatePlan` is imported in this test file; it already tests the schema, so reuse the existing import.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/plan-schema.test.mjs`
Expected: FAIL — `effort: 'turbo'` is currently accepted (no validation) and rejected by `additionalProperties: false` (so the valid cases fail too).

- [ ] **Step 3: Add `effort` to the schema and validation**

In `lib/plan-schema.mjs`:

1. Add the import of `VALID_EFFORTS` alongside the existing `VALID_MODEL_TIERS` import:

```javascript
import { VALID_MODEL_TIERS, VALID_EFFORTS } from './prompts.mjs'
```

2. In `PLAN_SCHEMA`, add `effort` to the task `properties` (next to `model_tier`):

```javascript
        cli: { type: 'string' }, model_tier: { type: 'string' }, effort: { type: 'string' },
```

3. In `validatePlan`, after the `model_tier` check, add:

```javascript
    if (t.effort !== undefined && !VALID_EFFORTS.includes(t.effort)) errors.push(`task ${t.id}: invalid effort "${t.effort}"`)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/plan-schema.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/plan-schema.mjs lib/plan-schema.test.mjs
git commit -m "feat(effort): accept optional effort field in plan schema"
```

---

## Task 3: Registry effortFlags + resolveRoute substitution

**Files:**
- Modify: `scripts/router.mjs` (`DEFAULT_REGISTRY` codex/droid/pi entries; `resolveRoute`)
- Modify: `scripts/router.test.mjs` (new effort tests; update PR #18 `pi` tests)
- Test: `scripts/router.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to the `describe('resolveRoute', ...)` block in `scripts/router.test.mjs`:

```javascript
    it('injects the per-CLI effort flag, defaulting to low', () => {
      assert.match(resolveRoute({ cli: 'codex', model_tier: 'simple' }).command, /-c model_reasoning_effort=low /);
      assert.match(resolveRoute({ cli: 'codex', model_tier: 'simple', effort: 'high' }).command, /-c model_reasoning_effort=high /);
      assert.match(resolveRoute({ cli: 'pi', model_tier: 'simple' }).command, /--thinking low /);
      assert.match(resolveRoute({ cli: 'droid', model_tier: 'complex', effort: 'medium' }).command, /-r medium /);
      assert.strictEqual(resolveRoute({ cli: 'codex', model_tier: 'simple' }).effort, 'low');
    });

    it('leaves invocations without an {{EFFORT}} placeholder byte-identical', () => {
      assert.strictEqual(
        resolveRoute({ cli: 'opencode', complexity_score: 5 }).command,
        DEFAULT_REGISTRY.opencode.models.simple.invocation
      );
    });

    it('throws on an invalid effort value, listing the allowed set', () => {
      assert.throws(
        () => resolveRoute({ cli: 'codex', model_tier: 'simple', effort: 'turbo' }),
        (err) => {
          assert(err.message.includes('Invalid effort "turbo"'));
          assert(err.message.includes('off, low, medium, high, xhigh'));
          return true;
        }
      );
    });
```

Then UPDATE the two PR #18 `pi` tests (added on the stacked branch) so they expect the effort fragment. Change the `pi` simple assertion from the exact-match regex to:

```javascript
    it('pi routes the Anthropic spread by tier; expert adds --thinking high', () => {
      assert.match(
        resolveRoute({ cli: 'pi', model_tier: 'simple' }).command,
        /^pi -p --provider anthropic --model claude-haiku-4-5 --thinking low "\$\(cat \.ultraswarm-prompt\.txt\)"$/
      );
      assert.match(
        resolveRoute({ cli: 'pi', model_tier: 'moderate' }).command,
        /--model claude-sonnet-4-6 --thinking low/
      );
      const expert = resolveRoute({ cli: 'pi', complexity_score: 200, effort: 'high' });
      assert.strictEqual(expert.tier, 'expert');
      assert.match(expert.command, /--model claude-opus-4-8 --thinking high/);
    });
```

And update the `pi-local` test from PR #18 — `pi-local` has **no** `effortFlags`, so its command must stay free of any effort flag:

```javascript
    it('pi-local routes Ollama models by tier and aliases its binary to pi', () => {
      assert.match(
        resolveRoute({ cli: 'pi-local', model_tier: 'simple' }).command,
        /^pi -p --provider ollama --model qwen3-coder:7b "\$\(cat \.ultraswarm-prompt\.txt\)"$/
      );
      assert.doesNotMatch(resolveRoute({ cli: 'pi-local', model_tier: 'simple' }).command, /--thinking/);
      assert.strictEqual(DEFAULT_REGISTRY['pi-local'].binary, 'pi');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/router.test.mjs`
Expected: FAIL — no `effortFlags`/`{{EFFORT}}` yet; effort not returned; invalid-effort not thrown.

- [ ] **Step 3: Add `effortFlags` + `{{EFFORT}}` to codex, droid, pi**

In `scripts/router.mjs` `DEFAULT_REGISTRY`:

**codex** — add `effortFlags` and put `{{EFFORT}}` after the model in each tier; **remove** the expert `-c model_reasoning_effort=high`:

```javascript
  codex: {
    specialty: 'backend, logic, algorithms, debugging',
    timeoutMs: 900000,
    effortFlags: { off: '-c model_reasoning_effort=minimal', low: '-c model_reasoning_effort=low', medium: '-c model_reasoning_effort=medium', high: '-c model_reasoning_effort=high', xhigh: '-c model_reasoning_effort=high' },
    models: {
      simple: { model: 'gpt-5.4-mini', invocation: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.4-mini {{EFFORT}}"$(cat .ultraswarm-prompt.txt)" </dev/null' },
      moderate: { model: 'gpt-5.4', invocation: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.4 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)" </dev/null' },
      complex: { model: 'gpt-5.5', invocation: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.5 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)" </dev/null' },
      expert: { model: 'gpt-5.5', invocation: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.5 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)" </dev/null' }
    }
  },
```

**droid** — add `effortFlags`, `{{EFFORT}}` after `-m <model>`; **remove** the expert `-r high`:

```javascript
  droid: {
    specialty: 'general full-stack implementation, refactoring',
    timeoutMs: 600000,
    effortFlags: { off: '-r low', low: '-r low', medium: '-r medium', high: '-r high', xhigh: '-r high' },
    models: {
      simple: { model: 'claude-haiku-4-5', invocation: 'droid exec -m claude-haiku-4-5 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"' },
      moderate: { model: 'claude-sonnet-4-6', invocation: 'droid exec -m claude-sonnet-4-6 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"' },
      complex: { model: 'claude-opus-4-8', invocation: 'droid exec -m claude-opus-4-8 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"' },
      expert: { model: 'claude-opus-4-8', invocation: 'droid exec -m claude-opus-4-8 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"' }
    }
  },
```

**pi** — add `effortFlags`, `{{EFFORT}}` after `--model <model>`; **remove** the expert `--thinking high` (effort now supplies it):

```javascript
  pi: {
    specialty: 'provider-agnostic generalist, full-stack, refactors',
    timeoutMs: 600000,
    binary: 'pi',
    effortFlags: { off: '--thinking off', low: '--thinking low', medium: '--thinking medium', high: '--thinking high', xhigh: '--thinking xhigh' },
    models: {
      simple: { model: 'claude-haiku-4-5', invocation: 'pi -p --provider anthropic --model claude-haiku-4-5 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"' },
      moderate: { model: 'claude-sonnet-4-6', invocation: 'pi -p --provider anthropic --model claude-sonnet-4-6 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"' },
      complex: { model: 'claude-opus-4-8', invocation: 'pi -p --provider anthropic --model claude-opus-4-8 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"' },
      expert: { model: 'claude-opus-4-8', invocation: 'pi -p --provider anthropic --model claude-opus-4-8 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"' }
    }
  },
```

Leave `gemini`, `grok`, `agy`, `opencode`, `pi-local` exactly as they are (no `effortFlags`, no `{{EFFORT}}`).

- [ ] **Step 4: Implement effort resolution in `resolveRoute`**

In `scripts/router.mjs` `resolveRoute`, after the `model_tier` validation guard, add an effort guard:

```javascript
  if (task?.effort !== undefined && !VALID_EFFORT_SET.has(task.effort)) {
    throw new Error(`Invalid effort ${JSON.stringify(task.effort)}. Allowed values: ${VALID_EFFORTS.join(', ')}.`);
  }
```

Then, after `command` is resolved (just before building the return object), substitute the placeholder:

```javascript
  const effort = task?.effort ?? DEFAULT_EFFORT;
  const effortFlags = config.overrides?.[cli]?.effortFlags ?? DEFAULT_REGISTRY[cli].effortFlags;
  const effortFragment = effortFlags?.[effort] ?? effortFlags?.[DEFAULT_EFFORT] ?? '';
  const resolvedCommand = command.replace('{{EFFORT}}', effortFragment ? `${effortFragment} ` : '');
```

Return `effort` and use `resolvedCommand` as `command` in the result:

```javascript
  return { cli, tier, model, command: resolvedCommand, timeoutMs, effort };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test scripts/router.test.mjs`
Expected: PASS (new effort tests + updated pi/pi-local tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/router.mjs scripts/router.test.mjs
git commit -m "feat(effort): inject per-CLI effort flag via {{EFFORT}} in resolveRoute"
```

---

## Task 4: Decomposition brain emits effort

**Files:**
- Modify: `lib/orchestrator/decompose.mjs` (`normalizeTask`, prompt)
- Test: `lib/orchestrator/decompose.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `lib/orchestrator/decompose.test.mjs`:

```javascript
test('normalizeTask defaults effort to low and coerces invalid effort', () => {
  assert.equal(normalizeTask({ complexity_score: 10 }).effort, 'low')
  assert.equal(normalizeTask({ complexity_score: 10, effort: 'bogus' }).effort, 'low')
  assert.equal(normalizeTask({ complexity_score: 10, effort: 'high' }).effort, 'high')
})
```

(`normalizeTask` is already exported and imported in this test file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/orchestrator/decompose.test.mjs`
Expected: FAIL — `normalizeTask` does not set `effort`.

- [ ] **Step 3: Update `normalizeTask` and the prompt**

In `lib/orchestrator/decompose.mjs`:

1. Extend the import to include effort vocab:

```javascript
import { VALID_MODEL_TIERS, VALID_EFFORTS, DEFAULT_EFFORT } from '../prompts.mjs'
```

2. In `normalizeTask`, add effort coercion and include it in the returned object:

```javascript
export function normalizeTask(t) {
  const model_tier = VALID_MODEL_TIERS.includes(t.model_tier) ? t.model_tier : tierFromComplexity(t.complexity_score)
  const risk = t.risk === 'high' ? 'high' : 'routine'
  const effort = VALID_EFFORTS.includes(t.effort) ? t.effort : DEFAULT_EFFORT
  return { ...t, model_tier, risk, effort }
}
```

3. In the `decompose` prompt, add `effort` to the JSON shape line and to the field vocabulary list:

- Change the `Return JSON: {"tasks":[{...}]}` line to include `effort`:

```javascript
Return JSON: {"tasks":[{id, description, files, cli, model_tier, effort, complexity_score, risk, dependencies, prompt}]}
```

- Add this bullet to the field vocabulary (after the `model_tier` bullet):

```javascript
- effort: ONE of off, low, medium, high. DEFAULT to "low" — most tasks produce the same result at low effort, far cheaper and faster. Use "medium" for moderate logic, and reserve "high" only for genuinely hard reasoning, architecture, or security work. Effort is independent of model_tier.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/orchestrator/decompose.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/orchestrator/decompose.mjs lib/orchestrator/decompose.test.mjs
git commit -m "feat(effort): decomposition brain assigns per-task effort, default low"
```

---

## Task 5: Effort-first escalation in the attempt loop

**Files:**
- Modify: `lib/orchestrator/core.mjs` (`intelligentAttemptLoop` and the alternate-CLI call site)
- Test: `lib/orchestrator/core.harness.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a focused unit test for the ladder. Add to `lib/orchestrator/core.harness.test.mjs` (it already imports the harness; export `nextRung` from `core.mjs` so it is testable — see Step 3):

```javascript
test('nextRung climbs effort within a tier, then steps tier and resets effort to low', () => {
  assert.deepEqual(nextRung('moderate', 'low'), { tier: 'moderate', effort: 'medium' })
  assert.deepEqual(nextRung('moderate', 'medium'), { tier: 'moderate', effort: 'high' })
  assert.deepEqual(nextRung('moderate', 'high'), { tier: 'complex', effort: 'low' })
  assert.deepEqual(nextRung('expert', 'high'), { tier: 'expert', effort: 'high' })   // maxed
  assert.deepEqual(nextRung('complex', 'off'), { tier: 'expert', effort: 'low' })    // off → step tier
})
```

Add `nextRung` to the imports from `core.mjs` at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/orchestrator/core.harness.test.mjs`
Expected: FAIL — `nextRung` is not exported.

- [ ] **Step 3: Implement and export `nextRung`, and rewire the loop**

In `lib/orchestrator/core.mjs`:

1. Add the import for `DEFAULT_EFFORT`:

```javascript
import { VALID_MODEL_TIERS, DEFAULT_EFFORT } from '../prompts.mjs'
```

(Adjust to merge with the existing `prompts.mjs` import line — keep whatever is already imported and add `DEFAULT_EFFORT`.)

2. Add the exported ladder helper near the top-level helpers (e.g. next to `validateModelTier`):

```javascript
const EFFORT_LADDER = ['low', 'medium', 'high']
const TIER_LADDER = ['simple', 'moderate', 'complex', 'expert']

export function nextRung(tier, effort) {
  const e = EFFORT_LADDER.indexOf(effort)
  if (e >= 0 && e < EFFORT_LADDER.length - 1) return { tier, effort: EFFORT_LADDER[e + 1] }
  const t = TIER_LADDER.indexOf(tier)
  if (t >= 0 && t < TIER_LADDER.length - 1) return { tier: TIER_LADDER[t + 1], effort: 'low' }
  return { tier: 'expert', effort: 'high' }
}
```

3. In `intelligentAttemptLoop`, change the signature to accept `startEffort`:

```javascript
  async function intelligentAttemptLoop(t, cli, maxAttempts, seedFeedback, attemptOffset = 0, startTier = null, startEffort = null) {
```

4. Seed effort next to the tier seed (after the `currentModelTier` line ~202):

```javascript
      let currentEffort = startEffort || t.effort || DEFAULT_EFFORT
```

5. Replace the tier-only escalation block (the `if (n > 1 && currentModelTier !== 'expert') { ... }` block, ~lines 207-215) with the two-dimensional ladder:

```javascript
        // Effort-first escalation: climb effort within a tier, then step the tier.
        if (n > 1 && !(currentModelTier === 'expert' && currentEffort === 'high')) {
          const rung = nextRung(currentModelTier, currentEffort)
          currentModelTier = rung.tier
          currentEffort = rung.effort
          log(`${t.id}: escalating to ${currentModelTier}@${currentEffort} for attempt ${attempt}`)
        }
```

6. Build the per-attempt task with effort (the `tAttempt` line ~218):

```javascript
        const tAttempt = { ...t, model_tier: currentModelTier, effort: currentEffort }
```

7. Update the two feedback/log lines that show `${validCli}/${currentModelTier}` to include effort, e.g.:

```javascript
            ? `attempt ${attempt} (${validCli}/${currentModelTier}@${currentEffort}): ${impl.status} — ${impl.summary}${gates ? ` · gates: ${gates}` : ''}`
```

and:

```javascript
        log(`${t.id}: attempt ${attempt} on ${validCli}/${currentModelTier}@${currentEffort} rejected (${verdict.issues.length} issues)`)
```

8. Find the alternate-CLI reassignment call to `intelligentAttemptLoop` (near line 288, where `startTier` is passed as the escalated tier) and pass the carried effort as the new `startEffort` argument, e.g.:

```javascript
      // ... intelligentAttemptLoop(t, altCli, ..., <escalated tier>, <escalated effort>)
```

Use the same escalated-tier value the existing code already computes for `startTier`, and pass the corresponding effort (the loop's `final` effort if available, else `DEFAULT_EFFORT`). Read the surrounding code to wire the exact variable; do not guess — if the escalated effort is not tracked at that call site, pass `DEFAULT_EFFORT` and note it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/orchestrator/core.harness.test.mjs`
Expected: PASS. Then run the full suite: `node --test` — must be green (the escalation rewire must not break existing harness tests; if a harness test asserts an old `escalating to <tier>` log string, update it to the new `<tier>@<effort>` form).

- [ ] **Step 5: Commit**

```bash
git add lib/orchestrator/core.mjs lib/orchestrator/core.harness.test.mjs
git commit -m "feat(effort): escalate effort before model/tier on QA failure"
```

---

## Task 6: Docs — README, CHANGELOG, advanced config

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `ultraswarm.config.advanced.json`

- [ ] **Step 1: Add an "Effort levels" section to the README**

In `README.md`, immediately before `## State And Safety`, insert:

```markdown
## Effort Levels

Reasoning effort is a per-task dial, **independent of model tier**. The decomposition brain
assigns `effort` (`off`/`low`/`medium`/`high`/`xhigh`) to each task and **defaults to `low`** —
most routine tasks produce the same result at low effort, far faster and cheaper. High effort is
reserved for genuinely hard reasoning.

Effort is injected per CLI for the workers that expose the dial (`codex`, `droid`, `pi`); other
workers ignore it. On QA failure, ultraswarm escalates **effort first** (low → medium → high)
before stepping up the model tier — the cheapest correction rung first.

Set `effort` explicitly on a task in your plan JSON to override, or override `effortFlags` per CLI
in `ultraswarm.config.json` (see `ultraswarm.config.advanced.json`).

> Behavior note: because effort defaults to `low`, an expert-tier task runs the expert *model* at
> *low* effort and escalates on failure — it is no longer pinned to high effort. Pin it with
> `effort: "high"` if you need maximum reasoning up front.
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, under the existing `## [Unreleased]` `### Added` list (created by PR #18), append:

```markdown
- **Per-task effort levels** — the decomposition brain assigns `effort`
  (`off`/`low`/`medium`/`high`/`xhigh`) per task, independent of model tier, defaulting to `low`.
  Injected per CLI for `codex`/`droid`/`pi` via a `{{EFFORT}}` slot + `effortFlags` map.
- **Effort-first escalation** — on QA failure the attempt loop climbs effort
  (low → medium → high) before stepping up the model tier, so the cheapest correction is tried
  first. Expert-tier tasks now run at low effort by default and escalate as needed.
```

- [ ] **Step 3: Add an `effortFlags` override example to the advanced config**

In `ultraswarm.config.advanced.json`, inside the existing `"codex"` override block, add an `effortFlags` key (a sibling of `models`) to show the override shape:

```json
      "effortFlags": {
        "off": "-c model_reasoning_effort=minimal",
        "low": "-c model_reasoning_effort=low",
        "medium": "-c model_reasoning_effort=medium",
        "high": "-c model_reasoning_effort=high",
        "xhigh": "-c model_reasoning_effort=high"
      },
```

Add a matching note to the `notes` array:

```json
    "effortFlags (per CLI: codex/droid/pi) maps an effort level to the flag spliced into the {{EFFORT}} slot of that CLI's invocation. Tasks default to effort 'low'; the QA loop escalates effort before model tier."
```

- [ ] **Step 4: Validate the config JSON**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('ultraswarm.config.advanced.json','utf8')); console.log('json ok')"
```
Expected: `json ok`.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md ultraswarm.config.advanced.json
git commit -m "docs(effort): document effort levels, default-low behavior, and overrides"
```

---

## Task 7: Full verification

**Files:** none.

- [ ] **Step 1: Run the entire test suite**

Run: `node --test`
Expected: PASS — all tests including new effort coverage and updated pi/harness tests.

- [ ] **Step 2: Repository validation + host-skill lock**

Run: `bash scripts/validate.sh && node scripts/generate-host-skills.mjs --check`
Expected: both PASS (host skills unchanged → lock intact).

- [ ] **Step 3: Smoke-check the resolved commands**

Run:
```bash
node --input-type=module -e "
import { resolveRoute } from './scripts/router.mjs';
console.log('codex simple default:', resolveRoute({ cli:'codex', model_tier:'simple' }).command);
console.log('codex simple high   :', resolveRoute({ cli:'codex', model_tier:'simple', effort:'high' }).command);
console.log('pi expert (low dflt):', resolveRoute({ cli:'pi', complexity_score:200 }).command);
console.log('opencode (no slot)  :', resolveRoute({ cli:'opencode', complexity_score:5 }).command);
"
```
Expected: codex commands show `-c model_reasoning_effort=low` / `=high`; pi expert shows `--thinking low`; opencode shows no effort flag and is unchanged.

- [ ] **Step 4: Final confirmation**

Confirm all green. Feature complete: per-task effort, default low, per-CLI injection, effort-first escalation, docs + tests updated.

---

## Self-Review Notes

- **Spec coverage:** constants (T1), schema (T2), registry+resolveRoute (T3), brain+normalize (T4), escalation ladder (T5), docs (T6), verification (T7). All spec sections mapped.
- **PR #18 interaction:** T3 explicitly updates the stacked-branch `pi`/`pi-local` routing tests; `pi-local` asserted to remain effort-free.
- **Backward compatibility:** substitution is a surgical `replace('{{EFFORT}}', ...)`; CLIs/overrides without the placeholder are byte-identical (T3 Step 1 second test + T7 Step 3 pin this).
- **Name consistency:** `effortFlags`, `{{EFFORT}}`, `VALID_EFFORTS`, `DEFAULT_EFFORT`, `nextRung` used identically across router/prompts/plan-schema/decompose/core and their tests.
- **Riskiest task (T5):** the alternate-CLI `startEffort` wiring is the one spot requiring the implementer to read surrounding code rather than copy a block — flagged explicitly with a safe fallback (`DEFAULT_EFFORT`).
