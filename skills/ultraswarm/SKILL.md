---
name: ultraswarm
description: Orchestrate external AI CLIs (codex, gemini, grok, agy, droid, opencode) as coding workers in isolated git worktrees — Claude decomposes, authors a Workflow, QAs, and merges; the CLIs write the code. Use when the user invokes /ultraswarm <task> or asks to delegate a multi-task coding job to external CLI agents with full verification.
---

# Ultraswarm — External-CLI Agent Swarm

**Role contract:** Claude does NOT write feature code (single exception: the last-resort fail path, always flagged in the report). Claude decomposes, authors the Workflow, reviews, judges, merges, and reports. External CLIs do all coding inside isolated git worktrees.

## CLI Worker Registry

| CLI | Invocation (run inside the worktree) | Specialty | Timeout |
|---|---|---|---|
| codex | `codex exec --full-auto "$(cat .ultraswarm-prompt.txt)"` | Backend, logic, algorithms, debugging | 10 min |
| gemini | `gemini --yolo -p "$(cat .ultraswarm-prompt.txt)"` | Frontend, UI, CSS, components | 10 min |
| droid | **DISABLED — not authenticated (FACTORY_API_KEY/login required)**; excluded from routing; re-verify steps live in docs/notes/cli-verification.md | General full-stack implementation, refactoring | 10 min |
| grok | `grok --always-approve -p "$(cat .ultraswarm-prompt.txt)"` | Tests, refactors, general | 10 min |
| agy | `agy --print-timeout 15m -p "$(cat .ultraswarm-prompt.txt)"` | Docs, boilerplate, general | 10 min |
| opencode | `opencode run --agent build -m "xai/grok-build-0.1" "$(cat .ultraswarm-prompt.txt)"` | Junior tier: boilerplate, lint/type fixes, simple tests, JSDoc | 10 min |

**Registry quirks** (verified 2026-06-07; details in docs/notes/cli-verification.md):
- Exit codes are uncharacterized for some CLIs — wrappers must verify success via artifacts (files, commits) and gate results, never log-grepping; grok emits spurious ERROR lines on successful runs.
- All invocations assume the current working directory is the worktree containing `.ultraswarm-prompt.txt`.
- If opencode fails with `UnknownError`, run `opencode models` and check for model drift (the old `opencode/grok-code` model is dead).

Worktrees: `~/worktrees/<reponame>-us-<taskid>-<cli>`, branch `ultraswarm/<taskid>-<cli>`.

## Phase 0 — Decompose (inline, before any Workflow)

1. **Health check:** run `<cli> --version` for every registry row. Drop broken CLIs from routing and TELL THE USER which were dropped. If fewer than 2 CLIs are healthy, stop and report — do not fall back to Claude-coded work silently.
2. **Explore the target repo:** structure, conventions, tech stack. Detect the gate commands (build, typecheck, test, lint) from package.json / Makefile / CI config. If there is no test command, say so loudly and ask whether to proceed (QA loses its mechanical tier).
3. **Decompose** into 3–10 tasks: `{id, description, files, cli, risk, acceptance, prompt}`.
   - `risk: "high"` if the task touches auth/security/payments, changes shared interfaces or data models, has architectural impact, or modifies logic with no existing test coverage. Otherwise `"routine"`.
   - Route by specialty (table above). Tasks should be independent; if two tasks must touch the same file, merge them into one task.
   - `prompt` must be **fully self-contained** — external CLIs have zero conversation context. Include: project name + tech stack, exact file paths, conventions to follow (naming, error handling, immutability), the expected outcome, constraints ("do not modify files outside <list>", "do not add dependencies"), and the acceptance criteria including the exact test command that must pass.
4. **Present the task table to the user and get explicit confirmation.** This confirmation is the Workflow opt-in gate — never launch the Workflow without it.

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
// args: {
//   repo: '/abs/path', repoName: 'name',
//   gates: [{name:'build',cmd:'npm run build'},{name:'test',cmd:'npm test'}, ...],
//   registry: { codex: 'codex exec --full-auto "$(cat .ultraswarm-prompt.txt)"', ... },
//   alternates: { codex:'grok', gemini:'codex', grok:'opencode', agy:'grok', opencode:'codex' },  // adapt to healthy CLIs in Phase 0
//   timeoutMs: 600000,
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

const wt = (t, cli) => `~/worktrees/${args.repoName}-us-${t.id}-${cli}`
const br = (t, cli) => `ultraswarm/${t.id}-${cli}`
const gateList = args.gates.map(g => `${g.name}: ${g.cmd}`).join('\n   ')

const implPrompt = (t, cli, attempt, feedback) => `You are a THIN WRAPPER around an external coding CLI. You do NOT write or fix feature code yourself — your only file edits are housekeeping named below.

Repo: ${args.repo} · Task: ${t.id} — ${t.description} · Attempt ${attempt}

1. Worktree: if ${wt(t,cli)} does not exist, run: cd ${args.repo} && git worktree add ${wt(t,cli)} -b ${br(t,cli)} (if the branch exists from a previous attempt, omit -b). If it exists, use it as-is.
2. Write the following CLI prompt VERBATIM to ${wt(t,cli)}/.ultraswarm-prompt.txt:
---PROMPT START---
${t.prompt}${feedback.length ? `

REVIEWER FEEDBACK FROM PREVIOUS ATTEMPT — fix every item:
- ${feedback.join('\n- ')}` : ''}
---PROMPT END---
3. Run the CLI inside the worktree (Bash timeout ${args.timeoutMs}): cd ${wt(t,cli)} && ${args.registry[cli]}
4. After it exits, run each gate inside the worktree and record pass/fail + a one-line detail:
   ${gateList}
5. Housekeeping: rm ${wt(t,cli)}/.ultraswarm-prompt.txt, then cd ${wt(t,cli)} && git add -A && git commit -m "ultraswarm: ${t.id} attempt ${attempt}" (commit even if gates failed — the diff must be inspectable).
6. Return JSON per schema. status "ok" ONLY if the CLI completed AND every gate passed. Do not fix gate failures yourself — report them in gate_results detail and concerns. If the CLI errored immediately: "cli_failed". If you had to kill it: "timeout". List any files the CLI touched outside ${JSON.stringify(t.files)} in concerns.`

const reviewPrompt = (t, impl) => `Review external-CLI work. cd ${impl.worktree} && git diff main...${impl.branch} (use merge-base if main is not the base). Task: ${t.description}. Acceptance: ${t.acceptance}.
Check: (1) acceptance criteria actually met — not just plausible; (2) project convention conformance; (3) no scope creep beyond ${JSON.stringify(t.files)}; (4) no silently swallowed errors; (5) tests verify intent, not hardcoded outputs. approve=false with concrete, actionable issues if anything fails.`

const judgePrompt = (t, impl) => `Score this implementation 0-10. cd ${impl.worktree} && git diff main...${impl.branch}. Task: ${t.description}. Acceptance: ${t.acceptance}. Criteria: correctness (50%), simplicity (30%), convention fit (20%). List graft_ideas: anything this attempt does well that a competing attempt might lack.`

const lensPrompt = (lens, t, impl) => `ADVERSARIAL REVIEW — try to REFUTE this work via the ${lens} lens. cd ${impl.worktree} && git diff main...${impl.branch}. Task: ${t.description}. Acceptance: ${t.acceptance}. Run commands/tests in the worktree if needed to prove a failure. Default refuted=true if you find a real problem; refuted=false only if it survives scrutiny. reasons must be concrete.`

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
  return { approve: ok, issues: votes.filter(v => v.refuted).flatMap(v => v.reasons) }
}
async function attemptLoop(t, cli, maxAttempts, seedFeedback) {
  let feedback = seedFeedback
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const impl = await implement(t, cli, attempt, feedback)
    if (!impl || impl.status !== 'ok') {
      feedback = [...feedback, `attempt ${attempt} (${cli}): ${impl ? `${impl.status} — ${impl.summary}` : 'wrapper agent died'}`]
      continue
    }
    const verdict = await qa(t, impl)
    if (verdict.approve) return { task: t.id, cli, impl, attempts: attempt, feedback }
    feedback = [...feedback, ...verdict.issues]
    log(`${t.id}: attempt ${attempt} on ${cli} rejected (${verdict.issues.length} issues)`)
  }
  return null
}
async function runTask(t) {
  if (t.risk === 'high') {
    const clis = [t.cli, args.alternates[t.cli]]
    log(`${t.id} (high risk): competing on ${clis.join(' vs ')}`)
    const impls = (await parallel(clis.map(c => () => implement(t, c, 1, [])))).filter(Boolean).filter(i => i.status === 'ok')
    let winner = impls[0], graft = []
    if (impls.length > 1) {
      const scores = (await parallel(impls.map(i => () =>
        agent(judgePrompt(t, i), { label:`judge:${t.id}`, phase:'QA', schema: JUDGE_SCHEMA }).then(s => ({ i, s }))))).filter(x => x && x.s)
      scores.sort((a, b) => b.s.score - a.s.score)
      winner = scores[0]?.i ?? winner
      graft = scores.slice(1).flatMap(x => x.s.graft_ideas)
    }
    if (winner) {
      const verdict = await qa(t, winner)
      if (verdict.approve) return { task: t.id, cli: clis.find(c => winner.worktree.endsWith(c)), impl: winner, attempts: 1, graft }
      const retried = await attemptLoop(t, t.cli, 2, verdict.issues)   // retries 2-3 on primary
      if (retried) return { ...retried, graft }
    }
  }
  const primary = await attemptLoop(t, t.cli, 3, [])
  if (primary) return primary
  log(`${t.id}: ${t.cli} exhausted, reassigning to ${args.alternates[t.cli]}`)
  const fallback = await attemptLoop(t, args.alternates[t.cli], 2, [`prior CLI (${t.cli}) failed all attempts on this task`])
  return fallback ?? { task: t.id, failed: true }
}

const results = (await pipeline(args.tasks, t => runTask(t))).filter(Boolean)
return {
  approved: results.filter(r => !r.failed),
  failed: results.filter(r => r.failed).map(r => r.task),
}
```

Notes: high-risk tasks run attempt 1 as a two-CLI competition, then up to 2 feedback retries on the primary; routine tasks get 3 attempts on the primary then 2 on the alternate. All rejection feedback accumulates into the next attempt's prompt. Both branches return through the same shape; a task that exhausts every path comes back as `{task, failed: true}` — never silently dropped.

## Phase 3 — Merge (inline, orchestrator Claude, after the Workflow returns)

Sequential, one approved result at a time:

```bash
cd <repo>
git merge --squash <branch>           # or: git diff <merge-base> <branch> | git apply
# run EVERY gate (build, typecheck, test, lint)
git commit -m "feat: <task summary> (ultraswarm: <cli>)"
git worktree remove --force <worktree> && git branch -D <branch>
```

- A gate failure after merge stops the line: revert the squash (`git reset --hard HEAD` before commit / `git revert` after), re-enter the fail path for that task only, continue with the rest, and report it.
- Conflicts: resolve by picking one source of truth (Rule 7 — never blend), and document the choice in the report.
- Apply any `graft` ideas worth keeping as small Claude edits during merge, listed in the report.
- Remove losing/unused competition worktrees and branches too.

## Phase 4 — Final verify & report

1. Full test suite + coverage (80% floor) + lint on the merged tree.
2. Report table: task · CLI used · attempts · QA verdict · files. Then, loudly: tasks that failed entirely, tasks Claude had to implement directly (last-resort fail path), conflicts resolved and how, grafts applied, CLIs dropped at health check. Never report done unless the final gate passed.

## Failure handling

| Failure | Response |
|---|---|
| CLI missing/broken at health check | Drop from routing, tell the user |
| CLI timeout / crash mid-task | Counts as failed attempt → retry/reassign path |
| Wrapper agent dies (null) | Same as failed attempt |
| All CLIs exhausted on a task | Claude implements it directly — flagged in report |
| Merge conflict | Claude resolves, pick-don't-blend, documented |
| Post-merge gate regression | Revert that merge, fail path for that task, line continues |
