---
name: ultraswarm
description: Orchestrate complex coding work through the ultraswarm v3 standalone runner.
---

# Ultraswarm v3 for claude

Use the repository's standalone runner as the only orchestration implementation. Do not recreate orchestration in the host, and do not implement delegated feature code directly.

Invocation: `/ultraswarm`

## Runner

Resolve the checkout from `ULTRASWARM_HOME`, this skill's real path, or `~/projects/ultraswarm`. It must contain `bin/ultraswarm.mjs` and installed dependencies. Node >=22 is required.

## Workflow

1. Inspect the target repository and prepare a validated JSON plan.
2. Preview with `node <root>/bin/ultraswarm.mjs run --plan-file .ultraswarm-plan.json`.
3. Show tasks, waves, routing explanations, policy findings, and gates. Obtain explicit plan approval.
4. Execute with `node <root>/bin/ultraswarm.mjs run --plan-file .ultraswarm-plan.json --approve-plan`.
5. Report the run ID and status. Integrated work remains off the checked-out branch.
6. Obtain separate merge approval, then run `node <root>/bin/ultraswarm.mjs merge <run-id> --approve`.

Never translate approval from an earlier conversation into either runner approval flag.

## Operations

- `doctor` and `workers`: policy, gates, CLI health, and capabilities.
- `explain-routing <task>`: worker ranking with fit and repository-local metrics.
- `status [run-id]`: durable run, task, and attempt state.
- `logs <run-id> [--after N] [--json]`: append-only events.
- `cancel <run-id>`: terminate worker process trees and mark cancelled.
- `resume <run-id>`: recover an awaiting-merge or stale-base run.
- `export <run-id>`: machine-readable provenance bundle.
- User-defined `aliases` in config appear in the roster alongside built-in CLIs; `doctor`/`workers` and `explain-routing` show them, and the decomposition roster routes to them by specialty (respecting any `maxTier` cap).

## Plan Contract

Each task requires `id`, `description`, `files`, `complexity_score`, `risk`, `dependencies`, and `prompt`. `cli` and `model_tier` are optional. Use `contract.commands`, `contract.assertions`, and `contract.allowed_paths` for executable acceptance criteria. High-risk tasks must compete unless policy says otherwise.

The runner owns worktrees, retries, worker supervision, routing, QA, integration, persistence, recovery, and merge. Treat its exit codes and durable state as authoritative.
