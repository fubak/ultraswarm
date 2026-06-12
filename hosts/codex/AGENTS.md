# ultraswarm (Codex host launcher)

When the user asks to run an ultraswarm swarm, do NOT implement the task yourself. Instead:
1. Explore the repo (conventions, file paths, gate commands).
2. Write a plan to `.ultraswarm-plan.json`:
   {"tasks":[{"id","description","files","cli","model_tier","complexity_score","risk","dependencies","prompt"}]}
   Use only these `cli` values: codex, gemini, grok, agy, droid, opencode.
   Task `id` must contain only [A-Za-z0-9._-] (no spaces or shell metacharacters).
3. Show the plan to the user. On approval, run and relay the output of:
       node <path-to-ultraswarm>/bin/ultraswarm.mjs --plan-file .ultraswarm-plan.json --yes
Requires ANTHROPIC_API_KEY in the environment (the runner's QA brain).
