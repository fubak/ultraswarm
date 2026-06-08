---
name: ultraswarm
description: Orchestrate external AI CLIs (codex, gemini, grok, agy, droid, opencode) as coding workers in isolated git worktrees — Claude decomposes, authors a Workflow, QAs, and merges; the CLIs write the code. Use when the user invokes /ultraswarm <task> or asks to delegate a multi-task coding job to external CLI agents with full verification.
---

# Ultraswarm — External-CLI Agent Swarm

**Role contract:** Claude does NOT write feature code (single exception: the last-resort fail path, always flagged in the report). Claude decomposes, authors the Workflow, reviews, judges, merges, and reports. External CLIs do all coding inside isolated git worktrees.

**Modes** — dispatch on the invocation argument:
- `/ultraswarm config` (argument is exactly `config`, or the user asks to set up / choose / change which CLIs the swarm uses) → run the **Configuration builder** (see the Configuration section) and stop. Do NOT decompose or run a Workflow.
- `/ultraswarm <task>` (anything else) → normal run, starting at Phase 0.

## CLI Worker Registry

The table below is the **built-in default roster**. The user's config (next section) selects which of these the swarm may actually use and can override any field per CLI.

| CLI | Invocation (run inside the worktree) | Specialty | Timeout |
|---|---|---|---|
| codex | `codex exec -s workspace-write --skip-git-repo-check "$(cat .ultraswarm-prompt.txt)" </dev/null` ⏳ slow (~5 min/task with gpt-5.5) — give it a 15-min timeout. `-s workspace-write` is required (default sandbox rejects worktree writes); `</dev/null` is required (codex hangs waiting on stdin otherwise). | Backend, logic, algorithms, debugging | 15 min |
| gemini | `gemini --yolo -p "$(cat .ultraswarm-prompt.txt)"` | Frontend, UI, CSS, components | 10 min |
| droid | `droid exec "$(cat .ultraswarm-prompt.txt)"` — requires an active Factory subscription. Help-verified, not smoke-tested here (the test machine had no plan; `droid exec` returned 0 turns / 0 tokens, consistent with no model access). On a subscribed machine the Phase 0 write probe confirms it before routing. | General full-stack implementation, refactoring | 10 min |
| grok | `grok --always-approve -p "$(cat .ultraswarm-prompt.txt)"` | Tests, refactors, general | 10 min |
| agy | `agy --print-timeout 15m --prompt "$(cat .ultraswarm-prompt.txt)"` | Docs, boilerplate, general | 10 min |
| opencode | `opencode run --agent build -m "xai/grok-build-0.1" "$(cat .ultraswarm-prompt.txt)"` | Junior tier: boilerplate, lint/type fixes, simple tests, JSDoc | 10 min |

**Registry quirks** (verified 2026-06-07; details in docs/notes/cli-verification.md):
- Exit codes are uncharacterized for some CLIs — wrappers must verify success via artifacts (files, commits) and gate results, never log-grepping; grok emits spurious ERROR lines on successful runs.
- All invocations assume the current working directory is the worktree containing `.ultraswarm-prompt.txt`.
- If opencode fails with `UnknownError`, run `opencode models` and check for model drift (the old `opencode/grok-code` model is dead).
- codex is slow (~5 min/task) and MUST have stdin closed (`</dev/null`, already in its invocation) — without it codex blocks on stdin and the wrapper times out. Use a 15-min wrapper timeout for codex tasks.

Worktrees: `~/worktrees/<reponame>-us-<taskid>-<cli>`, branch `ultraswarm/<taskid>-<cli>`.

## Configuration — selecting which CLIs the swarm uses

Users control the roster with a JSON config. Two locations, **project overrides global**:

1. **Global default:** `~/.claude/ultraswarm.config.json` — applies to every repo.
2. **Project override:** `ultraswarm.config.json` in the target repo root — overrides the global file for that repo only.

**Schema** (all fields optional):

```json
{
  "enabled": ["codex", "grok", "agy"],
  "overrides": {
    "codex":    { "timeoutMs": 900000 },
    "opencode": { "invocation": "opencode run --agent build -m \"xai/grok-4.3\" \"$(cat .ultraswarm-prompt.txt)\"" }
  }
}
```

- `enabled` — allowlist of registry CLI names the swarm may use. **Omit entirely** to mean "all installed CLIs from the default roster." An empty array `[]` is an error (don't disable everything silently — tell the user).
- `overrides` — per-CLI field overrides merged onto the default registry row. Supported keys: `invocation` (the exact shell command), `timeoutMs` (per-CLI wall-clock budget → the Workflow's `timeouts[cli]`), `specialty` (routing hint), `alternate` (fallback CLI for the reassign step).

**Merge rule:** if a project config is present, its `enabled` **replaces** the global `enabled` (not unioned), and its `overrides` deep-merge onto the global overrides (project wins per CLI). A missing file at either level is simply skipped.

**How Phase 0 applies it:** the effective roster =
`config.enabled` (or the full default roster if `enabled` is omitted)
 → keep only CLIs that pass the health check **and** the write probe
 → apply `overrides`.
Always show the user the resulting roster and why anything was excluded (not in `enabled` · not installed · failed write probe). If the config names a CLI that isn't in the built-in registry, warn and ignore it.

### Configuration builder (`/ultraswarm config`)

Run this when invoked as `/ultraswarm config`. It writes/updates a config file; it does not run a coding job.

1. **Probe every registry CLI** for real availability — the binary name equals the registry key (`codex`, `gemini`, `grok`, `agy`, `droid`, `opencode`), so for each: `command -v <cli>` and `<cli> --version` (and note auth-gated ones like droid that need a subscription). Optionally run the full write probe if the user wants certainty; otherwise presence is enough for the builder.
2. **Show a table:** CLI · installed? · version · currently-enabled (from any existing config) · specialty.
3. **Ask which CLIs to enable** (use AskUserQuestion with `multiSelect: true`, pre-checking the installed ones). Let the user pick freely — they may enable an installed CLI you couldn't fully verify, or leave one out deliberately.
4. **Ask the scope:** write to the **global** file (`~/.claude/ultraswarm.config.json`) or a **project** file (`./ultraswarm.config.json`).
5. **Write the JSON** (preserving any existing `overrides`), then read it back and show the final contents. Confirm the path written and remind the user it takes effect on the next `/ultraswarm` run.
6. If `< 2` CLIs end up enabled, warn clearly — the swarm needs at least two healthy CLIs to run (competition + reassignment depend on it).

## Phase 0 — Decompose (inline, before any Workflow)

1. **Load config & health-check.** First read the config (global `~/.claude/ultraswarm.config.json`, then project `./ultraswarm.config.json` overriding it — see the Configuration section for the merge rule); the candidate roster is the merged `enabled` list, or the full default registry if no `enabled` is set. If the user has never configured anything and you have not mentioned it this session, note once that `/ultraswarm config` lets them pick the roster. Then for each candidate run `<cli> --version` **and** a **write probe**: create a scratch linked worktree of the target repo, have the CLI create one trivial file there, verify the artifact exists, remove the worktree. `--version` proves presence, not the ability to write — sandboxed or unsubscribed CLIs can fail every write inside linked worktrees while appearing installed (e2e-verified 2026-06-07: codex's bwrap sandbox did exactly this; droid needs a Factory plan). Drop CLIs that fail either check and TELL THE USER which were dropped and why (not in `enabled` · not installed · failed write probe). If fewer than 2 CLIs survive, stop and report — do not fall back to Claude-coded work silently. Finally, build the Workflow args from the surviving CLIs: `registry`/`alternates` from each row's (possibly overridden) `invocation`/`alternate`, and `timeouts[cli]` from each row's Timeout column converted to ms (e.g. codex 15 min → 900000), with any `overrides.timeoutMs` applied on top; routing uses each row's (possibly overridden) `specialty`.
2. **Explore the target repo:** structure, conventions, tech stack. Detect the gate commands (build, typecheck, test, lint) from package.json / Makefile / CI config. If there is no test command, say so loudly and ask whether to proceed (QA loses its mechanical tier).
3. **Decompose** into 3–10 tasks: `{id, description, files, cli, risk, acceptance, prompt}`.
   - `risk: "high"` if the task touches auth/security/payments, changes shared interfaces or data models, has architectural impact, or modifies logic with no existing test coverage. Otherwise `"routine"`.
   - Route by specialty (table above). Tasks should be independent; if two tasks must touch the same file, merge them into one task.
   - `prompt` must be **fully self-contained** — external CLIs have zero conversation context. Include: project name + tech stack, exact file paths, conventions to follow (naming, error handling, immutability), the expected outcome, constraints ("do not modify files outside <list>", "do not add dependencies"), and the acceptance criteria including the exact test command that must pass.
4. **Verify the gates on the base tree:** run every gate command at the repo root and require green exits before any Workflow launch. A gate that fails or errors on the base tree poisons every QA cycle — wrappers report `gates_failed` regardless of what the CLI wrote, and workers flail trying to satisfy an unsatisfiable command (e2e-verified 2026-06-07: a Node-26-incompatible test script tombstoned every task). Fix the gate or drop it (with the user's confirmation) first.
5. **Present the task table to the user and get explicit confirmation.** This confirmation is the Workflow opt-in gate — never launch the Workflow without it.

## Phases 1–2 — Workflow Script Template

Author this per-invocation (adapt `args`, keep the structure). Pass real values via `args`, never hardcode into the script body:

```js
export const meta = {
  name: 'ultraswarm-run',
  description: 'External CLIs implement tasks in worktrees; tiered QA per task',
  phases: [
    { title: 'Implement', detail: 'external CLIs code in isolated worktrees' },
    { title: 'QA', detail: 'routine: diff review · high: judge panel + 3-lens adversarial' },
  ],
}
// The runtime exposes the input as the global `args` — but it may arrive as a JSON
// string depending on the caller. Validate at the boundary (e2e-verified 2026-06-07):
const cfg = typeof args === 'string' ? JSON.parse(args) : args
// cfg: {
//   repo: '/abs/path', repoName: 'name',
//   baseBranch: 'main',  // base SHA or branch captured at Phase 0 — worktrees branch from it, all QA diffs review against it
//   worktreeRoot: '/home/<user>/worktrees',  // absolute path — never ~ (must round-trip through agents and git verbatim)
//   gates: [{name:'build',cmd:'npm run build'},{name:'test',cmd:'npm test'}, ...],
//   registry: { codex: 'codex exec --full-auto "$(cat .ultraswarm-prompt.txt)"', ... },
//   alternates: { codex:'droid', gemini:'grok', grok:'agy', agy:'grok', droid:'codex', opencode:'agy' },  // adapt to healthy CLIs in Phase 0 (drop any that fail the write probe)
//   timeoutMs: 600000,  // default per-CLI wall-clock budget
//   timeouts: { codex: 900000 },  // optional per-CLI overrides (from the registry Timeout column + config overrides.timeoutMs); falls back to timeoutMs
//   tasks: [{ id, description, files:[], cli, risk, acceptance, prompt }],
// }

const IMPL_SCHEMA = { type:'object', properties:{
  status:{type:'string',enum:['ok','cli_failed','gates_failed','timeout']},
  worktree:{type:'string'}, branch:{type:'string'},
  files_changed:{type:'array',items:{type:'string'}},
  gate_results:{type:'array',items:{type:'object',properties:{name:{type:'string'},pass:{type:'boolean'},detail:{type:'string'}},required:['name','pass']}},
  summary:{type:'string'}, concerns:{type:'array',items:{type:'string'}},
}, required:['status','worktree','branch','files_changed','gate_results','summary','concerns'] }

const REVIEW_SCHEMA = { type:'object', properties:{ approve:{type:'boolean'}, issues:{type:'array',items:{type:'string'}} }, required:['approve','issues'] }
const JUDGE_SCHEMA  = { type:'object', properties:{ score:{type:'number'}, rationale:{type:'string'}, graft_ideas:{type:'array',items:{type:'string'}} }, required:['score','rationale','graft_ideas'] }
const VERDICT_SCHEMA = { type:'object', properties:{ refuted:{type:'boolean'}, reasons:{type:'array',items:{type:'string'}} }, required:['refuted','reasons'] }

const wt = (t, cli) => `${cfg.worktreeRoot}/${cfg.repoName}-us-${t.id}-${cli}`
const br = (t, cli) => `ultraswarm/${t.id}-${cli}`
const gateList = cfg.gates.map(g => `${g.name}: ${g.cmd}`).join('\n   ')

const implPrompt = (t, cli, attempt, feedback) => `You are a THIN WRAPPER around an external coding CLI. You do NOT write or fix feature code yourself — your only file edits are housekeeping named below.

Repo: ${cfg.repo} · Task: ${t.id} — ${t.description} · Attempt ${attempt}

1. Worktree: if ${wt(t,cli)} does not exist, run: cd ${cfg.repo} && git worktree add ${wt(t,cli)} -b ${br(t,cli)} ${cfg.baseBranch} (if the branch exists from a previous attempt, omit the -b flag and the ${cfg.baseBranch} argument but keep the branch name as the final argument: git worktree add ${wt(t,cli)} ${br(t,cli)}). If it exists, use it as-is.
2. Write the following CLI prompt VERBATIM to ${wt(t,cli)}/.ultraswarm-prompt.txt:
---PROMPT START---
${t.prompt}${feedback.length ? `

REVIEWER FEEDBACK FROM PREVIOUS ATTEMPT — fix every item:
- ${feedback.join('\n- ')}` : ''}
---PROMPT END---
3. Run the CLI inside the worktree (Bash timeout ${cfg.timeouts?.[cli] ?? cfg.timeoutMs}): cd ${wt(t,cli)} && ${cfg.registry[cli]}
4. After it exits, run each gate inside the worktree and record pass/fail + a one-line detail:
   ${gateList}
5. Housekeeping: rm ${wt(t,cli)}/.ultraswarm-prompt.txt, then cd ${wt(t,cli)} && git add -A && git commit -m "ultraswarm: ${t.id} attempt ${attempt}" (commit even if gates failed — the diff must be inspectable).
6. Return JSON per schema. status "ok" ONLY if the CLI completed AND every gate passed. Do not fix gate failures yourself — report them in gate_results detail and concerns. If the CLI errored immediately: "cli_failed". If you had to kill it: "timeout". List any files the CLI touched outside ${JSON.stringify(t.files)} in concerns. "worktree" must be the absolute path ${wt(t,cli)} — never ~-relative.`

const reviewPrompt = (t, impl) => `Review external-CLI work. cd ${impl.worktree} && git diff ${cfg.baseBranch}...${impl.branch}. Task: ${t.description}. Acceptance: ${t.acceptance}.
Check: (1) acceptance criteria actually met — not just plausible; (2) project convention conformance; (3) no scope creep beyond ${JSON.stringify(t.files)}; (4) no silently swallowed errors; (5) tests verify intent, not hardcoded outputs. approve=false with concrete, actionable issues if anything fails.`

const judgePrompt = (t, impl) => `Score this implementation 0-10. cd ${impl.worktree} && git diff ${cfg.baseBranch}...${impl.branch}. Task: ${t.description}. Acceptance: ${t.acceptance}. Criteria: correctness (50%), simplicity (30%), convention fit (20%). List graft_ideas: anything this attempt does well that a competing attempt might lack.`

const lensPrompt = (lens, t, impl) => `ADVERSARIAL REVIEW — try to REFUTE this work via the ${lens} lens. cd ${impl.worktree} && git diff ${cfg.baseBranch}...${impl.branch}. Task: ${t.description}. Acceptance: ${t.acceptance}. Run commands/tests in the worktree if needed to prove a failure. Default refuted=true if you find a real problem; refuted=false only if it survives scrutiny. reasons must be concrete.`

const LENSES = ['correctness (logic errors, unmet acceptance criteria, broken edge cases)',
  'security (hardcoded secrets, unvalidated input, injection, authz gaps, leaky errors)',
  'regression (does existing behavior still work — run the existing test suite)']

async function implement(t, cli, attempt, feedback) {
  return agent(implPrompt(t, cli, attempt, feedback), { label:`impl:${t.id}:${cli}#${attempt}`, phase:'Implement', schema: IMPL_SCHEMA })
}
async function qa(t, impl) {
  if (t.risk !== 'high') {
    const r = await agent(reviewPrompt(t, impl), { label:`review:${t.id}`, phase:'QA', schema: REVIEW_SCHEMA })
    return r ?? { approve:false, issues:['reviewer agent died'] }
  }
  const votes = (await parallel(LENSES.map(l => () =>
    agent(lensPrompt(l, t, impl), { label:`verify:${t.id}:${l.split(' ')[0]}`, phase:'QA', schema: VERDICT_SCHEMA })))).filter(Boolean)
  const ok = votes.filter(v => !v.refuted).length >= 2
  const issues = [
    ...votes.filter(v => v.refuted).flatMap(v => v.reasons),
    ...(votes.length < 2 ? ['adversarial verification could not complete'] : []),
  ]
  return { approve: ok, issues }
}
async function attemptLoop(t, cli, maxAttempts, seedFeedback, attemptOffset = 0) {
  let feedback = seedFeedback
  for (let n = 1; n <= maxAttempts; n++) {
    const attempt = attemptOffset + n
    const impl = await implement(t, cli, attempt, feedback)
    if (!impl || impl.status !== 'ok') {
      const gates = impl ? (impl.gate_results || []).filter(g => !g.pass).map(g => `${g.name}: ${g.detail || 'failed'}`).join('; ') : ''
      feedback = [...feedback, impl
        ? `attempt ${attempt} (${cli}): ${impl.status} — ${impl.summary}${gates ? ` · failing gates: ${gates}` : ''}`
        : `attempt ${attempt} (${cli}): wrapper agent died`]
      continue
    }
    const verdict = await qa(t, impl)
    if (verdict.approve) return { task: t.id, cli, impl, attempts: attempt, feedback }
    feedback = [...feedback, ...verdict.issues]
    log(`${t.id}: attempt ${attempt} on ${cli} rejected (${verdict.issues.length} issues)`)
  }
  return { exhausted: true, feedback }
}
async function runTask(t) {
  if (t.risk === 'high') {
    const clis = [t.cli, cfg.alternates[t.cli]]
    log(`${t.id} (high risk): competing on ${clis.join(' vs ')}`)
    const all = (await parallel(clis.map(c => () =>
      implement(t, c, 1, []).then(i => i && { ...i, cli: c })))).filter(Boolean)
    const impls = all.filter(i => i.status === 'ok')
    let winner = impls[0], graft = []
    if (impls.length > 1) {
      const scores = (await parallel(impls.map(i => () =>
        agent(judgePrompt(t, i), { label:`judge:${t.id}:${i.cli}`, phase:'QA', schema: JUDGE_SCHEMA }).then(s => ({ i, s }))))).filter(x => x && x.s)
      scores.sort((a, b) => b.s.score - a.s.score)
      winner = scores[0]?.i ?? winner
      graft = scores.slice(1).flatMap(x => x.s.graft_ideas)
    }
    let retryCli = t.cli
    let seed = [`attempt 1 (${clis.join(' + ')}): no competitor produced a passing implementation`,
      ...all.filter(i => i.status !== 'ok').map(i => {
        const gates = (i.gate_results || []).filter(g => !g.pass).map(g => `${g.name}: ${g.detail || 'failed'}`).join('; ')
        return `attempt 1 (${i.cli}): ${i.status} — ${i.summary}${gates ? ` · failing gates: ${gates}` : ''}`
      })]
    if (winner) {
      const verdict = await qa(t, winner)
      if (verdict.approve) return { task: t.id, cli: winner.cli, impl: winner, attempts: 1, graft }
      retryCli = winner.cli
      seed = verdict.issues
    }
    const retried = await attemptLoop(t, retryCli, 2, seed, 1)   // attempts 2-3 on the winning CLI's worktree
    if (!retried.exhausted) return { ...retried, graft }
    log(`${t.id} (high risk): ${retryCli} exhausted, reassigning to ${cfg.alternates[retryCli]}`)
    const fallback = await attemptLoop(t, cfg.alternates[retryCli], 2,
      [...retried.feedback, `prior CLI (${retryCli}) failed all attempts on this task`], 3)   // attempts 4-5
    return fallback.exhausted ? { task: t.id, failed: true } : { ...fallback, graft }
  }
  const primary = await attemptLoop(t, t.cli, 3, [])
  if (!primary.exhausted) return primary
  log(`${t.id}: ${t.cli} exhausted, reassigning to ${cfg.alternates[t.cli]}`)
  const fallback = await attemptLoop(t, cfg.alternates[t.cli], 2,
    [...primary.feedback, `prior CLI (${t.cli}) failed all attempts on this task`], 3)   // attempts 4-5
  return fallback.exhausted ? { task: t.id, failed: true } : fallback
}

const results = (await pipeline(cfg.tasks, t => runTask(t))).filter(Boolean)
return {
  approved: results.filter(r => !r.failed),
  failed: results.filter(r => r.failed).map(r => r.task),
}
```

Notes: the high-risk branch is terminal — attempt 1 is a two-CLI competition; the judged winner (or the primary, when no competitor passes attempt 1) gets 2 feedback retries (attempts 2–3) on its own CLI/worktree, then that CLI's alternate gets 2 attempts (4–5), then the task tombstones as `{task, failed: true}`. Routine tasks get 3 attempts on the primary, then 2 on the alternate (attempts 4–5), then the same tombstone. `attemptLoop` returns `{exhausted: true, feedback}` on exhaustion, so all rejection feedback — QA issues and failing-gate details — accumulates and is carried into the alternate CLI's prompts along with a reassignment note. In the high-risk path the alternate may resume in its own competition worktree rather than a fresh one — deliberate: it has its own branch, committed history, and the carried feedback. Both branches return through the same shape; a task that exhausts every path comes back as `{task, failed: true}` — never silently dropped.

## Phase 3 — Merge (inline, orchestrator Claude, after the Workflow returns)

Require a clean working tree (`git status --porcelain` empty) before the first merge. Then sequential, one approved result at a time:

```bash
cd <repo>
git merge --squash <branch>           # or: git diff $(git merge-base <baseBranch> <branch>) <branch> | git apply   (<baseBranch> = the Workflow's cfg.baseBranch)
# run EVERY gate (build, typecheck, test, lint)
git commit -m "feat: <task summary> (ultraswarm: <cli>)"
git worktree remove --force <worktree> && git branch -D <branch>
```

- A gate failure after merge stops the line: revert the squash (`git reset --hard HEAD` before commit / `git revert` after), re-enter the fail path for that task only, continue with the rest, and report it. Re-enter = launch a one-task Workflow from the same template, seeded with the post-merge gate failure as feedback — or go straight to the Claude-implements last resort if budget is spent.
- Conflicts: resolve by picking one source of truth (Rule 7 — never blend), and document the choice in the report.
- Apply any `graft` ideas worth keeping as small Claude edits during merge, listed in the report.
- Cleanup sweep — after the report: run `git worktree list` and `git branch --list 'ultraswarm/*'`, then remove every leftover `<reponame>-us-*` worktree and `ultraswarm/*` branch (losers and failed tasks included). Keep them until after the report so diffs stay inspectable.

## Phase 4 — Final verify & report

1. Full test suite + coverage (80% floor) + lint on the merged tree.
2. Report table: task · CLI used · attempts · QA verdict · files. Then, loudly: tasks that failed entirely, tasks Claude had to implement directly (last-resort fail path), conflicts resolved and how, grafts applied, CLIs dropped at health check. Never report done unless the final gate passed.

## Failure handling

| Failure | Response |
|---|---|
| CLI missing/broken at health check or write probe | Drop from routing, tell the user |
| Gate fails on the base tree | Caught in Phase 0 — never launch the Workflow against a broken gate |
| CLI timeout / crash mid-task | Counts as failed attempt → retry/reassign path |
| Wrapper agent dies (null) | Same as failed attempt |
| All CLIs exhausted on a task | Claude implements it directly — flagged in report |
| Merge conflict | Claude resolves, pick-don't-blend, documented |
| Post-merge gate regression | Revert that merge, fail path for that task, line continues |
