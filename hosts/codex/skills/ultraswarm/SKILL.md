---
name: ultraswarm
description: Orchestrate complex coding work through the ultraswarm v3 standalone runner.
---

# Ultraswarm v3 for codex

Use the repository's standalone runner as the only orchestration implementation. Do not recreate orchestration in the host, and do not implement delegated feature code directly.

Invocation: `$ultraswarm`

## Runner

Resolve the checkout from `ULTRASWARM_HOME`, this skill's real path, or `~/projects/ultraswarm`. It must contain `bin/ultraswarm.mjs` and installed dependencies. Node >=22 is required.

## Workflow

1. Functionally verify the worker pool: `node <root>/bin/ultraswarm.mjs preflight`. This runs a cached smoke test (not just `--version`) and prints a roster marking each CLI INSTALLED and FUNCTIONAL. Drop any worker shown UNUSABLE — do not pin a task to it — and confirm at least the policy minimum of functional workers remain.
2. Inspect the target repository and prepare a validated JSON plan. Scope each task's `contract.allowed_paths` to include coupled test files, not just the obvious source — flipping a value often has a test blast radius.
3. Preview with `node <root>/bin/ultraswarm.mjs run --plan-file .ultraswarm-plan.json`. Show tasks, waves, routing explanations, policy findings, and gates. Obtain explicit plan approval.
4. Execute with `node <root>/bin/ultraswarm.mjs run --plan-file .ultraswarm-plan.json --approve-plan`, keeping the runner's stderr visible and relaying its live progress to the user as it streams: wave headers, per-agent dispatch lines, gate results, and the periodic active/idle heartbeat that shows every worker's state.
5. Report the run ID and present the runner's final human-readable summary — per-task outcome, which worker landed each task, and the tokens-saved estimate (the implementation work external CLIs did off your context). Integrated work remains off the checked-out branch.
6. Commit any working-tree changes first, then obtain separate merge approval and run `node <root>/bin/ultraswarm.mjs merge <run-id> --approve`.

Never translate approval from an earlier conversation into either runner approval flag.

When the functional pool is thin (e.g. only one CLI passes preflight), forced high-risk competition can be net-negative — a broken competitor can corrupt the good lane. Prefer disabling competition (policy) over racing unverified workers, and compensate by reviewing the full diff before merge.

## Operations

- `preflight [--smoke] [--json]`: functionally verify enabled CLIs (cached); `--smoke` forces a re-probe.
- `doctor` and `workers` (`--json` for machine output): policy, gates, CLI health, and capabilities.
- `explain-routing <task>`: worker ranking with fit and repository-local metrics.
- `status [run-id] [--json]`: durable run, task, and attempt state (human roster by default).
- `logs <run-id> [--after N] [--json]`: append-only events.
- `cancel <run-id>`: terminate worker process trees and mark cancelled.
- `resume <run-id>`: recover an awaiting-merge or stale-base run.
- `export <run-id>`: machine-readable provenance bundle.
- Per-task worktrees default to `<repo>/.ultraswarm/worktrees` so Node build gates resolve the repo's `node_modules`; override with `--worktree-root`.
- User-defined `aliases` in config appear in the roster alongside built-in CLIs; `preflight`/`doctor`/`workers` and `explain-routing` show them, and the decomposition roster routes to them by specialty (respecting any `maxTier` cap).

## Plan Contract

Each task requires `id`, `description`, `files`, `complexity_score`, `risk`, `dependencies`, and `prompt`. `cli` and `model_tier` are optional. Use `contract.commands`, `contract.assertions`, and `contract.allowed_paths` for executable acceptance criteria. High-risk tasks must compete unless policy says otherwise.

The runner owns worktrees, retries, worker supervision, routing, QA, integration, persistence, recovery, and merge. Treat its exit codes and durable state as authoritative.
