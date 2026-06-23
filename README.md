# ultraswarm

Ultraswarm is a durable multi-worker coding orchestrator for Codex, Claude Code,
Cursor Agent, Grok, and shell usage. One standalone Node runner owns decomposition, worker
routing, process supervision, isolated Git worktrees, adaptive review,
transactional integration, approvals, recovery, and reporting.

## What's New In v3.5.18

Run-output polish:

- **Plain terminal report by default** (no markdown `#`/`**`/`_` showing as literal chars); pass
  `--markdown` to keep GitHub-markdown for pasting into a PR.
- **Color** — the live stream and report verdict are color-coded (green pass / red fail / yellow
  retry); auto-off when piped, honors `NO_COLOR` / `--no-color`.
- **Run wall-clock** in the Summary, and **short 8-char run-ids** (merge/status/logs/… accept an
  unambiguous prefix).

## What's New In v3.5.17

- **Every table in the run report is now a clean aligned terminal table** — the per-task list was the
  last markdown table; it now matches the per-CLI / PLAN PREVIEW / WORKER ROSTER fixed-width style.

## What's New In v3.5.16

- **Per-CLI token table now renders as a clean aligned terminal table** (the 3.5.15 version was a
  markdown table whose pipes didn't line up in a raw CLI) — fixed-width columns with a `─` separator
  and right-aligned numbers, matching the PLAN PREVIEW / WORKER ROSTER style.

## What's New In v3.5.15

Per-CLI token breakdown (see the [CHANGELOG](CHANGELOG.md)):

- **"Work offloaded" now breaks usage down by CLI** — a table of `landed` (tokens that produced
  integrated work) vs `spent` (all attempts, incl. rejected retries and competition losers) vs
  `overhead`, with a reconciling total. You can see at a glance which worker burned tokens and how
  much went to retries/competition (e.g. `Workers used ≈ 383,578 tokens — ≈ 274,485 landed,
  ≈ 109,093 on retries + competition`).

## What's New In v3.5.14

Real token-usage capture (see the [CHANGELOG](CHANGELOG.md)):

- **codex and opencode now report real usage.** Their default invocations use `exec --json` /
  `run --format json`, and ultraswarm parses the structured JSONL usage events — so the report's
  "Work offloaded" section shows the actual token count (e.g. `Workers reported ≈ 238,656 tokens`)
  instead of "not reported". No more scraped guesswork (removed in 3.5.13), and no fabrication when a
  CLI doesn't report — a custom invocation without the JSON flag honestly shows "not reported".

## What's New In v3.5.13

Honest run-report value section (see the [CHANGELOG](CHANGELOG.md)):

- **No more scraped token noise** — the old "Tokens saved" number was regex-scraped from worker stdout
  and matched incidental digits (e.g. "≈ 62 tokens" for a run that used thousands). The free-text
  scrape is gone; token/cost now come only from a worker's structured usage, else nothing is claimed.
- **"Work offloaded" reports what's measured** — tasks, worker-attempt count, and total external
  wall-clock. A token figure shows only when a worker actually reported one; otherwise the report says
  "Token/cost usage: not reported by these CLIs" rather than inventing a misleading count.

## What's New In v3.5.12

Live-stream readability follow-up to v3.5.11 (see the [CHANGELOG](CHANGELOG.md)):

- **No more git chatter in the stream** — `git worktree add` / `merge --squash` output is captured
  instead of inherited, so a big swarm's progress lines aren't buried under "Preparing worktree …".
- **Consistent glyphs everywhere** — routine-path escalation/rejection/blocked lines now carry the
  same `↑`/`✗`/`⊘` glyphs as the high-risk competition path, so the whole stream scans uniformly.

## What's New In v3.5.11

Readability + accuracy pass on the two human-facing output surfaces (see the
[CHANGELOG](CHANGELOG.md) for detail):

- **Accurate run-end report** — reports "integrated" (not "merged") while a run awaits merge approval,
  with a staging line making clear nothing lands on your branch until you approve; the headline counts
  every task (including post-merge regressions) so the numbers reconcile.
- **Honest token offload** — the offload headline no longer leads with a misleading `≈ N`/`≈ 0`; it
  shows the exact figure on full coverage, an explicit floor (`x of y tasks reported`) on partial, and
  "not measurable here" when no worker reports usage. Retried-but-integrated tasks are named.
- **Visible competition retries** — when a high-risk competition winner is rejected by adversarial QA,
  the live stream now logs the judged winner and `✗ … rejected by QA — retrying` instead of silently
  jumping to the next attempt.

## What's New In v3.5.1–v3.5.10

Hardening from a full audit of the orchestrator (each fix shipped as its own patch release; see the
[CHANGELOG](CHANGELOG.md) for per-version detail):

- **Concurrency** — fixed a re-entrant limiter deadlock that could hang an entire run, and froze runs
  deterministically on ≤3-core hosts (CI), whenever a high-risk task fanned out competition/QA work.
- **Security** — plan `contract.commands` now reject shell metacharacters (no more `npm test; rm -rf ~`
  reaching the shell); worker env passthrough narrowed from the whole `XDG_*` namespace to named vars.
- **Integration** — a no-op squash records a clean skip instead of throwing and blocking the whole
  wave; a failed per-task commit fails loud instead of reporting `ok`; post-run `cleanup` deletes only
  the current run's branches.
- **Recovery** — `resume` judges liveness on a persisted orchestrator identity (pid + boot id), so it
  can't reap a still-running run or be fooled by PID reuse after a reboot; terminal runs are immutable.
- **Brain** — Anthropic schema calls extract JSON defensively and fall back to raw text so the
  validate-and-retry loop works; malformed `--plan-file` / `package.json` fail with a clear `USAGE` error.
- **Alias workers in competition** — user-defined alias workers can now participate in (and be retried
  within) high-risk competition; they previously tombstoned as "only N usable worker(s)".

## What's New In v3.5

- **Functional preflight** — `preflight` runs a cached exec smoke test per CLI (write a file in an
  isolated temp dir) and excludes workers that pass `--version` but can't actually run (dead auth,
  no-op). Routing keys off the functional verdict. See [Prerequisites](#prerequisites).
- **Human-readable output** — `preflight`, plan previews, `status`, and `doctor` render aligned
  tables by default; add `--json` for the old machine output.
- **Live progress + every-agent heartbeat** — runs stream per-agent dispatch lines, gate results,
  and a periodic active/idle heartbeat to stderr so every worker stays visible.
- **Tokens-saved summary** — the final report estimates the implementation tokens that ran on
  external CLIs off your Claude context (an honest best-effort floor).
- **Repo-local worktrees with deps installed** — per-task and integration worktrees default to
  `<repo>/.ultraswarm/worktrees` and have dependencies installed before gates run (detected from the
  lockfile: pnpm/npm/yarn), so build/test gates resolve `node_modules` even on pnpm workspaces.

## What's New In v3.4

- **`agent` worker** — the Cursor CLI (`agent -p --force`) as a headless shell worker for
  isolated worktree execution. See [Cursor Agent Worker](#cursor-agent-worker).
- **Cursor agent host skill** — install with `scripts/install-cursor-skill.sh` so Cursor
  sessions can orchestrate via the standalone runner. See [Cursor Agent](#cursor-agent).

## What's New In v3.3

- **`small-harness` worker** — [SmallHarness](https://github.com/GetSmallAI/SmallHarness) as a
  built-in worker with MCP integration and multi-backend support. See
  [SmallHarness Worker](#smallharness-worker).

## What's New In v3.2

- **User-defined harness aliases** — register your own CLI entries under a new top-level
  `aliases` config key. Each alias `extends` a built-in (inheriting its binary, timeout,
  effort flags, and capabilities), overrides only its specialty / models / invocation, and can
  cap routing with `maxTier`. Generalizes the previously hardcoded `pi-local`; strictly opt-in.
  See [Harness Aliases](#harness-aliases-custom-cli-entries).

## What's New In v3.1

- **`pi` worker** — the provider-agnostic [`pi`](https://github.com/earendil-works/pi)
  coding CLI (Anthropic Claude spread by default). See [Local / Private Models](#local--private-models-ollama).
- **`pi-local` worker** — an always-on local/private worker that drives **Ollama** models
  through the same `pi` binary for fully offline-capable runs.
- **Per-task effort levels** — the decomposition brain assigns reasoning `effort` per task,
  independent of model tier, defaulting to `low`, with effort-first QA escalation. See
  [Effort Levels](#effort-levels).

## What Changed In v3

- SQLite state and append-only events under `.ultraswarm/state.sqlite`
- Capability and repository-metric worker routing with explanations
- Supervised worker process groups, timeouts, cancellation, redacted bounded logs
- Executable task contracts and forbidden-path policy
- Integration branches that do not modify the checked-out branch
- Separate plan and merge approvals
- Crash/status/log/export commands and stale-base recovery
- Generated Claude, Codex, Grok, and Cursor agent skills from one provenance-locked contract

Node 22 or newer is required because ultraswarm uses the built-in `node:sqlite`
API.

## Install

```bash
git clone https://github.com/fubak/ultraswarm.git ~/projects/ultraswarm
cd ~/projects/ultraswarm
npm install
```

### Codex

```bash
bash scripts/install-codex-skill.sh
```

This creates:

```text
~/.agents/skills/ultraswarm -> ~/projects/ultraswarm/hosts/codex/skills/ultraswarm
```

Restart Codex and invoke `$ultraswarm`.

### Claude Code

Install the plugin:

```text
/plugin marketplace add fubak/ultraswarm
/plugin install ultraswarm@ultraswarm
```

Invoke `/ultraswarm`.

### Grok Build (xAI Plugin Marketplace)

Ultraswarm is published in the official xAI Grok plugin marketplace.

- Grok Build can proactively suggest the skill for complex multi-step coding tasks.
- Install directly from the Grok marketplace / plugin browser (searches for "ultraswarm").
- Invocation inside Grok: follow the skill (typically `ultraswarm` or `/ultraswarm`).

The skill delegates to the standalone runner (do not re-implement orchestration inside the host).

For direct/shell or non-Grok use:

```bash
node ~/projects/ultraswarm/bin/ultraswarm.mjs run ...
# or the installed bin after `npm install -g` equivalent
```

See the generated Grok host contract: `hosts/grok/skills/ultraswarm/SKILL.md`.

Plugin source + details: https://github.com/fubak/ultraswarm (manifests in `.grok-plugin/` + `.claude-plugin/`).

#### Maintaining the plugin after publication

1. Bump the version in every manifest so they agree (validate Check 3): `package.json`, `package-lock.json` (run `npm install --package-lock-only`), `.claude-plugin/plugin.json` and `.grok-plugin/plugin.json` (keep byte-identical — `cp` one to the other), and both `version` fields in `.claude-plugin/marketplace.json` (`metadata.version` + `plugins[0].version`).
2. Update docs + CHANGELOG (move `[Unreleased]` to the new version + date).
3. `npm run validate` and `npm test` must pass.
4. Push to main.
5. Capture the new commit SHA (`git rev-parse HEAD`).
6. In the plugin-marketplace repo, update the `sha` for ultraswarm, re-run `python3 scripts/generate-plugin-index.py`, then validate + open PR.
7. `scripts/validate.sh` now also validates `.grok-plugin/plugin.json` (parse + version match) and enforces that the two manifests are byte-identical.

This addresses review feedback on packaging validation and sync risk.

### Cursor Agent

```bash
bash scripts/install-cursor-skill.sh
```

This creates:

```text
~/.cursor/skills/ultraswarm -> ~/projects/ultraswarm/hosts/agent/skills/ultraswarm
```

Restart Cursor and invoke the ultraswarm skill. The host prepares plans and
delegates execution to `bin/ultraswarm.mjs`; it does not implement feature work
directly.

Install the Cursor CLI separately if you also want `agent` as a worker:

```bash
curl https://cursor.com/install -fsS | bash
agent --version
```

### Grok Or Shell (non-Grok hosts)

See the full [Grok Build (xAI Plugin Marketplace)](#grok-build-xai-plugin-marketplace) section (and the maintenance subsection) above. For direct execution outside Grok:

```bash
node ~/projects/ultraswarm/bin/ultraswarm.mjs ...
```

The generated Grok host contract is at `hosts/grok/skills/ultraswarm/SKILL.md`.

## Prerequisites

- A Git repository
- Node 22+
- At least two authenticated worker CLIs from `codex`, `gemini`, `grok`, `agy`,
  `droid`, `opencode`, `pi`, `pi-local`, `small-harness`, and `agent`
- An authenticated `claude` CLI for the default QA/decomposition brain, or
  `ANTHROPIC_API_KEY` with `ULTRASWARM_BRAIN=anthropic-api`

Check readiness:

```bash
# Functionally verify each CLI (cached smoke test — proves a worker can actually write a file,
# not just that `--version` succeeds). Workers shown UNUSABLE are excluded from routing.
node ~/projects/ultraswarm/bin/ultraswarm.mjs preflight

# Policy, gates, and worker capabilities (add --json for machine-readable output):
node ~/projects/ultraswarm/bin/ultraswarm.mjs doctor
node ~/projects/ultraswarm/bin/ultraswarm.mjs workers
```

`preflight` is the recommended first step: a CLI can pass `--version` yet fail every real run
(dead auth, no-op output). The smoke test catches that and routing skips non-functional workers
automatically. Verdicts are cached in `.ultraswarm/functional-probe.json` (24h TTL, keyed by
binary version); `preflight --smoke` forces a re-probe.

## Run

Create a plan:

```json
{
  "tasks": [
    {
      "id": "api-tests",
      "description": "Add regression coverage for the API",
      "files": ["test/api.test.mjs"],
      "complexity_score": 25,
      "risk": "routine",
      "effort": "low",
      "dependencies": [],
      "prompt": "Add focused regression tests for invalid request handling.",
      "contract": {
        "commands": ["npm test"],
        "assertions": ["Invalid requests return 400"],
        "allowed_paths": ["test"]
      }
    }
  ]
}
```

`cli`, `model_tier`, and `effort` are optional. When `cli`/`model_tier` are omitted,
ultraswarm ranks healthy workers using capability fit and repository-local pass, latency,
and cost history. When `effort` is omitted it defaults to `low` (see [Effort Levels](#effort-levels)).

Preview without executing:

```bash
node ~/projects/ultraswarm/bin/ultraswarm.mjs run \
  --plan-file .ultraswarm-plan.json
```

Approve the plan and execute:

```bash
node ~/projects/ultraswarm/bin/ultraswarm.mjs run \
  --plan-file .ultraswarm-plan.json \
  --approve-plan
```

While a run executes, it streams colour-coded progress to stderr — wave headers, a per-agent dispatch
line for every worker the moment it starts (`▶ task → cli@tier attempt N [pid …]`), gate results
(`✓`/`✗`), review verdicts (`✔` approved; `✗ … rejected by QA — retrying`), escalations (`↑`), and a
periodic active/idle heartbeat (`⏱ active: … · idle: …`) so every worker's state stays visible. Colour
auto-disables when output is not a TTY (piped/CI), honours the `NO_COLOR` convention, and is suppressed
by `--no-color`.

When it finishes it prints a run report (plain terminal text by default; pass `--markdown` to emit
GitHub-markdown for pasting into a PR/issue): a per-task table showing which worker landed each task, a
**Summary** with the run wall-clock, and a **Work offloaded** section — how many tasks/worker-attempts
ran on external CLIs, their total compute time, and a per-CLI token breakdown (`landed` vs `spent` vs
retry/competition `overhead`) read from each CLI's structured usage. The headline value: the
implementation ran on external CLIs, off your Claude context; Claude only orchestrated and reviewed
(see [token reporting](#state-and-safety)).

Per-task and integration worktrees are created under `<repo>/.ultraswarm/worktrees` (gitignored).
Because a fresh worktree checks out tracked files only (no `node_modules`), the runner installs
dependencies in each worktree before gates run — inferred from the lockfile (`pnpm-lock.yaml` →
`pnpm install --frozen-lockfile`, `package-lock.json` → `npm ci`, `yarn.lock` → `yarn install
--immutable`); repos without a lockfile are left untouched. This is what makes gates resolve
`node_modules` on pnpm workspaces, where upward module resolution from a sibling worktree does not
reach the symlinked deps. Override the worktree location with `--worktree-root <dir>`.

Gates are auto-detected from your `package.json` scripts (`build`, `test`, `lint`). Override which
scripts gate with `--gates <names>` (e.g. `--gates test,lint` to drop a worktree-unsafe `build`) or a
`"gates"` array in `ultraswarm.config.json`; an empty list disables gates. The same selection applies
to the integration gate at merge time, so `run` and `merge` stay consistent.

The run finishes in `awaiting_merge`. Your checked-out branch has not changed.
After reviewing status and logs, provide the separate merge approval:

```bash
node ~/projects/ultraswarm/bin/ultraswarm.mjs status <run-id>
node ~/projects/ultraswarm/bin/ultraswarm.mjs logs <run-id>
node ~/projects/ultraswarm/bin/ultraswarm.mjs merge <run-id> --approve
```

The final merge is fast-forward only. If the target branch moved, the run enters
`stale_base`; recover it with:

```bash
node ~/projects/ultraswarm/bin/ultraswarm.mjs resume <run-id>
```

## Commands

| Command | Purpose |
|---|---|
| `preflight` | Functionally verify enabled CLIs (cached smoke test); `--smoke` forces a re-probe |
| `run` | Preview or execute a plan |
| `merge <id> --approve` | Approve and fast-forward integrated work |
| `status [id]` | List runs or inspect durable state |
| `logs <id>` | Read append-only events |
| `cancel <id>` | Terminate worker process trees |
| `resume <id>` | Recover awaiting-merge or stale-base state |
| `doctor` | Validate policy, gates, and worker health |
| `workers` | Show worker health and capabilities |
| `explain-routing <task>` | Explain worker rankings |
| `export <id>` | Export run provenance as JSON |

`preflight`, `run` (plan preview), `status`, `doctor`, and `workers` print human-readable
tables by default; add `--json` for machine-readable output. By default `run` functionally
verifies the pool (cached smoke test) before assigning; pass `--smoke` to force a fresh probe or
`--no-smoke` to fall back to a `--version`-only check.

The run report renders as plain terminal text by default; pass `--markdown` to emit GitHub-markdown
(for pasting into a PR or issue). Colour is enabled for interactive terminals and disabled when output
is piped/redirected; turn it off explicitly with `--no-color` (or `NO_COLOR=1`). Any command that takes
a run id also accepts an unambiguous **prefix** — e.g. the 8-character id printed in the report's
`Approve merge with:` line — in place of the full id (`merge`/`status`/`logs`/`cancel`/`resume`/`export`).

Legacy `--plan-file ... --yes` syntax remains as a v2 compatibility shim.
`--yes` maps only to plan approval; it never approves the final merge.

Exit codes are `0` success, `1` runtime failure, `2` usage error, `3` approval
required, and `4` blocked or stale state.

## Policy

Add policy to `ultraswarm.config.json`:

```json
{
  "enabled": ["codex", "gemini"],
  "workerEnvAllowlist": ["OPENAI_API_KEY"],
  "policy": {
    "minimumHealthyWorkers": 2,
    "maxParallelWorkers": 4,
    "requireCompetitionForRisk": ["high"],
    "approvals": {
      "beforeExecution": true,
      "beforeMerge": true
    },
    "forbiddenPaths": [".env", ".env.*", "infra/prod/**"],
    "maxCostUsd": 10,
    "isolation": "native",
    "containerImage": null,
    "network": "allow"
  }
}
```

Project configuration overrides the global
`~/.claude/ultraswarm.config.json`. For container isolation, set `containerImage` to an image containing the selected worker CLIs. Network denial requires container
isolation and is rejected when configured with native isolation.

## Harness Aliases (Custom CLI Entries)

Beyond the built-in CLIs, you can register your own named entries under `aliases`. An alias
`extends` a built-in (inheriting its binary, timeout, effort flags, and capabilities) and
overrides only what differs — its specialty, its model tiers, and its invocation. This is how
you run several local models, each tuned for a job, through one CLI binary:

```json
{
  "enabled": ["codex", "pi-qwen-coder"],
  "aliases": {
    "pi-qwen-coder": {
      "extends": "pi",
      "specialty": "local coding, small refactors, unit tests",
      "maxTier": "moderate",
      "models": {
        "simple": { "model": "qwen3-coder:7b", "invocation": "pi -p --provider ollama --model qwen3-coder:7b --config ~/.pi/lean.json \"$(cat .ultraswarm-prompt.txt)\"" }
      }
    }
  }
}
```

- **Lean harness:** put whatever makes a CLI's harness leaner directly in the `invocation`
  (a `--config` pointing at a stripped-down profile, fewer flags, etc.). Local models often do
  better with less wrapping.
- **`maxTier`:** caps the tiers an alias will accept. A task above the cap is clamped down (e.g.
  an expert task on a `maxTier: moderate` alias runs at moderate), so a small local model is
  never handed work it can't do.
- **Opt-in only:** nothing is auto-generated. An alias exists only if you declare it, and is
  active only when it appears in `enabled` (or when `enabled` is omitted entirely).

## SmallHarness Worker

[SmallHarness](https://github.com/GetSmallAI/SmallHarness) is a terminal-first coding agent written in Rust that supports multiple AI backends (OpenAI, OpenRouter, Ollama, LM Studio, MLX, llama.cpp). As an ultraswarm worker it brings:

- **Multi-backend routing**: switch between cloud and local models per-task via overrides
- **MCP integration**: native Model Context Protocol support for extended tool sets
- **Cost tracking**: real-time per-turn and session cost accounting

SmallHarness must be installed separately:

```sh
cargo install small-harness
```

Add `small-harness` to `enabled` to activate it. The built-in defaults use the OpenAI backend for `simple` tasks and OpenRouter (Claude) for `moderate`/`complex`/`expert`. Backend and model are passed via environment variables — SmallHarness reads `BACKEND` and `AGENT_MODEL` from the environment, not CLI flags.

To route `simple` tasks through a local Ollama model instead, override in `ultraswarm.config.json`:

```json
{
  "enabled": ["codex", "small-harness"],
  "overrides": {
    "small-harness": {
      "models": {
        "simple": {
          "model": "qwen3-coder:7b",
          "invocation": "BACKEND=ollama AGENT_MODEL=qwen3-coder:7b small-harness --allow-tools --print \"$(cat .ultraswarm-prompt.txt)\""
        }
      }
    }
  }
}
```

> **Tool approval:** ultraswarm always passes `--allow-tools` so SmallHarness auto-approves
> tool calls in one-shot mode. Do not omit this flag in custom invocations or the worker will
> silently deny every tool call and produce no file changes.

> **API keys:** SmallHarness inherits only the variables in `workerEnvAllowlist`. The built-in
> defaults need `OPENAI_API_KEY` (simple tier) and `OPENROUTER_API_KEY` (moderate/complex/expert).
> Add both to your config:
>
> ```json
> { "workerEnvAllowlist": ["OPENAI_API_KEY", "OPENROUTER_API_KEY"] }
> ```

## Cursor Agent Worker

The Cursor CLI (`agent`) runs headless tasks via `agent -p --force` in isolated worktrees.
Ultraswarm uses the same `ShellWorkerAdapter` as every other worker — no custom interface.

Install the CLI:

```sh
curl https://cursor.com/install -fsS | bash
agent --version
```

Add `agent` to `enabled` to activate it. Built-in tier mapping: `simple` →
`composer-2.5-fast`; `moderate` → `gpt-5.4`; `complex`/`expert` → Claude Sonnet 4.6 /
Opus 4.8. Override models in `ultraswarm.config.json` via the standard `overrides` key.

> **File writes:** ultraswarm always passes `--force` so the agent applies edits in
> one-shot mode. Without `--force`, the CLI only proposes changes and the task fails
> with `no_changes`.

> **API key:** headless runs need `CURSOR_API_KEY`. Add it to `workerEnvAllowlist`:
>
> ```json
> { "workerEnvAllowlist": ["CURSOR_API_KEY"] }
> ```

When Cursor is both host and worker, keep at least one other worker enabled so
high-risk tasks can satisfy competition policy.

## Local / Private Models (Ollama)

`pi` and `pi-local` are both backed by the [`pi`](https://github.com/earendil-works/pi)
CLI. `pi` runs a provider-agnostic Anthropic Claude spread; `pi-local` is an always-on
worker that routes through **Ollama** for fully local, private, offline-capable runs.

Ollama is a model backend, not an agentic worker — it cannot edit files or run commands on
its own. `pi-local` is the harness that drives local models with tool-calling inside an
isolated worktree.

To use `pi-local`:

1. Install and run [Ollama](https://ollama.com).
2. Pull the models you want, e.g. `ollama pull qwen3-coder:7b` and
   `ollama pull qwen3-coder:30b`.
3. Register an `ollama` provider and those models in `~/.pi/agent/models.json` (Pi reads
   provider entries with `baseUrl: http://localhost:11434/v1`, `api: openai-completions`).
4. Override the default model IDs in `ultraswarm.config.json` to match the models you
   pulled (see `ultraswarm.config.advanced.json`).

`doctor` and `workers` probe the `pi` binary, so a green `pi-local` means "pi is
installed" — not "Ollama is running." If Ollama is down, `pi-local` tasks fail at execution
time and are reported and retried like any other worker failure.

> **Local-model requirement:** `pi-local` only works with a local model that emits
> **structured tool-calls** through Pi's provider endpoint. Many small local models (and the
> OpenAI-completions compatibility path) will describe an edit as plain text instead of
> calling the `write`/`edit` tool — Pi then has nothing to execute and no file is produced,
> so the task fails its contract. Choose a local model with reliable tool-calling, and treat
> the default `qwen3-coder` IDs as examples to override. Frontier-hosted providers (the `pi`
> worker) do not have this limitation.

## Effort Levels

Reasoning effort is a per-task dial, **independent of model tier**. The decomposition brain
assigns `effort` (`off`/`low`/`medium`/`high`/`xhigh`) to each task and **defaults to `low`** —
most routine tasks produce the same result at low effort, far faster and cheaper. High effort is
reserved for genuinely hard reasoning.

Effort is injected per CLI for the workers that expose the dial (`codex`, `droid`, `pi`); other
workers ignore it. On QA failure, ultraswarm escalates **effort first** (low → medium → high)
before spending more — the cheapest correction rung first. Routine tasks climb effort within
their model tier; high-risk and complex tasks use the full ladder, stepping up the model tier
only after effort tops out.

Set `effort` explicitly on a task in your plan JSON to override, or override `effortFlags` per CLI
in `ultraswarm.config.json` (see `ultraswarm.config.advanced.json`).

> Behavior note: because effort defaults to `low`, an expert-tier task runs the expert *model* at
> *low* effort and escalates on failure — it is no longer pinned to high effort. Pin it with
> `effort: "high"` if you need maximum reasoning up front.

## State And Safety

- Worker attempts run in separate worktrees and process groups.
- Accepted task commits are squash-integrated into
  `ultraswarm/run-<run-id>`, not the checked-out branch.
- Worker environments use an allowlist rather than inheriting secrets.
- Logs redact common credential assignments and rotate at the output limit.
- Task contracts run commands and reject changes outside `allowed_paths`.
- `.ultraswarm/` is ignored by Git and contains SQLite state, worker logs, the functional-probe cache, and per-task worktrees.
- Token usage is read only from a worker's **structured** output (codex `exec --json`, opencode `run --format json`) — never a text scrape. A worker invoked without its JSON flag, or one with no usage parser yet (gemini/grok/agy/droid/pi), runs fine and the report honestly says "Token/cost usage: not reported", never a fabricated number. The figures are usage estimates, not a billing source of truth.
- v2 JSONL journals remain readable files but cannot be resumed as v3 runs.

## Development

```bash
npm test
bash scripts/validate.sh
node scripts/generate-host-skills.mjs --check
```

Edit `hosts/host-contract.json` or `scripts/generate-host-skills.mjs`, then run
`node scripts/generate-host-skills.mjs`. Do not hand-edit generated host skills.

Host install scripts:

- Codex: `bash scripts/install-codex-skill.sh`
- Cursor: `bash scripts/install-cursor-skill.sh`

A pre-commit hook (in `.githooks/`, auto-enabled by `npm install` via the `prepare` script)
blocks commits that introduce host-skill drift — the generated `SKILL.md` files must stay in
sync with `hosts/host-contract.json`. Enable it manually with
`git config core.hooksPath .githooks`. CI (`.github/workflows/validate.yml`) runs
`validate.sh` and the full test suite on every PR, and `main` requires a passing CI run
through a pull request before merge.

## License

MIT
