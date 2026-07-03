# v3.6.0 — Estimated-vs-used token report by CLI × model × effort, declarative usage capture, routing feedback

Date: 2026-07-02. Base: v3.5.18 (main @ 969a4e2).

## Goal

Make ultraswarm's run report end with an **estimated vs used token table broken down by CLI,
model, and effort level**, widen real usage capture beyond codex/opencode, feed measured worker
outcomes back into routing, and lower per-CLI onboarding friction — all without ever fabricating
a token figure (the v3.5.13 honesty invariant stands: structured usage or "not reported").

## Already done (verified on main, not in scope)

- Effort escalation on routine retries (PR #20, `nextEffort` in runner.mjs).
- Per-wave silent-task-loss reconcile + blocked propagation (#B4).
- Per-CLI landed/spent/overhead table (v3.5.15–17).
- Alias system, functional preflight, brain cost accounting.

## Descoped (with reason)

- **Shared repo-context file for worker prompts** — worker prompts are materialized per worktree,
  so "shared" context is still written N times; only the brain-side plan would shrink. Marginal.
- **Built-in usage shapes for pi/grok/agy/droid** — their structured-usage output is unverified;
  a wrong parser fabricates numbers. The declarative descriptor (Feature C) lets an operator add a
  verified shape via config instead.
- **Built-in external model pricing** — list prices for non-Anthropic models can't be verified
  here; `priceUsd` already returns 0 for unknown models and `config.intelligence.pricing` lets the
  operator supply rates. We derive attempt `cost_usd` from parsed tokens × the configured rate.

## Features

### A. Route-tuple capture (foundation)

The attempts table already stores `input_tokens`/`output_tokens`, but its `model` column holds the
**tier** (implement.mjs passes `t.model_tier`) and there is no effort column — so tokens can't be
attributed to a model or effort level.

- `lib/state/store.mjs`: migration **v3** — `ALTER TABLE attempts ADD COLUMN tier TEXT` and
  `ADD COLUMN effort TEXT`. `startAttempt` accepts `{ tier, effort }`.
- `lib/orchestrator/implement.mjs`: resolve the full route once (`resolveRoute`) instead of just
  the command; pass the **resolved model id** as `model` plus `tier`/`effort` to `startAttempt`.
  Legacy `cfg.registry` path keeps tier-as-model (no route info exists there).

### B. Estimation + calibration → the CLI × model × effort report

- New `lib/llm/estimate.mjs`: `estimateTaskTokens(task, route, calibration)` — prefer the measured
  per-`(cli, model, effort)` average from calibration; fall back to a static tier curve
  (simple 10k / moderate 30k / complex 75k / expert 150k), documented as a heuristic floor.
- `lib/state/store.mjs`: `route_calibration` table (cli, model, effort, tier, attempts,
  total_tokens; PK cli+model+effort+tier) + `recordCalibration`/`getCalibration`. Updated in
  implement.mjs whenever an attempt reports structured usage. Persists across runs (same sqlite).
- `lib/orchestrator/runner.mjs`: aggregate attempts by `(worker, model, effort)` → `routeUsage`
  rows `{ cli, model, effort, attempts, used|null, estimated }`; estimates come from resolving each
  planned task's route + `estimateTaskTokens`. Estimated is always shown; `used` is null unless
  structured usage was captured (honesty invariant).
- `lib/orchestrator/report.mjs`: the report **ends** with a `TOKENS BY CLI / MODEL / EFFORT`
  fixed-width table — columns `CLI | model | effort | est. | used | Δ | attempts`, total row,
  `(not reported)` for null used, Δ only where both sides exist.
- Ledger line: if `merged+failed+blocked` rows ≠ `taskCount`, append a loud
  `⚠ LEDGER MISMATCH` line (red) — the counts must always reconcile.

### C. Declarative usage descriptors + gemini capture

- `lib/workers/adapters.mjs`: `parseUsage(text, descriptors)` becomes descriptor-driven. A
  descriptor is `{ input, output, cost? }` dot-paths evaluated against each parsed JSON line *and*
  against whole-stdout JSON (gemini emits one object, not JSONL). Wildcard `*` path segment for
  keyed maps (gemini's `stats.models.<model>`).
- `lib/router.mjs` `DEFAULT_REGISTRY` gains `usage` arrays for codex (`usage.input_tokens/…`),
  opencode (`part.tokens.input/…` + `part.cost`), gemini (`stats.models.*.tokens.prompt` /
  `.candidates`). Gemini invocations gain `--output-format json`. Aliases/overrides may set
  `usage` (validated: array of objects with string `input`+`output`).
- CAPABILITIES dedupe: move `strengths`/`structuredOutput`/`resume` into `DEFAULT_REGISTRY`
  entries; `capabilities()` derives from the effective registry (aliases inherit via `extends`).
  The parallel `CAPABILITIES` map is deleted.
- `lib/orchestrator/implement.mjs`: attempt `cost_usd` = adapter-reported cost, else
  `priceUsd(resolvedModel, usage, cfg)` when > 0 — so operator-configured rates make
  `maxCostUsd` cover worker spend.

### D. Prompt efficiency

- `lib/prompts.mjs`: `capWorkerPrompt(text, max = 64_000)` — hard cap with an explicit
  `[ultraswarm: truncated N chars]` marker; feedback items capped (500 chars each, last 10 kept).
  Applied in implement.mjs with a logged warning when truncation fires (no silent caps).
- `runRoutineTask`: rejection feedback now includes the prior attempt's changed files so the
  retry converges instead of re-exploring.

### E. Routing feedback

- `lib/orchestrator/decompose.mjs`: `decompose(..., { metrics })` — roster lines gain measured
  win rates (`codex (backend…; 12 runs, 92% pass)`) when the store has `worker_metrics`.
- `bin/cli.mjs` `runCommand`: open the repo store before planning and pass its metrics.
- `doctor`: renders a WORKER TRACK RECORD table from `worker_metrics` (and includes it in
  `--json`).

### F. `doctor --models`

Prints the resolved model per CLI per tier (registry + overrides + aliases) so stale pins are
visible at a glance. Optional `modelListCmd` per registry entry/alias: when set, runs it and warns
about resolved models missing from the CLI's own list. No built-in `modelListCmd` defaults
(unverifiable per CLI).

### G. `add-cli` + `replan` commands

- `ultraswarm add-cli <name> --binary <bin> [--extends <builtin>] [--model <id>]`: probes the
  binary, generates a valid alias skeleton (models map with the standard prompt-file invocation),
  validates via `validateConfig`, and merges it into the project `ultraswarm.config.json`
  (refusing to clobber an existing key).
- `ultraswarm replan <runId>`: emits a plan JSON of the run's failed/blocked tasks (from the
  stored plan), ready for `run --plan-file -` — no more retyping lost tasks.
- `hosts/host-contract.json` commands list gains both; host skills regenerated.

## Execution plan

Phased; each phase lands with its tests, `node --test` green before the next starts.

1. **Parallel** (disjoint files): α = Feature A store parts + B calibration/estimate module;
   β = Feature C adapters/registry work.
2. **Core wiring** (single-threaded, tightly coupled): implement.mjs route capture,
   runner routeUsage, report table, prompts cap (A/B/C/D glue).
3. **Parallel**: γ = E+F+G CLI surface (cli.mjs, decompose.mjs, render.mjs);
   δ = docs (README, CHANGELOG, this plan cross-links).
4. Version bumps 3.5.18 → **3.6.0** in package.json, package-lock.json,
   .claude-plugin/plugin.json, .claude-plugin/marketplace.json (both spots);
   host-contract regen; `bash scripts/validate.sh` + full `node --test`.
5. Branch `feature/usage-report-v3.6` → PR → `validate` CI green → self-merge → tag `v3.6.0` +
   GitHub release.
6. **Real scenario verification**: from the released tag in a temp clone — mock brain
   (`ULTRASWARM_BRAIN=mock`) + node-binary alias workers, full `run --approve-plan`, assert the
   report ends with the CLI × model × effort estimated-vs-used table and status/export show
   model+effort on attempts; restricted-PATH release-verify recipe.

## Risks

- **SQLite migration**: additive columns only; v2 dbs upgrade in place; test with a pre-seeded v2 db.
- **Gemini JSON shape**: guarded by descriptor tests on fixture output; if the real CLI differs,
  the parser finds nothing and reports "not reported" — never a wrong number.
- **Estimate quality**: first-run estimates are a labeled heuristic; calibration self-corrects.
  The report labels the column `est.` and the docs state the curve.
