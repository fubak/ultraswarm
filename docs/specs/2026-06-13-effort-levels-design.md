# Per-Task Effort Levels + Effort-First Escalation — Design Spec

**Date:** 2026-06-13
**Status:** Approved (design) — implementation to follow
**Extends:** `docs/specs/2026-06-07-ultraswarm-design.md`
**Builds on (git):** `feature/pi-worker-local-models` (PR #18). This branch stacks on it because it modifies the `pi`/`codex`/`droid` invocation templates that branch introduces/owns.
**Motivation:** Morgan Linton, "If you aren't using models with different effort levels, you're probably wasting tokens, and time" (x.com/morganlinton, 2026-06-13).

## Problem

Reasoning/thinking effort is a compute dial **separate from model choice**. Running a model at high effort on a routine task frequently yields the *same solution* as low effort — just slower and at far higher token cost. The winning technique is to let the model assess what effort each task actually needs, default low, and spend high effort only where reasoning genuinely demands it.

Today ultraswarm conflates effort with **tier**: invocations are static strings, and an effort flag is hardcoded **only at the expert tier**, for **only some CLIs** (`codex -c model_reasoning_effort=high`, `droid -r high`, `pi --thinking high`). There is no per-task effort control and no way to run a strong model at low effort.

## Approved Decisions

| Decision | Choice |
|---|---|
| v1 scope | **Core + effort-first escalation** — brain-assigned per-task effort, per-CLI injection, and escalate effort before model/tier on QA failure. |
| Default effort | **`low`** — most tasks produce the same result at low effort; QA + escalation catch the misses. |
| Injection mechanism | A per-CLI **`effortFlags`** map + a `{{EFFORT}}` placeholder in the invocation template, substituted by `resolveRoute`. CLIs without `effortFlags` ignore effort entirely (no leaky universal field). |
| Effort vocabulary | `off, low, medium, high, xhigh`. Auto-escalation climbs only `low → medium → high`; `off`/`xhigh` are reachable only when the brain sets them explicitly. |

### Behavior change (called out loudly)

With default effort `low` decoupled from tier, an **expert-tier task no longer auto-runs at high effort** — it runs the expert *model* at *low* effort, then escalates effort on QA failure. This is intentional (it is the entire point) and is made safe by the existing adaptive-QA + retry machinery. Users who want a task pinned high can set `effort: "high"` on that task or override `effortFlags`.

## Design

### 1. Effort vocabulary (constants)

Mirror the existing duplication of tier vocab (`router.mjs` has local `VALID_TIERS`; `prompts.mjs` exports `VALID_MODEL_TIERS`):

- `scripts/router.mjs`: local `const VALID_EFFORTS = ['off','low','medium','high','xhigh']` and `const DEFAULT_EFFORT = 'low'`.
- `lib/prompts.mjs`: `export const VALID_EFFORTS = ['off','low','medium','high','xhigh']` and `export const DEFAULT_EFFORT = 'low'` (consumed by plan-schema, decompose, core).

### 2. Plan schema (`lib/plan-schema.mjs`)

Add an optional `effort` property (`{ type: 'string' }`) to the task schema. In `validatePlan`, reject an out-of-vocabulary effort the same way `model_tier` is checked: `if (t.effort !== undefined && !VALID_EFFORTS.includes(t.effort)) errors.push(...)`. Effort is **optional**; absence means "use the default."

### 3. Registry + `resolveRoute` (`scripts/router.mjs`)

For the effort-capable CLIs, add an `effortFlags` map and a `{{EFFORT}}` slot in **every tier's** invocation template, positioned right after the model flag. Remove the now-redundant hardcoded expert-tier effort flags (effort drives them).

`effortFlags` (only these three CLIs in v1):

```
codex:  { off:'-c model_reasoning_effort=minimal', low:'-c model_reasoning_effort=low', medium:'-c model_reasoning_effort=medium', high:'-c model_reasoning_effort=high', xhigh:'-c model_reasoning_effort=high' }
droid:  { off:'-r low', low:'-r low', medium:'-r medium', high:'-r high', xhigh:'-r high' }
pi:     { off:'--thinking off', low:'--thinking low', medium:'--thinking medium', high:'--thinking high', xhigh:'--thinking xhigh' }
```

(`codex` has no `xhigh`/`off` reasoning levels → mapped to `high`/`minimal`. `droid` floor is `low`. `pi-local`, `gemini`, `grok`, `agy`, `opencode` get **no** `effortFlags` and **no** `{{EFFORT}}` placeholder — effort is silently ignored for them.)

Template example (codex simple): note the single space *before* `{{EFFORT}}` and none after — the substituted fragment carries its own trailing space:

```
codex exec -s workspace-write --skip-git-repo-check -m gpt-5.4-mini {{EFFORT}}"$(cat .ultraswarm-prompt.txt)" </dev/null
```

`resolveRoute` changes:
- Compute `const effort = task?.effort ?? DEFAULT_EFFORT`; throw on invalid effort (mirrors the `model_tier` guard).
- Resolve `effortFlags` as `config.overrides?.[cli]?.effortFlags ?? DEFAULT_REGISTRY[cli].effortFlags` (undefined for non-effort CLIs).
- `const fragment = effortFlags?.[effort] ?? effortFlags?.[DEFAULT_EFFORT] ?? ''`.
- **Surgical** substitution only: `command = command.replace('{{EFFORT}}', fragment ? fragment + ' ' : '')`. No global whitespace collapse — commands without the placeholder are byte-identical to today (preserves existing tests).
- Return `effort` in the result object alongside `cli, tier, model, command, timeoutMs`.

### 4. Decomposition brain (`lib/orchestrator/decompose.mjs`)

- Add `effort` to the JSON shape and the field vocabulary in the prompt, mirroring the article's guidance:
  > `effort: ONE of off, low, medium, high. DEFAULT to "low" — most tasks produce the same result at low effort, far cheaper and faster. Use "medium" for moderate logic, and reserve "high" only for genuinely hard reasoning, architecture, or security work. Effort is independent of model_tier.`
- `normalizeTask`: coerce `effort` to a valid value, defaulting to `DEFAULT_EFFORT` (`low`) when absent or invalid — same belt-and-suspenders pattern as `model_tier`/`risk`.

### 5. Effort-first escalation (`lib/orchestrator/core.mjs`)

In `intelligentAttemptLoop`, replace the tier-only escalation (lines ~207-215) with a two-dimensional ladder that climbs **effort first, then tier**:

- Track `currentEffort` alongside `currentModelTier`, seeded from `startEffort || t.effort || DEFAULT_EFFORT`.
- Add a `startEffort` parameter (mirroring `startTier`) so an escalated effort carries across CLI reassignment (see the `intelligentAttemptLoop(... startTier)` call site near line 288).
- On each retry (`n > 1`), advance one rung:

```
EFFORT_LADDER = ['low','medium','high']           // auto-escalation rungs
TIER_LADDER   = ['simple','moderate','complex','expert']
nextRung(tier, effort):
  e = EFFORT_LADDER.indexOf(effort)               // 'off'/'xhigh' → -1
  if e >= 0 and e < 2:  return { tier, effort: EFFORT_LADDER[e+1] }   // climb effort within tier
  t = TIER_LADDER.indexOf(tier)
  if t < 3:             return { tier: TIER_LADDER[t+1], effort: 'low' }  // step tier, reset effort to low
  return { tier: 'expert', effort: 'high' }                              // maxed
```

  - `off` (e = -1) → falls through to tier step; normalize by treating the first retry from `off` as `low` is acceptable, but simplest correct behavior: an explicit `off`/`xhigh` that fails escalates by stepping tier and resetting effort to `low`. Document this; it is an edge case (the brain rarely emits `off`).
- Build the per-attempt task as `{ ...t, model_tier: currentModelTier, effort: currentEffort }` so `runImplementation → resolveRoute` picks up effort.
- Update the escalation log and the feedback lines to show `cli/tier@effort` (e.g. `escalating to complex@low`, `attempt 2 (codex/moderate@high): ...`).
- Carry `currentEffort` into the alternate-CLI reassignment call (pass as `startEffort`).

### 6. Visibility

The per-attempt log now prints `tier@effort`, which is where effort matters during a run. `resolveRoute` returning `effort` lets future tooling surface it. No separate `explain-routing` change in v1 (that command routes a bare description with no complexity/effort context, so it would only ever show the default — low value).

## Scope / Blast Radius

In scope:
- `scripts/router.mjs` — `VALID_EFFORTS`/`DEFAULT_EFFORT`, `effortFlags` for codex/droid/pi, `{{EFFORT}}` in their templates (remove hardcoded expert flags), `resolveRoute` substitution + return.
- `lib/prompts.mjs` — exported `VALID_EFFORTS`/`DEFAULT_EFFORT`.
- `lib/plan-schema.mjs` — optional `effort` field + validation.
- `lib/orchestrator/decompose.mjs` — brain prompt + `normalizeTask` default.
- `lib/orchestrator/core.mjs` — effort-first escalation ladder + `startEffort` carry + logs.
- Tests for every file above, **plus updating the PR #18 `pi` routing tests** in `scripts/router.test.mjs` (they assert exact commands that now include the `--thinking low` fragment).
- `README.md`, `CHANGELOG.md`, `ultraswarm.config.advanced.json` (an `effortFlags` override example + note).

Out of scope / unchanged:
- `gemini`, `grok`, `agy`, `opencode`, `pi-local` invocations (no effort dial).
- Host contract / generated host skills (worker-agnostic — SHA lock intact).
- `explain-routing` output formatting.
- `off`/`xhigh` in the *auto*-escalation ladder (reachable only via explicit brain/config choice).

## Verification / Success Criteria

1. `node --test` green, including new effort tests and the updated `pi` routing tests.
2. `resolveRoute({ cli:'codex', model_tier:'simple' }, {})` → command contains `-c model_reasoning_effort=low` (default effort).
3. `resolveRoute({ cli:'codex', model_tier:'simple', effort:'high' }, {})` → `...=high`.
4. `resolveRoute({ cli:'opencode', complexity_score:5 }, {})` → byte-identical to `DEFAULT_REGISTRY.opencode.models.simple.invocation` (no placeholder, unaffected).
5. `resolveRoute` throws on an invalid `effort` value, listing the allowed set.
6. `normalizeTask({ complexity_score: 10 })` → `effort === 'low'`; `normalizeTask({ effort: 'bogus' })` → `effort === 'low'`.
7. The escalation ladder unit test: from `{tier:'moderate', effort:'low'}` the retry sequence is `moderate@medium → moderate@high → complex@low → ...`, and tier only advances after effort reaches `high`.
8. `bash scripts/validate.sh` and `node scripts/generate-host-skills.mjs --check` pass.
9. README documents effort + the default-low behavior change; CHANGELOG records it; advanced config shows an `effortFlags` override.
