# ultraswarm (Grok host launcher)

When the user asks to run an ultraswarm swarm with Grok as the host, do NOT write the feature code yourself. Instead:
1. Functionally verify the pool: `node <path-to-ultraswarm>/bin/ultraswarm.mjs preflight`. Drop any CLI shown UNUSABLE; don't pin a task to it.
2. Explore the repo (conventions, file paths, gate/build/test commands).
3. Write a decomposed plan to `.ultraswarm-plan.json`:
   {"tasks":[{"id","description","files","cli","model_tier","complexity_score","risk","dependencies","prompt"}]}
   Allowed `cli` values: codex, gemini, grok, agy, droid, opencode, pi, pi-local, small-harness, agent.
   Task `id` must contain only [A-Za-z0-9._-] (no spaces or shell metacharacters).
4. Present the plan to the user. On approval, run and relay the output of:
       node <path-to-ultraswarm>/bin/ultraswarm.mjs --plan-file .ultraswarm-plan.json --yes
   Keep the runner's stderr visible and relay its live progress + final summary (incl. tokens saved).
The runner's QA brain defaults to the local authenticated `claude` CLI — no API key needed if Claude Code is installed and signed in. (Set `ULTRASWARM_BRAIN=anthropic-api` + `ANTHROPIC_API_KEY` to use the raw Anthropic API instead.)

As of v2.4.2 the runner reliably supports the documented `enabled` + `overrides` config for high-risk competition, fails cleanly on worker launch problems or missing alternates, blocks and reports dependents of failed tasks, and avoids leaking host scaffolding into merges. Use it for robust hosted runs from Grok.
