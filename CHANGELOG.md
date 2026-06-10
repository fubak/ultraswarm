# Changelog

All notable changes to ultraswarm are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project aims to follow
[Semantic Versioning](https://semver.org/).

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

[0.4.0]: https://github.com/fubak/ultraswarm/releases/tag/v0.4
[0.3.0]: https://github.com/fubak/ultraswarm/releases/tag/v0.3
[0.2.0]: https://github.com/fubak/ultraswarm/releases/tag/v0.2
[0.1.0]: https://github.com/fubak/ultraswarm/releases/tag/v0.1
