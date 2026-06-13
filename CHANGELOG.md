# Changelog

All notable changes to ultraswarm are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project aims to follow
[Semantic Versioning](https://semver.org/).

## [3.1.0] - 2026-06-13

New worker integrations and a per-task reasoning-effort axis.

### Added
- **`pi` worker** — the provider-agnostic [`pi`](https://github.com/earendil-works/pi)
  coding CLI, with an Anthropic Claude tier spread (Haiku → Sonnet → Opus → Opus with
  `--thinking high`). Run non-interactively via `pi -p`, which auto-executes tools like
  the other workers.
- **`pi-local` worker** — an always-on local/private worker that drives **Ollama** models
  (default `qwen3-coder:7b`/`:30b`, overridable) through the same `pi` binary. Brings
  fully local, offline-capable runs into the routing pool. Requires a configured `ollama`
  provider in `~/.pi/agent/models.json`; see the README.
- Optional `binary` field on registry entries so a logical worker can map to a different
  executable (`pi-local` → `pi`); `ShellWorkerAdapter` now probes the resolved binary.
- **Per-task effort levels** — the decomposition brain assigns `effort`
  (`off`/`low`/`medium`/`high`/`xhigh`) per task, independent of model tier, defaulting to `low`.
  Injected per CLI for `codex`/`droid`/`pi` via a `{{EFFORT}}` slot + `effortFlags` map.
- **Effort-first escalation** — on QA failure the attempt loop climbs effort
  (low → medium → high) before stepping up the model tier, so the cheapest correction is tried
  first. Expert-tier tasks now run at low effort by default and escalate as needed. Routine
  tasks (the common path) climb effort within their tier on retry; high-risk/complex tasks
  use the full effort-then-tier ladder.

## [3.0.0] - 2026-06-13

Major orchestration redesign focused on durability, safety, and measurable worker routing.

### Added
- SQLite run, task, attempt, approval, event, and repository-local worker-metric storage.
- Supervised worker adapters with process-group cancellation, timeouts, redacted bounded logs, and usage parsing.
- Capability and historical-metric routing with `explain-routing` output.
- Executable task contracts for commands, assertions, and allowed paths.
- Policy controls for worker quorum, concurrency, competition, approvals, forbidden paths, cost, isolation, and network access.
- Transactional integration worktrees and branches with explicit plan and merge approvals.
- Durable `run`, `merge`, `status`, `logs`, `cancel`, `resume`, `doctor`, `workers`, `explain-routing`, and `export` commands.
- Generated Claude, Codex, and Grok host skills with a shared contract and SHA-256 provenance lock.

### Changed
- Node 22 is now required for the built-in `node:sqlite` API.
- Claude Code now uses the same standalone runner as every other host; the embedded Workflow implementation was removed.
- `cli` and `model_tier` are optional plan fields when automatic routing is desired.
- Accepted task commits integrate away from the checked-out branch and land only through a final fast-forward merge.
- `--yes` remains as a compatibility alias for plan approval only and never approves merge.

### Safety
- Worker environments are allowlisted instead of inheriting host secrets.
- High-risk tasks receive automatic alternate workers when the healthy roster permits competition.
- Target-branch movement blocks merge and enters recoverable `stale_base` state.
- v2 JSONL journals are not resumed as v3 runs.
- Concurrent worker subprocesses are capped at `policy.maxParallelWorkers`.
- `forbiddenPaths` is enforced against the files a worker actually changed, not only the declared task files.
- Worker logs redact format-based secrets (`sk-ant-`/`sk-`/`gh*_` keys, JWTs, and `Authorization: Bearer` values), not just keyword assignments.
- `maxCostUsd` counts brain (model) spend as well as worker spend, so the budget ceiling is real.
- High-risk tasks that cannot field at least two usable workers are tombstoned rather than approved without competition.

### Reliability
- Every task is accounted for as merged, failed, or blocked; a thrown task can no longer vanish, and a mid-run merge failure still returns a complete, persisted result.
- Worktrees and `ultraswarm/*` branches are cleaned up after every run (and the integration worktree after merge); a crashed attempt resets its worktree before retry.
- SQLite uses WAL with `SQLITE_BUSY` retries and a stepwise migration runner; read-only commands keep working against a newer-schema database.
- `resume` recovers a crashed `running` run and a conflicted rebase (with `rebase --abort`), and merge approval is revoked in the store on `stale_base` so re-approval is mandatory.
- `cancel` escalates to `SIGKILL` and marks attempts cancelled; `export` fails loud on an unknown run id.
- The standalone runner refuses to start on Node < 22 with a clear message instead of a cryptic module crash.

### Validation
- 130 tests cover orchestration, integration isolation, state, policy, routing, supervision, host parity, and the safety/reliability hardening above.

## [2.4.3] — 2026-06-12

Enhanced Codex integration with native skill architecture and improved compatibility.

### Added
- **Native Codex skill**: Proper installable skill for `~/.agents/skills/ultraswarm` with dedicated installation script (`scripts/install-codex-skill.sh`)
- **Enhanced validation**: Added validation checks for Codex skill contract, installer functionality, and host-specific installation documentation
- **Comprehensive documentation**: Updated README with clear distinction between Claude Code and Codex installation methods and usage patterns

### Changed  
- **Codex integration architecture**: Deprecated legacy `AGENTS.md` approach in favor of skill-based integration for better maintainability
- **Installation workflow**: Codex users now get a streamlined symlink-based installation that auto-updates with git pulls
- **Documentation clarity**: README now explicitly covers both `/ultraswarm` (Claude Code) and `$ultraswarm` (Codex) invocation patterns

### Fixed
- **Cross-platform compatibility**: Codex skill now works reliably across different Codex installations
- **Installation robustness**: Installer handles existing installations gracefully and provides clear error messages

All 99 tests passing with 15/15 validation checks green. Verified end-to-end compatibility.

## [2.4.2] — 2026-06-12

High-risk path hardening: the competition/escalation path now works under the documented
config shape and fails cleanly. Closes #13, #14. Verified with two live end-to-end runs.

### Fixed
- **#13** — high-risk tasks no longer crash with *"CLI name must be a non-empty string"*
  when a worker fails early with no alternate, and retries no longer die with *"a branch
  named … already exists"*. The competition and fallback paths now gate on cli *usability*
  (a known worker resolvable via `DEFAULT_REGISTRY`/`overrides`, or an explicit `registry`
  entry) instead of `cfg.registry` alone — so **high-risk tasks actually run under the
  documented `enabled`/`overrides` config** (previously they always tombstoned), a
  missing/self alternate tombstones cleanly, and stale worktree branches are pruned before
  re-creation.
- **#14** — a dependent of a failed high-risk task is blocked across waves and every task
  appears in the final report (wired by v2.4.1's blocked-dependency reporting; now covered
  by a multi-wave high-risk test and a live run).

### Added
- High-risk integration tests (overrides-config competition + merge, no-alternate clean
  tombstone, multi-wave high-risk failure → blocked) and two **live** end-to-end runs
  through `bin`: a failing high-risk task with a blocked dependent (no crash, complete
  report), and the full happy path (competition → Sonnet judge → 3-lens Opus adversarial
  QA → merge). 99 tests total.

## [2.4.1] — 2026-06-12

Runner hardening: the standalone runner now works end-to-end through its CLI entry
path, with every runner issue (#6–#12) closed and the `bin` seam under test. Started
from a grok-CLI WIP branch that made the runner executable; this finishes the job.

### Fixed
- **#6** — `--decompose` now produces valid plans (`model_tier`/`risk` enums + CLI roster
  in the prompt, plus normalization of brain output so `model_tier:"haiku"`→`simple`,
  `risk:"low"`→`routine`). The documented `enabled`+`overrides` config shape resolves
  worker commands via `resolveRoute` (no hand-crafted `registry` needed).
- **#7** — external workers receive the clean task prompt, not the orchestration wrapper.
- **#8** — worker launch failures are classified (auth/transport/not-installed/timeout)
  with actionable hints (e.g. ``worker grok failed (auth) — run `grok login` ``); the
  worktree-auth limitation is documented.
- **#9** — no-op / scaffolding-only worker output can no longer pass review or merge.
- **#10** — dependents of a failed task are reported `blocked (dependency X did not
  merge)` and never run blind; blocking cascades across waves.
- **#11** — reports show per-task attempts, a merged/failed/blocked summary with a success
  rate, and token-capture coverage.
- **#12** — host scaffolding (`.ultraswarm-plan.json`, local config, `.ultraswarm/`,
  `.grok/`) no longer leaks into feature commits (`mergeWave` drops the redundant
  `git add -A`; `.gitignore` updated).
- **Silent-task-loss guard** — an unknown CLI returns a loud `cli_failed` instead of
  throwing (which `pipeline()` would swallow); `bin` prints a clean error + exit 1 on an
  invalid plan instead of an unhandled-rejection stack trace.

### Added
- End-to-end-through-`bin` seam tests (the coverage the v2.4.0 break slipped through),
  +13 tests overall (96 total).

## [2.4.0] — 2026-06-12

Portability release: a standalone runner lets Codex, Grok, or a bare shell host
the swarm — no longer Claude-Code-only — while Claude Code stays the primary host.

### Added
- **Standalone host runner** (`bin/ultraswarm.mjs` + `lib/`). Codex CLI, Grok CLI,
  or a bare shell can now drive the full pipeline: a host-supplied (or fallback-
  decomposed) **plan JSON** → dependency **waves → implement → adaptive QA → merge
  → report**. Shares a host-agnostic *pure core* with the skill (`scripts/router.mjs`
  reused; prompts + the QA cascade/competition algorithms lifted from `SKILL.md`,
  proven byte-for-byte by a parity harness). Implementation wrappers run as plain
  subprocesses (no model); only the brain roles call an LLM.
  - **`--plan-file <json>`** (host decomposes, runner executes) · **`--decompose
    "<task>"`** (built-in single-shot fallback) · **`--yes`** · **`--resume <id>`**
    (run journal keyed on label + prompt-hash, under `.ultraswarm/`).
  - **Plan contract** (`lib/plan-schema.mjs`): rejects unknown CLIs, bad tiers,
    dependency cycles, and unsafe task ids (`[A-Za-z0-9._-]` only).
  - `hosts/codex/AGENTS.md` + `hosts/grok/ultraswarm.md` launchers.
- **`claude -p` brain adapter** (`lib/llm/claude-cli.mjs`). The runner's QA/decompose
  brain **defaults to your local authenticated `claude` CLI — no `ANTHROPIC_API_KEY`,
  no separate API billing**, reusing your Claude Code auth. Falls back to the raw
  Anthropic API (`lib/llm/anthropic.mjs`, per-model request shaping — no effort/
  thinking on Haiku) when `claude` isn't on `PATH`. Override with
  `ULTRASWARM_BRAIN=claude-cli | anthropic-api`. Live-smoked against claude 2.1.175.
- **`package.json` + deps** (`@anthropic-ai/sdk`, `ajv`); CI now runs `npm ci`.
  `validate.sh` gains check [12] (parses `bin/` + `lib/`).

### Fixed
- **Command-injection hardening** (CRITICAL/MEDIUM, two security reviews): all git
  plumbing that touches plan-derived values now uses `execFileSync` with argv + `--`;
  task ids are charset-validated at the plan boundary. Worker-CLI and gate commands
  remain shell by design (trusted operator config), documented inline.
- **Brain tier→model-id resolution** (CRITICAL, final review): QA/review/judge/lens
  calls now resolve tier labels (`haiku`…) to real model ids at the agent boundary
  before hitting the brain (previously sent `'haiku'` to the API).
- **README accuracy pass**: routine-QA threshold (Haiku ≤50), opencode expert id
  (`xai/grok-4.20-0309-reasoning`), high-risk QA described as the cascade, router
  suite count (18), and a repository-layout tree that includes the new runner; plus
  concrete Codex/Grok/shell run instructions.

## [2.3.0] — 2026-06-12

Claude-model token optimization: spend strong-model tokens only where they change
the outcome, and stop paying the session model's rate for mechanical work.

### Changed
- **Per-phase routing is now real, not aspirational.** Phases 3 (merge) and 4
  (report) delegate their mechanical work to `Agent({ model: 'haiku' })` subagents
  (merge escalates to a `sonnet` subagent only on conflict). Previously the
  "Use Haiku for merge/report" guidance was inert — those phases ran inline in the
  orchestrator's main loop, which is pinned to the session model (typically Opus),
  so mechanical merge and report generation were billed at Opus rates.
- **High-risk adversarial QA is now a cost-aware cascade** (FrugalGPT-style). The
  `security` lens still always runs on the Opus ceiling (asymmetric risk); the
  `correctness` and `regression` lenses run on Sonnet first and escalate to Opus
  only when they refute or return borderline confidence (`<75`). The quorum (≥2
  votes), confidence-weighted score (≥60), and zero-critical-refutation guarantees
  are unchanged. Cuts the bulk of the ~250–550k-token high-risk path on clean work.
- **Trimmed `enhancedImplPrompt`** ~in half — removed the "intelligence" scaffolding
  the Bash-only implementation wrapper never used, reducing input tokens on every
  attempt and retry.

### Added
- **Fable 5 as an opt-in ceiling** via `intelligence.maxIntelligence` (default
  `false`). When enabled it flips two ceiling slots — the always-on security
  adversarial lens and the expert-escalation review — and expert-tier decomposition
  from Opus to Fable. Off by default: Fable costs ≈30% more tokens (its tokenizer)
  plus premium pricing, so it stays out of the hot path. `fable` is now a valid
  `claudeModels` value (router `validateConfig` accepts it).
- Behavior-harness test for the adversarial cascade (security-Opus + Sonnet→Opus
  escalation) and a router test for `fable` acceptance in `claudeModels`.

### Fixed
- `router.mjs`: clarified that `complexityThresholds.expert` is a validation
  ordering anchor only — `getTier` never reads it (expert is the unbounded top
  tier), so it does not affect routing. The `claudeModels` validation message now
  lists `fable`.

## [2.2.0] — 2026-06-11

### Added
- **Workflow behavior harness** (`scripts/workflow-harness.test.mjs`): 16
  node:test cases running the actual Workflow JS extracted from SKILL.md with
  mocked agent primitives — tier routing, adaptive QA depths, quorum/critical
  rules, escalation, exhaustion, immutability, and the dependency-wave guard.
  CI check [11] runs it on every push, so the embedded orchestration logic is
  behaviorally tested, not just parse-checked.
- **`validate.sh --json`** (built by the swarm: grok/grok-composer-2.5-fast,
  2 attempts — QA caught unescaped `node -e` interpolation and newline-unsafe
  JSON escaping on attempt 1): emits per-check results as a JSON array of
  `{check, name, pass, detail}`; default output and exit codes unchanged.
- README rewritten for v2.1 reality: dependency waves, tiered+flat override
  forms, adaptive QA with quorum/critical rules, verified model-tier table,
  measured cost calibration, `analyze` mode, and the invalid-model-ID
  troubleshooting entry.

## [2.1.0] — 2026-06-11

A hardening + validation release driven by a full live end-to-end test of the
v2.0 intelligence features — the swarm built its own model-router module, and
every bug the test surfaced is fixed here.

### Added
- **Model-router module** (built by the swarm itself in the live e2e:
  codex/gpt-5.5 won the t1 competition, grok wrote the tests, opencode wired
  CI): `scripts/router.mjs` — `DEFAULT_REGISTRY`, `loadConfig`
  (global+project merge per the documented rules), `validateConfig`
  (9 rules, never throws), `resolveRoute` (complexity→tier resolution,
  flat + nested override forms, timeout fallback chain).
- **Router test suite**: `scripts/router.test.mjs` — 17 node:test cases
  covering merge rules, tier boundaries, fallbacks, and validation errors.
- **CI checks [8]–[10]** in `scripts/validate.sh`: router syntax, router test
  suite, and `validateConfig` over the shipped advanced config — bad model
  IDs or malformed configs now fail CI on every push.
- **Dependency waves.** Phase 0 computes topological waves over task
  dependencies; each wave runs as its own Workflow chained on the previous
  wave's post-merge HEAD, so dependents always build on their prerequisites
  (a single Workflow's worktrees all fork the same base SHA — e2e-verified
  gap). The Workflow script fail-fasts if handed intra-invocation dependency
  edges; tombstoned tasks block their dependents loudly instead of letting
  them run blind.

### Fixed
- **Adversarial-lens verdict polarity** (live-e2e finding): the v2.0 lens
  prompt dropped the explicit polarity rule, so Opus lenses returned
  `refuted=true` with exonerating reasons — three doomed QA rounds rejected a
  judge-scored-91 implementation. The prompt now pins polarity: refuted=true
  only for concrete demonstrable problems, reasons describe problems only.
- **High-risk QA approval loopholes**: a single surviving lens vote could
  approve (the <2-votes check only warned); now ≥2 votes are a hard quorum.
  A `severity: critical` refutation could be outvoted by two high-confidence
  passes; now any critical refutation is an instant fail.
- **Verified model IDs**: the advanced config and registry tables referenced
  nonexistent models (gpt-4o-*, gemini-2-*, grok-5*, claude-opus-pro);
  replaced with IDs verified against the installed CLIs (gpt-5.4/5.5 family,
  gemini-2.5-*, grok-build, claude-*-4-x, opencode xai/google models).
  Documented that an invalid model ID does not fail fast (codex hangs to the
  wrapper timeout), so Phase 0 must verify configured models before routing.
- **Task-object mutation**: model-tier escalation now uses an immutable
  per-attempt copy; the escalated tier carries into the alternate CLI via an
  explicit `startTier` parameter instead of a shared-state side effect.

### Verified
- **Full live e2e of the intelligence pipeline** (2026-06-10): 3-task run —
  high-risk competition → judge panel (91 vs 73) → 3-lens Opus adversarial QA
  with feedback retries and gpt-5.4→gpt-5.5 escalation; routine simple-tier
  tasks approved first-attempt; resume-from-checkpoint recovered the run
  mid-flight after the lens-prompt fix with zero re-spent external tokens;
  token capture 6/6 CLI runs (~149k external, ~691k Claude subagent).
- **44-test offline harness** over the embedded Workflow JS: tier routing,
  adaptive QA depths, escalation, competition, exhaustion/tombstone,
  validation guards, quorum/critical rules, immutability, wave guard.

## [2.0.0] — 2026-06-09

A major intelligence upgrade transforming ultraswarm into an advanced AI orchestration platform with sophisticated prompt analysis, dynamic model routing, and ultra-granular task decomposition.

### Added - Intelligence Core
- **Phase 0a — Intelligent Prompt Analysis**: Automatic complexity assessment (5-dimensional scoring), model requirement analysis, and intelligent routing strategy generation
- **Dynamic Model Selection**: Multi-tier model routing per CLI based on task complexity (simple → moderate → complex → expert)
- **Ultra-Granular Task Decomposition**: Break work into atomic tasks with complexity ≤15/100, aggressive parallelization, and minimal dependencies
- **Adaptive Quality Assurance**: QA depth scales with complexity (Haiku for simple → Sonnet for moderate → Opus for expert-level tasks)
- **Claude Model Optimization**: Intelligent Claude model selection per orchestration phase (Haiku for cost-efficient operations, Sonnet for analysis, Opus for critical decisions)

### Added - Advanced Configuration
- **Enhanced Configuration Schema**: Support for intelligence settings, multi-model CLI overrides, task strategies, and complexity thresholds
- **Multi-Model CLI Support**: Full model selection capabilities for CLIs supporting multiple models (OpenCode, Codex, Gemini, etc.)
- **Intelligent Configuration Builder**: Interactive multi-stage configuration with model probing, auth verification, and complexity tier mapping
- **Advanced Configuration Example**: Complete `ultraswarm.config.advanced.json` template demonstrating all new capabilities

### Added - Enhanced Execution
- **Dependency-Aware Coordination**: Task graph analysis with independent cluster processing and critical path optimization  
- **Model Escalation**: Automatic model tier escalation on retry attempts for improved success rates
- **Competition Intelligence**: Multi-dimensional scoring for high-risk task competitions (correctness + model efficiency + complexity handling)
- **Performance Tracking**: Execution time monitoring, complexity achievement scoring, and model efficiency metrics

### Added - Intelligence Reporting
- **Comprehensive Intelligence Metrics**: Complexity efficiency, model usage distribution, parallelization effectiveness, task granularity analysis
- **Enhanced Token Accounting**: Phase-wise Claude token breakdown and model tier distribution for external CLI usage
- **Quality Insights**: Grafted improvements tracking, configuration optimization recommendations, performance analysis
- **Intelligence Efficiency Reporting**: Quantified gains from intelligent model routing vs uniform high-tier model usage

### Enhanced
- **CLI Registry**: Transformed to support complexity-based model selection with timeout scaling and capability matching
- **Workflow Script**: Completely rewritten with intelligent routing, enhanced schemas, and adaptive execution logic
- **QA System**: Multi-tier review process with confidence scoring, severity assessment, and expert escalation
- **Merge Process**: Dependency-aware merge sequencing with conflict prediction and resolution intelligence
- **Error Handling**: Enhanced failure analysis with complexity reassessment and model tier adjustment

### Configuration
- **New Configuration Options**: 
  - `intelligence.promptAnalysis` — Enable complexity assessment and model routing
  - `intelligence.modelRouting.claudeModels` — Claude model selection per orchestration phase
  - `overrides.<cli>.models.<complexity>` — Per-CLI model configuration by complexity tier
  - `taskStrategies.decomposition` — Ultra-granular task breakdown configuration
  - `taskStrategies.quality` — Adaptive QA strategy settings

### Breaking Changes
- Configuration schema significantly extended (backward compatible with legacy configs)
- Workflow script completely rewritten (new intelligence capabilities require updated orchestration)
- Task structure enhanced with complexity scoring and model tier assignments
- QA schema expanded with intelligence metrics and confidence scoring

### Backward Compatibility
- Legacy single-model CLI configurations still supported
- Basic mode available for users preferring original behavior
- Existing configurations automatically upgraded with sensible defaults
- All original CLI invocations preserved as "simple" tier defaults

## [0.4.0] — 2026-06-08

A validation + hardening + hygiene release — almost no new surface, but the
existing feature set is now proven.

### Added
- **Token capture-coverage.** The Phase 4 token-accounting block now shows a
  `captured/total` fraction (from a new `token_coverage` return field) and
  treats the external-token figure as an undercount — only codex (and droid in
  JSON mode) emit a parseable count; grok/gemini/opencode/agy report none.
- **CI + release validator.** `scripts/validate.sh` checks both manifests, the
  no-component-conflict invariant, version agreement, the embedded Workflow JS
  (parse + no resume-breaking tokens), and the example config; a GitHub Actions
  workflow runs it on every push/PR. A `CHANGELOG.md` (this file).

### Verified
- **High-risk competition path validated live** (first time): a security-sensitive
  signed-token task ran codex vs grok through competition → judge panel → 3-lens
  adversarial verify → merge, with no control-flow defects
  (`docs/notes/highrisk-e2e-2026-06-08.md`).
- **gemini** and **opencode** verified end-to-end (previously probe-only).
- Per-CLI token-reporting behavior documented from real runs.

### Changed
- Bumped the plugin version to 0.4.0 across both manifests.

## [0.3.0] — 2026-06-08

### Added
- **Per-run token accounting.** Phase 4 reports now end with a token-accounting
  block: measured Claude orchestration + QA tokens vs. measured external-CLI
  coding tokens, plus a clearly-labelled "Claude work offloaded" proxy estimate
  (never presented as an exact measured "tokens saved"). A new `cli_tokens`
  schema field captures each CLI's self-reported usage (best-effort); the
  Workflow sums it across all attempts and returns `external_tokens`.

### Fixed
- **Plugin manifest conflict.** `marketplace.json` no longer double-declares
  `skills` alongside `plugin.json` component discovery, which caused a load
  error on `/reload-plugins`. The plugin now installs and activates cleanly.
- Bumped the plugin version across both manifests.

## [0.2.0] — 2026-06-08

### Added
- **CLI-selection config.** `/ultraswarm config` interactive builder probes
  installed CLIs and writes a roster config; global
  `~/.claude/ultraswarm.config.json` + optional per-repo `ultraswarm.config.json`
  (project overrides global), with `enabled` allowlist and per-CLI `overrides`
  (`invocation`, `timeoutMs`, `specialty`, `alternate`).
- **droid** enabled in the worker roster (`droid exec`; requires a Factory
  subscription).

### Fixed
- **Per-CLI timeouts** are now honored via `timeouts[cli]` (the Workflow
  previously applied a single global timeout, so the registry's per-CLI budgets
  and `overrides.timeoutMs` were silently ignored).

## [0.1.0] — 2026-06-08

### Added
- Initial release of the `ultraswarm` Claude Code plugin: Claude orchestrates
  external AI coding CLIs (codex, gemini, grok, agy, droid, opencode) as workers
  in isolated git worktrees — decompose, author a Workflow, tiered QA, and
  Claude-only merge; the CLIs write the code.
- Phase 0 decomposition with CLI health + write probes and base-tree gate
  verification; per-run Workflow template (worktree implement → tiered QA);
  inline sequential merge; final report.
- Tiered QA: routine tasks get mechanical gates + one diff review; high-risk
  tasks get a 2-CLI competition, judge panel, and 3-lens adversarial verify.
- Packaged as a single-plugin marketplace (`.claude-plugin/`), MIT licensed,
  with README, design spec, implementation plan, and CLI verification registry.

[2.2.0]: https://github.com/fubak/ultraswarm/releases/tag/v2.2.0
[2.1.0]: https://github.com/fubak/ultraswarm/releases/tag/v2.1.0
[2.0.0]: https://github.com/fubak/ultraswarm/releases/tag/v2.0.0
[0.4.0]: https://github.com/fubak/ultraswarm/releases/tag/v0.4
[0.3.0]: https://github.com/fubak/ultraswarm/releases/tag/v0.3
[0.2.0]: https://github.com/fubak/ultraswarm/releases/tag/v0.2
[0.1.0]: https://github.com/fubak/ultraswarm/releases/tag/v0.1
