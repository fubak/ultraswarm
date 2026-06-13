# ultraswarm

Ultraswarm is a durable multi-worker coding orchestrator for Codex, Claude Code,
Grok, and shell usage. One standalone Node runner owns decomposition, worker
routing, process supervision, isolated Git worktrees, adaptive review,
transactional integration, approvals, recovery, and reporting.

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
- Generated Claude, Codex, and Grok skills from one provenance-locked contract

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

### Grok Or Shell

Run `node ~/projects/ultraswarm/bin/ultraswarm.mjs ...`. The generated Grok host
contract is at `hosts/grok/skills/ultraswarm/SKILL.md`.

## Prerequisites

- A Git repository
- Node 22+
- At least two authenticated worker CLIs from `codex`, `gemini`, `grok`, `agy`,
  `droid`, `opencode`, `pi`, and `pi-local`
- An authenticated `claude` CLI for the default QA/decomposition brain, or
  `ANTHROPIC_API_KEY` with `ULTRASWARM_BRAIN=anthropic-api`

Check readiness:

```bash
node ~/projects/ultraswarm/bin/ultraswarm.mjs doctor
node ~/projects/ultraswarm/bin/ultraswarm.mjs workers
```

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
- `.ultraswarm/` is ignored by Git and contains SQLite state plus worker logs.
- v2 JSONL journals remain readable files but cannot be resumed as v3 runs.

## Development

```bash
npm test
bash scripts/validate.sh
node scripts/generate-host-skills.mjs --check
```

Edit `hosts/host-contract.json` or `scripts/generate-host-skills.mjs`, then run
`node scripts/generate-host-skills.mjs`. Do not hand-edit generated host skills.

A pre-commit hook (in `.githooks/`, auto-enabled by `npm install` via the `prepare` script)
blocks commits that introduce host-skill drift — the generated `SKILL.md` files must stay in
sync with `hosts/host-contract.json`. Enable it manually with
`git config core.hooksPath .githooks`. CI (`.github/workflows/validate.yml`) runs
`validate.sh` and the full test suite on every PR, and `main` requires a passing CI run
through a pull request before merge.

## License

MIT
