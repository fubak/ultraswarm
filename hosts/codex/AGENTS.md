# ultraswarm (legacy Codex host launcher)

The preferred Codex integration is the repository's installable skill:

```bash
bash <path-to-ultraswarm>/scripts/install-codex-skill.sh
```

Restart Codex, then invoke `$ultraswarm <task>`. Keep this `AGENTS.md` launcher
only for repositories where installing a user skill is not possible.

When the user asks to run an ultraswarm swarm, do NOT implement the task yourself. Instead:
1. Explore the repo (conventions, file paths, gate commands).
2. Write a plan to `.ultraswarm-plan.json`:
   {"tasks":[{"id","description","files","cli","model_tier","complexity_score","risk","dependencies","prompt"}]}
   Use only these `cli` values: codex, gemini, grok, agy, droid, opencode, pi, pi-local, small-harness, agent.
   Task `id` must contain only [A-Za-z0-9._-] (no spaces or shell metacharacters).
3. Show the plan to the user. On approval, run and relay the output of:
       node <path-to-ultraswarm>/bin/ultraswarm.mjs --plan-file .ultraswarm-plan.json --yes
The runner's QA brain defaults to the local authenticated `claude` CLI — no API key needed if Claude Code is installed and signed in. (Set `ULTRASWARM_BRAIN=anthropic-api` + `ANTHROPIC_API_KEY` to use the raw Anthropic API instead.)
