# Changelog

All notable changes to ultraswarm are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project aims to follow
[Semantic Versioning](https://semver.org/).

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
