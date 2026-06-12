# /ultraswarm — Portable Host Runner Design Spec

**Date:** 2026-06-12
**Status:** Proposed (design/feasibility — no implementation yet)
**Supersedes nothing.** Extends the original design (`docs/specs/2026-06-07-ultraswarm-design.md`); the canonical implementation remains `skills/ultraswarm/SKILL.md`.

## Problem

ultraswarm's orchestrator — decomposition, model routing, the adaptive QA cascade, judge
panels, merge, and report — runs **only inside Claude Code**, because it is built on the
`Workflow` tool: deterministic JS with `agent()` / `parallel()` / `pipeline()`,
schema-validated structured outputs, resume-from-checkpoint, and the `/workflows` progress
UI. None of that exists in Codex CLI (`codex exec`) or Grok CLI (`grok -p`), which are
single-shot coding agents. Today, Codex and Grok can only be *workers* (they are in the
registry); they cannot *drive* the swarm.

We want Codex or Grok — or a bare shell — to be able to **host** (launch and drive) the same
swarm, without giving up Claude Code as the primary, highest-fidelity host.

## Approved Decisions

| Decision | Choice |
|---|---|
| Primary host | **Claude Code + `Workflow`** stays canonical and unchanged — highest fidelity (native live UI + resume) |
| Compatible hosts | **Codex CLI, Grok CLI, and bare shell**, via a new standalone Node runner |
| Orchestrator brain | **Anthropic / Claude models** (haiku/sonnet/opus/fable), behind a provider abstraction so others *can* slot in later — but Claude is the default and primary |
| Convergence | **Keep both orchestrators**, sharing a **pure core** (registry, prompts, algorithms); each host supplies its own thin primitives layer |
| Engine | Reimplement the `Workflow` primitives in plain Node for the standalone runner; reuse the Claude Code `Workflow` natively when hosted there |
| Decomposition | **Host agent decomposes; runner executes.** Codex/Grok/Claude Code produce a validated **plan JSON** (they have repo access); the runner validates and executes it. A bare-shell `--decompose "<task>"` fallback exists but is explicitly lower-fidelity (no repo exploration) |
| Runner scope | The runner owns everything *after* decomposition: validate plan → compute dependency waves → implement + QA → **merge (gate after each)** → report → cleanup |
| Packaging | New `bin/` + `lib/` standalone runner in this repo; `skills/ultraswarm/SKILL.md` unchanged |

## Core insight — why this is low-risk

Two facts make the port a lift-and-adapt rather than a rewrite:

1. **The orchestration logic is already decoupled.** `scripts/workflow-harness.test.mjs`
   extracts the JS from `SKILL.md` and runs it *outside* the Workflow runtime, injecting
   mock `agent()` / `parallel()` / `pipeline()` / `log()` / `phase()`. The standalone runner
   is "replace those mocks with production implementations."
2. **Most agent calls stop being LLM calls.** In the standalone runner the implementation
   wrappers — one per task attempt, the most numerous calls — collapse to plain Node:
   create worktree, run the external CLI as a subprocess, run gates, return JSON. **No model
   is involved.** Only the *brain* roles stay LLM-powered: decompose, review, judge,
   adversarial lenses, conflict resolution, report.

So the standalone runner = (engine primitives in Node) + (one LLM client for the brain) +
(the existing orchestration algorithms lifted into modules) + (the existing `router.mjs`
reused verbatim).

## Architecture

```
                       ┌─────────────────────── pure core (host-agnostic) ───────────────────────┐
  Claude Code host ──▶ │  scripts/router.mjs   registry/route/config (REUSED AS-IS)               │
   (Workflow engine,   │  lib/prompts.mjs      QA/judge/lens/decompose prompt templates + schemas │
    native agent/      │  lib/orchestrator/    attempt loop, escalation, competition, QA cascade, │
    parallel/pipeline) │                       quorum/critical rules — the algorithms             │
                       └────────────────────────────────────────────────────────────────────────┘
  Codex / Grok / shell                    ▲ injected primitives ▲
   host  ──▶ bin/ultraswarm.mjs ──▶ lib/engine.mjs (pipeline/parallel/phase/log/budget)
                                    lib/llm/*       (Anthropic brain client + brain-router)
                                    lib/journal.mjs (resume), lib/validate.mjs (schema+retry)
```

Proposed layout:

```
ultraswarm/
  bin/ultraswarm.mjs            # standalone CLI: --plan-file <json> [--decompose "<task>"] --yes
  lib/
    engine.mjs                  # pipeline()/parallel()/phase()/log()/budget — Node Workflow shim
    journal.mjs                 # per-run JSONL journal + replay (resume parity)
    validate.mjs                # JSON-schema validate (ajv) + retry loop
    prompts.mjs                 # SHARED: prompt templates + schemas (lifted from SKILL.md)
    plan-schema.mjs             # PLAN_SCHEMA — the host→runner input contract + validation
    orchestrator/
      decompose.mjs             # BARE-SHELL FALLBACK only — single brain call, no repo exploration
      waves.mjs                 # topological wave computation + cycle rejection + intra-wave guard
      implement.mjs             # impl wrapper = worktree + CLI subprocess + gates (NO LLM)
      qa.mjs                    # adaptive QA cascade, judge, escalation (SHARED algo)
      merge.mjs                 # Phase 3 — sequential wave merge, gate after each, conflict → sonnet
      report.mjs                # Phase 4 — structured report + worktree cleanup
      runner.mjs                # wires core + engine + brain; drives waves → merge → report
    llm/
      client.mjs                # LlmClient interface
      anthropic.mjs             # PRIMARY adapter: opus/sonnet/haiku/fable (per-model request shape)
      openai.mjs  xai.mjs       # optional later adapters (gpt-5.x / grok)
      brain-router.mjs          # abstract tier → provider/model (sibling of router.mjs)
  hosts/
    codex/                      # launcher: host decomposes → writes plan.json → execs bin/ --plan-file
    grok/                       # launcher: same contract
  scripts/router.mjs            # REUSED unchanged
  skills/ultraswarm/SKILL.md    # PRIMARY host (Claude Code) — unchanged
```

**The "pure core" is the contract.** `lib/prompts.mjs` and `lib/orchestrator/*` must contain
**no** host-specific calls — they receive `agent`, `parallel`, `pipeline`, `log`, `phase` as
injected dependencies (exactly as the test harness already does). Claude Code supplies the
native `Workflow` versions; the standalone runner supplies `lib/engine.mjs`. This is the
single design rule that keeps the two orchestrators from diverging.

## Component design

### 1. Engine primitives (`lib/engine.mjs`) — net-new, small
- `pipeline(items, ...stages)` and `parallel(thunks)`: contracts are fully specified by the
  harness mocks (`Promise.all` with per-item staging; a thunk/stage that throws → `null`).
  Add a concurrency limiter (cap ~`min(16, cores-2)` to mirror Workflow).
- `phase(title)` / `log(msg)`: terminal progress lines (structured, optionally JSON).
- `budget`: track `{total, spent(), remaining()}` from provider `usage` fields.
- `agent(prompt, opts)`: dispatches to either a **subprocess** (impl wrappers) or the **LLM
  client** (brain roles). In practice the standalone runner does NOT route impl wrappers
  through `agent()` at all — `implement.mjs` calls subprocess code directly — so `agent()`
  here is the brain-only LLM call with `{model, schema}`.

### 2. LLM client + brain-router (`lib/llm/`) — net-new, medium
- `LlmClient.complete({system, prompt, schema, model, effort}) → {object, usage}`.
- **`anthropic.mjs` (primary):** Anthropic Messages API, structured output via
  `output_config: {format: {...}}`, adaptive thinking (`thinking: {type: "adaptive"}`),
  `output_config.effort` (`high`/`xhigh`/`max`); models `claude-haiku-4-5`,
  `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-fable-5`. Stream for large outputs.
- **`brain-router.mjs`:** maps the abstract tiers the orchestrator already uses
  (`haiku`/`sonnet`/`opus`/`fable`, plus the `maxIntelligence` ceiling) to a concrete
  provider+model. Default provider = Anthropic; `openai`/`xai` adapters are stubs initially.
  This is the internal-brain analogue of `router.mjs` (which routes *external workers*).

### 3. Schema validation + retry (`lib/validate.mjs`) — net-new, medium
Reproduce the Workflow `schema` guarantee: validate the model's structured output against the
JSON schema (ajv); on mismatch, re-prompt with the validation error, up to N retries. The
schemas (`IMPL_SCHEMA`, `ENHANCED_REVIEW_SCHEMA`, `ADAPTIVE_JUDGE_SCHEMA`,
`EXPERT_VERDICT_SCHEMA`) move into `lib/prompts.mjs` verbatim.

### 4. Journal + resume (`lib/journal.mjs`) — net-new, medium
Append each completed step `{stepKey, input-hash, result}` to `.ultraswarm/run-<id>.jsonl`.
On `--resume <id>`, replay cached results for unchanged steps and re-run from the first
changed/absent one — the standalone equivalent of `resumeFromRunId`.

### 5. Plan input contract (`lib/plan-schema.mjs`) — the host→runner boundary
The runner's primary input is a **validated plan JSON**, produced by the host (Codex/Grok/Claude
Code) or by the bare-shell fallback decomposer:
```
{ tasks: [{ id, description, files, cli, model_tier, complexity_score, risk, dependencies, prompt }] }
```
`PLAN_SCHEMA` validates it before any execution; the runner **fails loud** on unknown CLIs
(checked against `DEFAULT_REGISTRY`), invalid tiers, missing fields, or dependency cycles. This
is the contract that lets the host own decomposition while the runner owns execution.

### 6. Orchestrator modules (`lib/orchestrator/`) — lift & adapt (the bulk)
Port the embedded `SKILL.md` JS into real modules, dependency-injecting the primitives:
- `waves.mjs` — topological sort of the task list over its `dependencies` edges into ordered
  waves (wave 1 = no deps; wave N = deps all in earlier waves); reject cycles; the intra-wave
  guard (no task may depend on another task in the same wave) is the ported `SKILL.md` check.
- `implement.mjs` — the impl wrapper as **plain Node**: `git worktree add`, write
  `.ultraswarm-prompt.txt`, `resolveRoute()` from `router.mjs` to get the CLI command, spawn
  it with the tier timeout, run gates, parse tokens, commit, return `IMPL_SCHEMA` JSON.
- `qa.mjs` — port `adaptiveQA`, `runAdversarialQA` (the security-Opus + Sonnet→Opus cascade),
  `judgeCompetition`, `runExpertEscalation`, the quorum/critical rules — unchanged logic,
  `agent()` now hits the LLM client (and per-model request shaping — see §2 caveat).
- `merge.mjs` — Phase 3: for each wave's approved tasks, sequential `git merge --squash` + full
  gate after each; conflicts resolved with a `sonnet`-tier brain call (pick, don't blend);
  the next wave rebases on the new HEAD.
- `report.mjs` — Phase 4: structured report (per-task table, token accounting) + worktree/branch
  cleanup sweep.
- `runner.mjs` — the driver: `waves(tasks)` → for each wave run tasks (`pipeline`/competition)
  → `merge` that wave → advance base → after the last wave, `report`.
- `decompose.mjs` — **bare-shell fallback only**: a single brain call turning a free-text task
  into a plan JSON, with no repo exploration. Hosts bypass this by supplying `--plan-file`.

**Anthropic adapter caveat (§2):** build the request **per model capability** — `output_config.effort`
and adaptive thinking apply to Sonnet 4.6 / Opus / Fable, **not Haiku 4.5** (it 400s). The Haiku
path sends a plain Messages request with structured output only.

### 7. Registry (`scripts/router.mjs`) — reused unchanged
`DEFAULT_REGISTRY`, `loadConfig`, `validateConfig`, `resolveRoute` already have zero Claude
Code dependencies. They are the backbone of both hosts.

## Host integration

The standalone runner is **host-agnostic** — anything that can run a shell command can drive
it. Host "support" is a thin launcher, not a reimplementation.

| Host | How it launches the swarm |
|---|---|
| **Codex CLI** | An `AGENTS.md` entry instructs Codex to explore the repo, emit a plan JSON, present it, and on approval run `node bin/ultraswarm.mjs --plan-file plan.json --yes`; it relays the report |
| **Grok CLI** | A command/prompt doing the same — decompose → `--plan-file` → execute |
| **Bare shell** | `node bin/ultraswarm.mjs --plan-file plan.json --yes`, or the lower-fidelity `--decompose "<task>"` fallback; `--resume <id>` to resume |
| **Claude Code (primary)** | Unchanged — `/ultraswarm` runs the native `Workflow` version of the shared core, decomposing in Phase 0 as today |

The host owns decomposition (it has repo access); the runner validates the plan JSON and owns
execution → waves → merge → report. The plan the host presented is the exact plan executed (no
re-decomposition), so approved-vs-run can't diverge.

Health-checking, write-probing, worktree management, and the ≥2-CLI requirement live in the
runner, identical to the skill.

## Behavior parity matrix

| Capability | Claude Code (primary) | Standalone runner (Codex/Grok/shell) |
|---|---|---|
| Decomposition | Inline orchestrator reasoning (rides session) | **Host agent** emits a validated plan JSON (repo-aware); `--decompose` fallback is a single billed call |
| Impl wrappers | Haiku subagents running Bash | Plain Node subprocess (no model) |
| Adaptive QA cascade | Native `agent({model,schema})` | Anthropic brain calls via `LlmClient` |
| Structured output | Workflow `schema` (auto-retry) | `lib/validate.mjs` (ajv + retry) |
| Parallelism / phases | Native `parallel`/`pipeline`/`phase` | `lib/engine.mjs` |
| Resume | `resumeFromRunId` | `lib/journal.mjs` |
| Live progress UI | `/workflows` | Terminal logging (no rich UI) |
| Token budget | Native `budget` | Provider `usage` accounting |

## What's preserved vs. traded

**Preserved:** the role contract (Claude brain, external CLIs code), worktree isolation,
dependency waves, adaptive QA with quorum/critical guarantees, model routing, the registry,
and Claude Code as the highest-fidelity host.

**Traded (standalone only):** the `/workflows` live UI becomes terminal logging; resume and
schema-retry are reimplemented (not free); decomposition + QA become **billed API calls**
rather than riding the Claude Code session.

## Cost & auth model (must surface to users)

- Standalone mode requires `ANTHROPIC_API_KEY` in env (brain) plus each worker CLI's own auth
  (codex/grok/etc.). Optional `OPENAI_API_KEY` / `XAI_API_KEY` only if non-Anthropic brain
  adapters are enabled later.
- Standalone mode **bills Anthropic API tokens** for decomposition + all QA — a different
  billing model from Claude Code (where that reasoning rides the session). Not inherently
  cheaper; the README/runner must say so plainly (Rule 12).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Two orchestrators drift | Enforce the pure-core rule: `prompts.mjs` + `orchestrator/*` are dependency-injected and shared; only the primitives layer differs. CI runs the harness against the shared core. |
| Provider structured-output variance | Centralize in `validate.mjs` with retry; Anthropic-first keeps parity with the skill's tested behavior. |
| Worker CLI quirks (codex flags, model-ID drift) | Already encoded in `router.mjs` + write-probe; reuse verbatim. |
| Resume correctness | Mirror Workflow's "longest unchanged prefix" semantics; test with a stop-and-resume integration case. |
| Maintenance burden | Keep the standalone runner Anthropic-only at first; OpenAI/xAI brain adapters are stubs until demanded. |

## Out of scope (YAGNI for v1)

- Non-Anthropic orchestrator brain in production (adapters stubbed, not shipped).
- A rich TUI for the standalone runner (terminal logging is enough).
- Remote/CI execution of the swarm (still local worktrees).
- Converging the Claude Code skill onto the runner (keep both; revisit only if the runner
  proves out and the duplication hurts).

## Phased implementation plan (≈1–2 weeks)

1. **Pure-core extraction** — move prompts + schemas + orchestration algorithms into
   `lib/prompts.mjs` + `lib/orchestrator/*` with injected primitives; prove the existing
   harness still passes against the extracted modules. *(foundation; unblocks everything)*
2. **Engine primitives** — `lib/engine.mjs` (pipeline/parallel/phase/log/budget) + concurrency
   limiter. *(~2–3 days)*
3. **Brain client** — `lib/llm/anthropic.mjs` + `brain-router.mjs` + `lib/validate.mjs`
   (schema + retry). *(~1–2 days)*
4. **Plan contract + impl wrapper** — `lib/plan-schema.mjs` (validate the host's plan JSON,
   reject bad CLIs/tiers/cycles) + `implement.mjs` (subprocess/git/gates, reusing `resolveRoute`).
   *(~2 days)*
5. **Waves + merge + report + runner** — `waves.mjs` (topological waves + cycle/intra-wave guard),
   `merge.mjs` (sequential wave merge, gate after each, conflict → sonnet), `report.mjs`
   (report + cleanup), `runner.mjs` driving waves → merge → report. *(~3 days)*
6. **CLI + journal** — `bin/ultraswarm.mjs` (`--plan-file`, `--decompose` fallback, `--yes`,
   `--resume`) + `lib/journal.mjs` (keyed on label+attempt+diff-hash). *(~2 days)*
7. **Host shims + docs** — `hosts/codex/`, `hosts/grok/` (decompose → `--plan-file`), README
   section, billing/auth notes. *(~1–2 days)*

**Proof-of-life milestone (do first, before breadth):** phases 1–5 reduced to a single
end-to-end path — decompose → one routine task → gate → merge → report from a bare shell.
Defer competition/adversarial breadth, OpenAI/xAI adapters, and rich resume until that works.

## Testing strategy

- Reuse `workflow-harness.test.mjs` against the extracted pure core (proves no behavior drift).
- New unit tests: `engine.mjs` primitives (mirror the harness mock contracts), `validate.mjs`
  retry, `brain-router.mjs` tier→model mapping, `journal.mjs` resume.
- New integration test: bare-shell end-to-end on a throwaway repo with a mock worker CLI and a
  mock `LlmClient` (no real API spend in CI).
- `validate.sh` gains a check that `bin/ultraswarm.mjs` and `lib/*` parse.

## Open questions

1. ~~Confirmation UX in non-interactive hosts.~~ **Resolved:** the host decomposes and presents
   the plan, then runs the runner with the *same* `--plan-file`; the runner executes exactly that
   plan (no re-decomposition), so the approved and executed plans are identical.
2. Should the standalone runner reuse the *same* `ultraswarm.config.json`
   (`intelligence.modelRouting.claudeModels`) to drive `brain-router.mjs`? (Recommended — one
   config, both hosts.)
3. Token-capture parity: standalone has exact Anthropic `usage` for the brain, but external
   worker token capture stays best-effort (same as today).
