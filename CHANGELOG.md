# Changelog

All notable changes to ultraswarm are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project aims to follow
[Semantic Versioning](https://semver.org/).

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
