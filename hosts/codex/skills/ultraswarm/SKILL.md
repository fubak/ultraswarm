---
name: ultraswarm
description: Orchestrate complex coding work from Codex through the ultraswarm standalone runner. Use when the user invokes $ultraswarm, asks to analyze a task for swarm execution, configure ultraswarm workers, or delegate implementation to multiple external coding CLIs.
---

# Ultraswarm for Codex

Use Codex as the host and planner for the ultraswarm standalone runner. Do not
implement the requested feature directly.

## Modes

Dispatch from the user's invocation:

- `$ultraswarm analyze <task>`: analyze complexity, proposed task boundaries,
  dependency waves, risk, worker routing, and model tiers. Do not write a plan
  file or launch workers.
- `$ultraswarm config`: inspect available worker CLIs and help create or update
  `ultraswarm.config.json`. Do not launch a swarm.
- `$ultraswarm <task>`: prepare a validated plan, show it to the user, and wait
  for explicit approval before executing the runner.

## Locate The Runner

Resolve the ultraswarm checkout in this order:

1. `$ULTRASWARM_HOME`, when set.
2. The repository containing this skill's real path. For the supported symlink
   installation, resolve `~/.agents/skills/ultraswarm` with `readlink -f`; the
   checkout root is four directories above this `SKILL.md`.
3. `~/projects/ultraswarm`.

The selected root must contain `bin/ultraswarm.mjs` and `package.json`. If no
checkout is available, stop and give the repository installation command from
the project README. Never guess a runner path.

## Analyze

For analysis-only mode:

1. Inspect the target repository's structure, conventions, gates, and relevant
   code.
2. Assess domain, logic, context, interface, and risk complexity.
3. Propose atomic tasks with dependency waves, worker CLI, model tier, risk,
   and expected files.
4. Report the plan and stop. Do not create `.ultraswarm-plan.json`, invoke the
   runner, or call external worker CLIs.

## Configure

For configuration mode:

1. Check `command -v` and `--version` for `codex`, `gemini`, `grok`, `agy`,
   `droid`, and `opencode`.
2. Read the checkout's `ultraswarm.config.example.json` and
   `ultraswarm.config.advanced.json`.
3. Ask which healthy workers to enable and whether configuration should be
   project-local or global.
4. Write project configuration to `ultraswarm.config.json`, or global
   configuration to `~/.claude/ultraswarm.config.json`.
5. Validate the result with the checkout's `scripts/router.mjs`
   `validateConfig` export. Do not launch a swarm.

Ultraswarm requires at least two authenticated worker CLIs for execution.

## Full Run

For a normal run:

1. Inspect the target repository, including its conventions, likely files,
   existing tests, and build/test/lint gates.
2. Resolve the runner checkout and verify dependencies are installed.
3. Write `.ultraswarm-plan.json` in the target repository using this shape:

```json
{
  "tasks": [
    {
      "id": "safe-task-id",
      "description": "Atomic implementation task",
      "files": ["path/to/file"],
      "cli": "codex",
      "model_tier": "simple",
      "complexity_score": 15,
      "risk": "routine",
      "dependencies": [],
      "prompt": "Self-contained implementation instructions and acceptance criteria"
    }
  ]
}
```

Constraints:

- `cli`: `codex`, `gemini`, `grok`, `agy`, `droid`, or `opencode`.
- `model_tier`: `simple`, `moderate`, `complex`, or `expert`.
- `risk`: `routine` or `high`.
- `id`: only `[A-Za-z0-9._-]`, and must not start with `-`.
- Tasks in the same dependency wave must be independently implementable.
- Prompts must be self-contained and include acceptance criteria.

4. Validate and preview the plan without `--yes`:

```bash
node <ultraswarm-root>/bin/ultraswarm.mjs \
  --plan-file .ultraswarm-plan.json
```

5. Present the task table, dependency waves, routing, risks, and gates. Wait for
   explicit user approval.
6. After approval, execute:

```bash
node <ultraswarm-root>/bin/ultraswarm.mjs \
  --plan-file .ultraswarm-plan.json \
  --yes
```

7. Relay the runner's report, including merged, failed, and blocked tasks,
   attempts, model usage, and gate results.

The runner's QA brain defaults to the authenticated local `claude` CLI. To use
the Anthropic API instead, set `ULTRASWARM_BRAIN=anthropic-api` and
`ANTHROPIC_API_KEY`.

## Safety Contract

- Never launch a full run without explicit approval after plan preview.
- Never implement feature code in the Codex host while ultraswarm is selected.
- Never silently reduce the worker roster below two healthy CLIs.
- Preserve unrelated user changes in the target repository.
- Treat failed prerequisites as blockers; never run dependent tasks blind.
