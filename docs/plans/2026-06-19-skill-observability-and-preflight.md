# Skill observability + functional preflight

Date: 2026-06-19
Status: implemented

## Context

A live `/ultraswarm` session (4 tasks, 4/4 merged) reported that the orchestration model is sound but
two layers are weak:

1. **CLI health is a lie.** `ShellWorkerAdapter.probe()` only runs `<binary> --version`. On the test
   machine all CLIs pass it, yet `gemini` auth was permanently dead (every execution failed) and
   `opencode` was destructive (mutated shared `node_modules`, corrupting the working codex lane).
   Tasks were routed to workers that could not do work.
2. **Output is machine-shaped.** `run`/`status`/`doctor`/`logs` printed `JSON.stringify`; progress was
   terse `· msg` stderr lines. No per-agent visibility, no "tokens saved".
3. **Worktrees lacked `node_modules`** (defaulted to `~/worktrees`), so Node build gates died.

## Decisions

- **Functional verification = cached exec smoke test.** Run each enabled CLI on a trivial
  file-creation task in an isolated temp dir; verify the artifact appears (verify-by-artifact, the
  rule `docs/notes/cli-verification.md` already established). Cache by `name@version`, 24h TTL.
- **Human-readable output by default, `--json` opt-out.** Preserves the machine path behind a flag.
- **Rich stderr progress stream** (run stays blocking) rather than background + poll.

## Implementation

| Concern | Change |
|---|---|
| Smoke test | `lib/workers/smoke.mjs` — `smokeTest(adapter)` in an isolated tmp dir; reuses `ProcessSupervisor` + `classifyWorkerError`. New `no_op` kind = clean exit, no artifact. |
| Probe + cache | `WorkerManager.functionalProbes()` — merges the smoke verdict into `probes()`, sets `healthy=false` for non-functional workers, caches in `.ultraswarm/functional-probe.json`. |
| Routing | `routePlan(... , probes)` accepts pre-verified probes; `routeTask` + `minimumHealthyWorkers` already filter on `healthy`, so no routing-algorithm change. |
| Output | `lib/render.mjs` (pure formatters); `bin/cli.mjs` renders by default, `--json` preserves JSON. New `preflight` command. |
| Progress | per-agent dispatch line via `onStart` + gate summary in `implement.mjs`; wave headers, review verdicts, and a ~15s active/idle heartbeat in `runner.mjs` (`startHeartbeat`, store-backed, best-effort). |
| Summary | `buildReport` adds per-worker contribution + an honest tokens-saved floor. `mergeWave` threads `cli` so the worker column is attributable. |
| Worktrees | default `worktreeRoot = <repo>/.ultraswarm/worktrees`. |
| Hosts/docs | single-sourced `body()` template regenerated for all 5 hosts; `preflight` added to the host contract; README + CHANGELOG updated. |

## Honesty notes (Rule 12)

- Worker token capture is best-effort (regex). The tokens-saved figure is framed as a floor, never a
  billing number.
- The destructive-`npm install` hazard of a shared `node_modules` is mitigated by the functional
  probe dropping such workers, not by sharing `node_modules` unguarded.

## Verification

`node --test` (full suite), `bash scripts/validate.sh` (17 checks incl. host-skill SHA lock + parity),
`node scripts/generate-host-skills.mjs --check`, live `preflight`/`doctor`, and a mock-brain e2e.
