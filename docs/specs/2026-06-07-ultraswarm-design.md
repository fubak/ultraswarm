# /ultraswarm — Design Spec

**Date:** 2026-06-07
**Status:** Implemented and shipped as the `ultraswarm` plugin (v0.1, 2026-06-08). This document is the original design; the canonical implementation is `skills/ultraswarm/SKILL.md`, and runtime CLI status lives in `docs/notes/cli-verification.md`. Amendment notes below record where the build diverged from this design.

## Problem

The built-in `ultracode` workflow is powerful because of the `Workflow` tool underneath it: deterministic JS orchestration, `agent()` fan-out, JSON-schema-validated outputs, `pipeline()` parallelism, phase/progress UI, adversarial verification, token budgets, and resume-from-checkpoint. But all coding work is done by Claude subagents, which is expensive in Claude tokens.

`/ultraswarm` keeps the entire ultracode orchestration machinery while delegating the bulk coding work to locally installed external AI CLIs (codex, gemini, grok, agy, droid, opencode). Claude acts purely as orchestrator, QA gate, and merge authority.

## Approved Decisions

| Decision | Choice |
|---|---|
| Write model | Direct writes in isolated git worktrees (one per task attempt) |
| Routing | Specialty routing by default; competition (2–3 CLIs, same task) for high-risk tasks |
| Engine | Workflow tool with thin Claude CLI-wrapper agents |
| QA depth | Tiered by risk: mechanical + single review for routine; judge panel + 3-lens adversarial verify for high-risk |
| Packaging | New skill at `~/.claude/skills/ultraswarm/SKILL.md`, invoked as `/ultraswarm <task>` |

## Architecture

```
/ultraswarm <task>
  │
  ├─ Phase 0 (inline Claude, pre-Workflow)
  │    explore codebase → decompose into task list → user confirms plan
  │
  ├─ Workflow script (authored per-task by Claude) — covers Implement + QA,
  │  returns {approved, failed}
  │    ├─ Phase 1: Implement   pipeline() over tasks
  │    │     each agent() = thin Claude wrapper:
  │    │       create worktree → run assigned CLI via Bash →
  │    │       build/typecheck/test in worktree →
  │    │       return schema-validated JSON
  │    │     high-risk tasks: fan out to 2–3 CLIs in separate worktrees
  │    │
  │    └─ Phase 2: QA          pipelined (starts per-task as Phase 1 finishes)
  │          routine: mechanical gates + 1 Claude diff-review agent
  │          high-risk: judge panel picks winner → 3-lens adversarial verify
  │          fail → retry same CLI w/ feedback (max 2) → reassign CLI → Claude fixes
  │
  ├─ Phase 3: Merge       (inline, orchestrator Claude, after the Workflow returns)
  │     sequential, Claude-only — apply approved worktree diffs one at a time,
  │     full gate after each
  │
  └─ Phase 4: Final verify & report   (inline, orchestrator Claude)
        full suite + coverage, per-task summary table, loud failure list
```

> **Amendment (implementation plan):** Phases 3–4 run inline in the orchestrator after the Workflow returns — the Workflow covers only Implement + QA and returns `{approved, failed}`. Conflict resolution (Rule 7 judgment) and user visibility are better in the main loop.

## CLI Worker Registry

Maintained as a table inside the skill. Each entry: invocation command, auto-approve flags, specialty, timeout, health check.

| CLI | Invocation (run inside the worktree) | Specialty | Status |
|---|---|---|---|
| codex | `codex exec -s workspace-write --skip-git-repo-check "$(cat .ultraswarm-prompt.txt)" </dev/null` | Backend, logic, algorithms, debugging | verified (re-verified 2026-06-08 with corrected flags; slow ~5 min/task) |
| gemini | `gemini --yolo -p "$(cat .ultraswarm-prompt.txt)"` | Frontend, UI, CSS, components | verified |
| droid | `droid exec "$(cat .ultraswarm-prompt.txt)"` (requires a Factory subscription) | General full-stack implementation, refactoring | enabled (help-verified; not smoke-tested without a plan) |
| grok | `grok --always-approve -p "$(cat .ultraswarm-prompt.txt)"` | Tests, refactors, general | verified |
| agy | `agy --print-timeout 15m -p "$(cat .ultraswarm-prompt.txt)"` | Docs, boilerplate, general | verified |
| opencode | `opencode run --agent build -m "xai/grok-build-0.1" "$(cat .ultraswarm-prompt.txt)"` | Junior tier: boilerplate, lint/type fixes, simple tests, JSDoc | verified |

- **Amendment (2026-06-07):** registry expanded to six workers — droid and opencode added by user request 2026-06-07. All invocations verified and recorded in `docs/notes/cli-verification.md` (source of truth, including quirks).
- **Amendment (2026-06-08):** all six workers enabled. droid uses `droid exec "<prompt>"` and requires a Factory subscription (help-verified; could not be smoke-tested without a plan). Per-machine CLI availability is resolved at runtime by Phase 0's health check + write probe.
- **Health check:** Phase 0 runs `<cli> --version` for every registered CLI. A missing or broken CLI is dropped from routing and reported loudly — never silently skipped.
- **Timeouts:** per-CLI timeout (default 10 min, configurable per task in the registry). On timeout: kill, count as a failed attempt, enter the fail path.

## Phase 0 — Decompose (inline Claude)

1. Explore the target codebase (structure, conventions, test commands, build commands).
2. Produce a task list; each task:
   ```
   { id, description, files, cli, risk: "routine" | "high", acceptance }
   ```
3. **Self-contained prompts.** External CLIs have zero conversation context. Every worker prompt must carry: project name + tech stack, exact file paths, conventions to follow, expected outcome, constraints, and acceptance criteria.
4. Detect the project's gate commands (build, typecheck, test, lint) and embed them in the Workflow script as constants.
5. Present the plan to the user for confirmation. **User confirmation here is the Workflow opt-in gate** — the Workflow is never launched without it.

Risk classification: a task is **high** if it touches auth/security/payments, changes shared interfaces or data models, has architectural impact, or modifies logic with no test coverage. Otherwise **routine** (tests, docs, boilerplate, isolated components, mechanical refactors).

## Phase 1 — Implement

`pipeline()` over the task list (no barrier — QA for task A starts while task B is still coding).

Each implementation `agent()` is a **thin wrapper** Claude subagent whose prompt instructs it to:

1. Create a worktree: `git worktree add ~/worktrees/<reponame>-us-<taskid>-<cli> -b ultraswarm/<taskid>-<cli>`
   *(Amendment: worktrees live in `~/worktrees/`, not `<repo>/.ultraswarm/` — nested worktrees pollute `git status` and test globs in the main tree.)*
2. Write the self-contained prompt to `<worktree>/.ultraswarm-prompt.txt`, then run the assigned CLI inside the worktree via Bash with its auto-approve flags as `<cli> ... "$(cat .ultraswarm-prompt.txt)"` — multi-line prompts as direct shell arguments break quoting across the different CLIs.
3. After the CLI exits: run build/typecheck/tests inside the worktree.
4. Return schema-validated JSON:
   ```json
   {
     "status": "ok" | "cli_failed" | "gates_failed" | "timeout",
     "files_changed": ["..."],
     "tests": { "passed": 0, "failed": 0, "command": "..." },
     "summary": "...",
     "concerns": ["..."]
   }
   ```
   Schema enforcement happens at the Workflow layer (the `schema` option), so malformed outputs are retried automatically.

**Competition mode (high-risk tasks):** the same task prompt is dispatched to 2–3 CLIs in parallel, each in its own worktree. All results flow to the Phase 2 judge panel.

The wrapper does not write feature code. Its only edits are mechanical (e.g., none ideally; at most reverting junk files the CLI created outside scope, reported in `concerns`).

## Phase 2 — QA (tiered)

**Routine tier:**
- Mechanical gates already ran in Phase 1 (build/typecheck/tests in worktree).
- One Claude review agent reads `git diff main...<branch>` in the worktree and checks: correctness vs. acceptance criteria, convention conformance, no scope creep, no silent error swallowing. Verdict schema: `{ approve: bool, issues: [...] }`.

**High tier:**
1. **Judge panel** (competition tasks): one agent per competing worktree scores the diff (correctness, simplicity, convention fit); winner advances, losers' worktrees are cleaned up. Judges may note ideas worth grafting; grafting is done by Claude in Phase 3, not by re-running CLIs.
2. **3-lens adversarial verify** on the winner (or the single attempt): correctness lens, security lens (the 8 mandatory security checks), regression lens. Each is prompted to *refute* the work. Majority vote (2 of 3 approve) required to advance.

**Fail path (loud, never silent):**
1. Re-dispatch to the **same CLI** in the same worktree with reviewer feedback appended to the prompt — max 2 retries.
2. Then reassign to a **different CLI** (fresh worktree, or its existing competition worktree if it was a competitor).
3. Last resort: **Claude implements the task directly** (the only case where Claude writes feature code), flagged in the final report.

## Phase 3 — Merge (sequential, Claude-only)

- Approved worktrees are merged one at a time into the main working tree (apply the branch diff; `git merge --squash` or `git diff | git apply` depending on cleanliness).
- Full gate (build + typecheck + tests + lint) after **each** merge; a regression stops the line and enters the fail path for the offending task.
- Conflicts: Claude resolves by picking one source of truth (Rule 7 — pick, don't blend), documented in the report.
- All worktrees and `ultraswarm/*` branches are cleaned up afterward.

## Phase 4 — Final verify & report

- Full test suite + coverage check (80% floor per testing rules).
- Report table: per task — CLI used, attempts/retries, QA verdict, files touched.
- Explicit, loud list of anything skipped, failed, or escalated to Claude (Rule 12). "Done" is never reported unless the final gate passed.

## Error Handling Summary

| Failure | Response |
|---|---|
| CLI binary missing/broken | Dropped from routing in Phase 0, reported |
| CLI timeout | Kill, count as failed attempt → fail path |
| CLI output fails worktree gates | Fail path (retry w/ feedback → reassign → Claude) |
| Malformed agent JSON | Workflow schema layer auto-retries |
| `agent()` returns null (skipped/dead) | Treated as failed attempt → fail path |
| Merge conflict | Claude resolves, pick-don't-blend, documented |
| Post-merge regression | Stop the line, fail path for offending task |

## What's Preserved vs. Traded

**Preserved from ultracode:** deterministic control flow, schema validation, pipeline parallelism, progress UI, resume-from-checkpoint (`resumeFromRunId`), budget tracking, adversarial verification.

**Traded:** each CLI call costs one thin Claude wrapper subagent (mostly blocking on Bash — cheap); external CLI output quality is more variable than Claude subagents — compensated by tiered QA and competition mode.

## Out of Scope (YAGNI)

- No persistent saved workflow script — the Workflow script is authored per-invocation because task lists, routing, and risk tiers genuinely vary.
- No changes to `/swarm-cli` or `/multi-execute` — they remain as lighter-weight alternatives.
- No cost/latency benchmarking of CLIs (can be added later if routing needs tuning).
- No remote/CI execution — local worktrees only.

## Implementation Deliverables

1. `~/.claude/skills/ultraswarm/SKILL.md` — the skill: registry, decomposition guidance, Workflow script template, QA prompts, merge protocol. (Also mirrored in this repo for versioning.)
2. This repo (`fubak/ultraswarm`) holds the canonical skill source, spec, and future evolution.
3. Verification of grok/agy non-interactive flags, recorded in the registry.
