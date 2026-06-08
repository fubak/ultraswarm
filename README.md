# ultraswarm

**Claude orchestrates a swarm of external AI coding CLIs — they write the code in isolated git worktrees, Claude verifies and merges.**

`ultraswarm` is a [Claude Code](https://claude.com/claude-code) skill. It keeps the orchestration machinery of Claude Code's built-in `ultracode` workflow — deterministic control flow, schema-validated agent output, parallel pipelines, adversarial QA, resume-from-checkpoint — but delegates the *bulk coding* to locally installed external CLIs (codex, gemini, grok, agy, droid, opencode). Claude never writes feature code by default. It decomposes the work, routes each task to the best CLI, gates every result through tiered QA, and merges only what passes.

The point: spend external-CLI tokens on the typing, spend Claude's judgment on the decomposition, the review, and the merge.

---

## Table of contents

- [How it works](#how-it-works)
- [Why use it](#why-use-it)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [The worker registry](#the-worker-registry)
- [The QA model](#the-qa-model)
- [What gets created on disk](#what-gets-created-on-disk)
- [Worked example](#worked-example)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Limitations & status](#limitations--status)
- [Repository layout](#repository-layout)

---

## How it works

```
/ultraswarm <task>
  │
  ├─ Phase 0  Decompose (inline Claude, before any Workflow)
  │     health-check + write-probe each CLI · explore repo · detect & verify gates
  │     → task list {id, files, cli, risk, acceptance, prompt} → YOU confirm
  │
  ├─ Workflow script (authored per-run) — covers Implement + QA, returns {approved, failed}
  │     ├─ Phase 1  Implement   pipeline() over tasks
  │     │     each task → a thin Claude wrapper agent that:
  │     │       creates a git worktree → runs the assigned CLI inside it →
  │     │       runs the gates (build/test/lint) → returns schema-validated JSON
  │     │     high-risk tasks fan out to 2 CLIs competing in separate worktrees
  │     │
  │     └─ Phase 2  QA   (pipelined — a task's QA starts the moment its code lands)
  │           routine: mechanical gates + one Claude diff review
  │           high-risk: judge panel picks the winner → 3-lens adversarial verify
  │           fail → retry same CLI w/ feedback → reassign to alternate CLI → tombstone
  │
  ├─ Phase 3  Merge (inline Claude, sequential, after the Workflow returns)
  │     apply each approved worktree's diff one at a time · full gate after each
  │
  └─ Phase 4  Final verify & report
        full suite + coverage · per-task table · loud list of anything that failed
```

**Core principle — the role contract:** the external CLIs do *all* feature coding inside throwaway worktrees. Claude decomposes, reviews, judges, merges, and reports. The single exception is the last-resort fail path: if every CLI exhausts its attempts on a task, Claude implements that one task directly — and flags it loudly in the report.

**Isolation:** every task attempt runs in its own `git worktree` on its own branch. A bad CLI run can't corrupt your working tree or another task's work. Nothing touches your real branch until Phase 3, where Claude merges approved diffs one at a time with a full gate after each.

---

## Why use it

- **Cheaper bulk coding.** External CLIs do the typing; Claude's tokens go to decomposition, review, and merge — the parts that need judgment.
- **You keep ultracode's reliability.** Deterministic phases, JSON-schema-validated worker output, parallel pipelines, adversarial verification, resume-from-checkpoint. Not a loose "run some CLIs and hope" script.
- **Quality is enforced, not assumed.** External CLI output is more variable than Claude's. Tiered QA (and head-to-head competition on risky tasks) is what compensates — plausible-but-wrong code doesn't survive the gate.
- **Fails loud.** Every dropped CLI, failed task, merge conflict, and Claude-implemented fallback is surfaced in the final report. "Done" is never reported unless the final gate passed.

If you just want to fan a couple of CLIs at independent subtasks with minimal ceremony, the lighter `swarm-cli` / `multi-execute` commands still exist. `ultraswarm` is for when you want the full orchestrated build with verification.

---

## Prerequisites

- **Claude Code** with the Workflow tool available (this is what powers `ultracode`).
- **A git repository.** ultraswarm works exclusively through git worktrees. Worktrees are created under `~/worktrees/` by default.
- **At least two healthy external coding CLIs.** ultraswarm needs ≥2 working CLIs or it stops (it will not silently fall back to Claude coding everything). Install and authenticate the ones you want:

  | CLI | Install (typical) | Auth |
  |---|---|---|
  | [codex](https://github.com/openai/codex) | `npm i -g @openai/codex` | `codex login` |
  | [gemini](https://github.com/google-gemini/gemini-cli) | `npm i -g @google/gemini-cli` | `gemini` (interactive login) |
  | grok | xAI CLI | API key / login |
  | agy | — | — |
  | [droid](https://factory.ai) | Factory CLI | `FACTORY_API_KEY` / login |
  | [opencode](https://github.com/sst/opencode) | `npm i -g opencode-ai` | provider key (e.g. xAI) |

  You don't need all six. The skill health-checks and write-probes whatever is installed and routes only to the ones that pass. See [Limitations & status](#limitations--status) for which CLIs are currently verified.

---

## Installation

ultraswarm is a personal Claude Code skill — a `SKILL.md` discovered from `~/.claude/skills/`.

```bash
# 1. Clone
git clone https://github.com/fubak/ultraswarm.git ~/projects/ultraswarm

# 2. Symlink the skill into your Claude skills directory
ln -s ~/projects/ultraswarm/skills/ultraswarm ~/.claude/skills/ultraswarm

# 3. Verify
readlink -f ~/.claude/skills/ultraswarm   # → ~/projects/ultraswarm/skills/ultraswarm
head -3 ~/.claude/skills/ultraswarm/SKILL.md
```

The skill registry loads at session start, so `/ultraswarm` becomes available in your **next** Claude Code session.

Symlinking (rather than copying) means `git pull` in the repo updates the live skill automatically.

---

## Usage

From within a git repository, in Claude Code:

```
/ultraswarm <describe the work you want done>
```

Examples:

```
/ultraswarm add a rate limiter to the API, with unit tests, plus a usage doc

/ultraswarm migrate the date helpers from moment to date-fns across the codebase

/ultraswarm build the settings page: form component, validation, and the PATCH endpoint
```

**What happens next:**

1. **Claude decomposes** your request into independent tasks, picks a CLI for each by specialty, classifies each as `routine` or `high` risk, and detects your repo's gate commands (build / test / lint).
2. **Claude shows you the task table and waits for your confirmation.** This is the opt-in gate — nothing runs until you approve. This is your moment to fix routing, split a task, or adjust risk levels.
3. **The swarm runs.** CLIs code in worktrees, QA runs per task, failures retry/reassign automatically. You can watch live with `/workflows`.
4. **Claude merges** approved work into your tree one task at a time, gating after each.
5. **Claude reports**: a per-task table (which CLI, how many attempts, QA verdict, files touched) and a loud list of anything that failed, was reassigned, conflicted, or fell back to Claude.

Your working branch is only ever touched in step 4, and only by approved, gate-passing diffs.

---

## The worker registry

Tasks are routed to CLIs by specialty:

| CLI | Specialty | Status |
|---|---|---|
| **codex** | Backend, logic, algorithms, debugging | ⚠️ disabled (see below) |
| **gemini** | Frontend, UI, CSS, components | ✅ verified |
| **grok** | Tests, refactors, general | ✅ verified end-to-end |
| **agy** | Docs, boilerplate, general | ✅ verified end-to-end |
| **droid** | General full-stack implementation, refactoring | ⚠️ disabled (not authenticated) |
| **opencode** | Junior tier: boilerplate, lint/type fixes, simple tests, JSDoc | ✅ verified |

**Routing isn't rigid.** For `high`-risk tasks, ultraswarm sends the *same* task to two CLIs in parallel worktrees and a judge panel picks the winner — independent attempts beat one-attempt-and-hope when the task is risky. Routine tasks go to a single CLI.

**Health is checked at runtime, every run.** Phase 0 runs `<cli> --version` *and* a write probe (it has the CLI create a trivial file inside a scratch worktree) for each CLI before routing. `--version` proves a CLI is installed; only the write probe proves it can actually write inside a worktree. Any CLI that fails is dropped from routing and reported to you. If fewer than two survive, the run stops.

The canonical, always-current registry lives in [`skills/ultraswarm/SKILL.md`](skills/ultraswarm/SKILL.md); the verified invocation strings and per-CLI quirks are in [`docs/notes/cli-verification.md`](docs/notes/cli-verification.md).

---

## The QA model

QA depth is **tiered by risk** so trivial tasks aren't over-verified and risky ones aren't under-verified.

**Routine tasks:**
- Mechanical gates (build / typecheck / test / lint) run inside the worktree.
- One Claude review agent reads the diff and checks: acceptance criteria actually met, conventions followed, no scope creep, no silently swallowed errors, tests verify intent rather than hardcoded outputs.

**High-risk tasks** (anything touching auth/security/payments, shared interfaces or data models, architectural changes, or logic with no existing test coverage):
- The two competing implementations go to a **judge panel** that scores correctness / simplicity / convention-fit; the winner advances.
- The winner faces a **3-lens adversarial verify** — a *correctness* lens, a *security* lens (the standard secret/injection/authz/leak checks), and a *regression* lens — each prompted to **refute** the work. It needs a 2-of-3 majority to pass.

**When QA rejects:** the task retries on the *same* CLI with the reviewer's concrete feedback appended (so the next attempt knows exactly what to fix). If it exhausts retries, it reassigns to an alternate CLI carrying the accumulated feedback. If every path is exhausted, the task tombstones as failed — and Claude either implements it directly (flagged) or reports it, never silently drops it.

---

## What gets created on disk

| Location | What | Lifetime |
|---|---|---|
| `~/worktrees/<repo>-us-<taskid>-<cli>/` | One linked git worktree per task attempt | Removed in the Phase 3 cleanup sweep, after the report |
| `<worktree>/.ultraswarm-prompt.txt` | The self-contained prompt handed to the CLI | Deleted by the wrapper before it commits (never lands in a diff) |
| branches `ultraswarm/<taskid>-<cli>` | One branch per worktree | Deleted in the cleanup sweep |
| your working branch | Approved, merged, gate-passing commits | Permanent — this is the output |

Worktrees and branches are deliberately kept until *after* the final report, so you can inspect any task's diff — including failed ones — before they're swept.

---

## Worked example

Asking `/ultraswarm` to build two small utilities with tests (a routine, two-task run):

```
Phase 0 — health check: agy ✓  grok ✓   (codex dropped: worktree write probe failed)
          gates verified green on base tree: npm test ✓
          tasks:
            t1 [routine] agy  → src/math.js + test/math.test.js
            t2 [routine] grok → src/slugify.js + test/slugify.test.js
          → confirm? (you approve)

Phase 1/2 — impl:t1:agy#1    → worktree, agy codes, 4/4 tests, review ✓
            impl:t2:grok#1   → worktree, grok codes, 6/6 tests, review ✓

Phase 3 — merge t1 → npm test ✓ → commit "(ultraswarm: agy)"
          merge t2 → npm test ✓ → commit "(ultraswarm: grok)"

Phase 4 — full suite 10/10 ✓ · cleanup swept 2 worktrees / 2 branches
          | task | cli  | attempts | QA  | files                        |
          | t1   | agy  | 1        | ✓   | src/math.js, test/...        |
          | t2   | grok | 1        | ✓   | src/slugify.js, test/...     |
          nothing failed · nothing reassigned · nothing fell back to Claude
```

This is the actual shape of the project's end-to-end smoke test.

---

## Configuration reference

You don't normally configure ultraswarm by hand — Claude authors the per-run Workflow from the template in `SKILL.md`, filling in values from Phase 0. But it helps to know the knobs:

| Field | Meaning |
|---|---|
| `repo` / `repoName` | Absolute path and short name of the target repo |
| `baseBranch` | Branch/SHA worktrees fork from and all QA diffs review against (captured in Phase 0) |
| `worktreeRoot` | Absolute path for worktrees (default `~/worktrees`, expanded — never a literal `~`) |
| `gates` | List of `{name, cmd}` — build/test/lint commands run in each worktree and after each merge |
| `registry` | Map of CLI → verified invocation string |
| `alternates` | Map of CLI → fallback CLI for the reassign step |
| `timeoutMs` | Per-CLI wall-clock budget before a run counts as a failed attempt |
| `tasks` | The decomposed task list |

---

## Troubleshooting

**"Fewer than 2 CLIs are healthy" — the run stops.**
Install/authenticate more CLIs. Check each manually: `<cli> --version`, then confirm it can write a file unattended in a throwaway `git init` repo. A CLI that needs interactive approval or login won't work as a worker.

**A CLI passes `--version` but every task it gets fails.**
This is exactly why the write probe exists. Some sandboxed CLIs reject all file writes inside *linked git worktrees* even though they run fine in a normal repo (this is the current codex situation — see below). ultraswarm drops these in Phase 0; if you see it happen, that CLI needs a sandbox/config fix before it can be a worker.

**Every task tombstones immediately.**
Almost always a **broken gate**. If your build/test/lint command errors on the *base tree* (before any changes), every worker looks like it failed QA no matter what it wrote. Phase 0 verifies gates green on the base tree first for this reason — but if you bypass that, check the gate command runs clean on a fresh checkout.

**Merge conflicts.**
Claude resolves them by picking one source of truth (never blending), and documents the choice in the report. If two tasks both needed to edit the same file, that's a decomposition smell — they should have been one task.

**Leftover worktrees in `~/worktrees/`.**
The cleanup sweep runs after the report. If a run was interrupted, clean up manually:
```bash
cd <your-repo>
git worktree list                       # find <repo>-us-* entries
git worktree remove --force <path>
git branch --list 'ultraswarm/*' | xargs -r git branch -D
```

---

## Limitations & status

Honest current state (as of the initial verification, 2026-06-07):

- **Verified end-to-end:** the routine-tier pipeline (decompose → worktree → CLI codes → gates → review → sequential merge → final verify) using **agy** and **grok**. Both implemented their tasks correctly on the first attempt; merges gated clean; cleanup verified.
- **Verified by health/write probe, not yet exercised in a full run:** **gemini**, **opencode**.
- **Currently disabled:**
  - **codex** — installed and authenticated, but its `bwrap` sandbox rejects all writes inside linked git worktrees, and `exec` hangs in fresh repos. Re-probe after a codex upgrade or sandbox-config change before routing to it.
  - **droid** — not authenticated (`FACTORY_API_KEY` / login required). Authenticate, then re-run the write probe.
- **The high-risk competition path** (judge panel + 3-lens adversarial verify) is review-verified but has **not** been exercised in a live run — the smoke test only used routine-tier tasks. The first real high-risk task is its live test.
- **Local only** — no remote/CI execution. Everything runs in local worktrees.

CLI availability and flags drift over time. The skill re-checks health and write capability at the start of *every* run, so a CLI that breaks (or gets fixed) is picked up automatically — the table above is a snapshot, not a hard dependency.

---

## Repository layout

```
ultraswarm/
├── README.md                                   ← you are here
├── skills/ultraswarm/SKILL.md                  ← the skill (canonical source)
└── docs/
    ├── specs/2026-06-07-ultraswarm-design.md   ← approved design spec
    ├── plans/2026-06-07-ultraswarm.md          ← implementation plan (historical)
    └── notes/cli-verification.md               ← verified CLI invocations, quirks, e2e findings
```

> Note: the implementation plan's embedded skill template is intentionally **historical** — it predates the fixes made during review and the end-to-end test. `skills/ultraswarm/SKILL.md` is the only canonical copy.

---

## License

No license file yet — add one before relying on it elsewhere.
