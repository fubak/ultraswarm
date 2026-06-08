# /ultraswarm Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/ultraswarm` skill — Claude orchestrates external AI CLIs (codex, gemini, grok, agy, droid, opencode) coding in isolated git worktrees, with Workflow-driven phases, tiered QA, and Claude-only merge.

**Architecture:** A single SKILL.md (canonical copy in this repo at `skills/ultraswarm/SKILL.md`, symlinked into `~/.claude/skills/ultraswarm`) containing: CLI registry, Phase 0 decomposition protocol, a complete Workflow script template (Implement + QA phases), wrapper/QA prompt templates, and inline merge + final-verify protocol. No application code — the deliverable is the skill document plus verified CLI invocations and an end-to-end smoke test.

**Tech Stack:** Claude Code skills, Workflow tool (JS orchestration), git worktrees, external CLIs (codex, gemini, grok, agy, droid, opencode).

**Spec:** `docs/specs/2026-06-07-ultraswarm-design.md`

**Spec refinements made in this plan** (surfaced per Rule 1, amended into the spec in Task 2):
1. **Merge runs inline** (orchestrator Claude, after the Workflow returns), not inside the Workflow script. Same "sequential, Claude-only" semantics, but conflict resolution (Rule 7 judgment) and user visibility are better in the main loop. The Workflow covers Phases 1–2 and returns `{approved, failed}`.
2. **Worktrees live in `~/worktrees/`** (the user's existing worktree directory), not `<repo>/.ultraswarm/` — nested worktrees pollute `git status` and test globs in the main tree. Naming: `~/worktrees/<reponame>-us-<taskid>-<cli>`.
3. **Prompt delivery via file**: wrapper agents write the CLI prompt to `<worktree>/.ultraswarm-prompt.txt` and invoke `<cli> ... "$(cat .ultraswarm-prompt.txt)"` — multi-line prompts as direct shell arguments break quoting across four different CLIs.

## File Structure

| Path | Responsibility |
|---|---|
| `~/projects/ultraswarm/skills/ultraswarm/SKILL.md` | Canonical skill source (created, Task 2) |
| `~/projects/ultraswarm/docs/notes/cli-verification.md` | Recorded grok/agy/codex/gemini flag verification (created, Task 1) |
| `~/projects/ultraswarm/docs/specs/2026-06-07-ultraswarm-design.md` | Spec (modified: 3 refinement amendments, Task 2) |
| `~/.claude/skills/ultraswarm` | Symlink → repo `skills/ultraswarm` (created, Task 3) |
| `/tmp/ultraswarm-e2e` | Throwaway scratch repo for the smoke test (Task 4, deleted after) |

---

### Task 1: Verify CLI invocations and record the registry

**Files:**
- Create: `~/projects/ultraswarm/docs/notes/cli-verification.md`

- [ ] **Step 1: Capture help/version output for all six CLIs**

Run (each separately; do not pipe through anything that would hide errors):

```bash
codex --version && codex exec --help 2>&1 | head -40
gemini --version && gemini --help 2>&1 | grep -iE 'yolo|approv|prompt|non-interactive' 
grok --version 2>&1; grok --help 2>&1 | head -60
agy --version 2>&1; agy --help 2>&1 | head -60
droid --version 2>&1; droid --help 2>&1 | head -60; droid exec --help 2>&1 | head -40
opencode --version 2>&1; opencode run --help 2>&1 | head -40
```

Expected: codex confirms `exec` subcommand with `--full-auto`; gemini confirms `--yolo`; opencode confirms the `run` form (known-good from /swarm-cli: `opencode run --agent build -m "opencode/grok-code" "<prompt>"`). For grok, agy, and droid, identify from help output: (a) the non-interactive/one-shot invocation form (droid likely `droid exec`), (b) the auto-approve/edit-permission flag (droid has autonomy levels — pick the one that allows file edits without confirmation), (c) how the prompt is passed (positional arg, `-p` flag, or stdin).

- [ ] **Step 2: Smoke-test grok, agy, droid, and opencode with a trivial real task**

```bash
mkdir -p /tmp/cli-smoke && cd /tmp/cli-smoke && git init -q
timeout 180 grok <non-interactive-flags-from-step-1> "Create a file hello-grok.txt containing exactly the line: hello from grok"
cat hello-grok.txt
timeout 180 agy <non-interactive-flags-from-step-1> "Create a file hello-agy.txt containing exactly the line: hello from agy"
cat hello-agy.txt
timeout 180 droid <non-interactive-flags-from-step-1> "Create a file hello-droid.txt containing exactly the line: hello from droid"
cat hello-droid.txt
timeout 180 opencode run --agent build -m "opencode/grok-code" "Create a file hello-opencode.txt containing exactly the line: hello from opencode"
cat hello-opencode.txt
```

Expected: each CLI runs unattended (no interactive prompt hangs) and its file exists with correct content. If a CLI cannot run non-interactively or cannot write files, record it as **disabled** in the registry with the reason — it is excluded from routing and the alternates map, loudly noted in the SKILL.md row.

- [ ] **Step 3: Record results**

Write `docs/notes/cli-verification.md` with: date, version of each CLI, the exact verified one-shot invocation string for each (in the `"$(cat .ultraswarm-prompt.txt)"` form, e.g. `codex exec --full-auto "$(cat .ultraswarm-prompt.txt)"`), pass/fail of the smoke test, and any quirks (e.g., needs `cd` first, writes logs to stdout, exit codes unreliable). This file is the source of truth Task 2 copies into the SKILL.md registry.

- [ ] **Step 4: Clean up and commit**

```bash
rm -rf /tmp/cli-smoke
cd ~/projects/ultraswarm && git add docs/notes/cli-verification.md && git commit -m "docs: verified CLI invocation flags for worker registry"
```

---

### Task 2: Write SKILL.md and amend the spec

**Files:**
- Create: `~/projects/ultraswarm/skills/ultraswarm/SKILL.md`
- Modify: `~/projects/ultraswarm/docs/specs/2026-06-07-ultraswarm-design.md` (architecture section: 3 refinements above)

- [ ] **Step 1: Write the complete SKILL.md**

Write the content below verbatim, with exactly two substitutions: the `grok` and `agy` registry rows (and the `ALTERNATES` map if a CLI was disabled) come from `docs/notes/cli-verification.md`.

`````markdown
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
| gemini | `gemini --yolo "$(cat .ultraswarm-prompt.txt)"` | Frontend, UI, CSS, components | 10 min |
| droid | <VERIFIED-INVOCATION from docs/notes/cli-verification.md> | General full-stack implementation, refactoring | 10 min |
| grok | <VERIFIED-INVOCATION from docs/notes/cli-verification.md> | Tests, refactors, general | 10 min |
| agy | <VERIFIED-INVOCATION from docs/notes/cli-verification.md> | Docs, boilerplate, general | 10 min |
| opencode | `opencode run --agent build -m "opencode/grok-code" "$(cat .ultraswarm-prompt.txt)"` (re-verify) | Junior tier: boilerplate, lint/type fixes, simple tests, JSDoc | 10 min |

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
//   alternates: { codex:'droid', droid:'codex', gemini:'codex', grok:'opencode', agy:'grok', opencode:'codex' },  // adapt to healthy CLIs in Phase 0
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
`````

- [ ] **Step 2: Amend the spec with the three refinements**

In `docs/specs/2026-06-07-ultraswarm-design.md`: (a) in the Architecture diagram/section, note Phases 3–4 run inline in the orchestrator after the Workflow returns; (b) change the worktree path to `~/worktrees/<reponame>-us-<taskid>-<cli>`; (c) note prompt delivery via `.ultraswarm-prompt.txt`; (d) expand the registry to six workers (add droid and opencode rows — user request 2026-06-07). Replace all TBV rows with the verified invocations from Task 1.

- [ ] **Step 3: Self-check the SKILL.md**

Verify: frontmatter parses (name + description present), the Workflow template has no `Date.now()`/`Math.random()`/TS syntax, every schema referenced in an `agent()` call is defined, `attemptLoop`/`implement`/`qa`/`runTask` names are used consistently, file under 800 lines.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/ultraswarm && git add -A && git commit -m "feat: ultraswarm skill — registry, workflow template, QA and merge protocol"
```

---

### Task 3: Install the skill into ~/.claude/skills

**Files:**
- Create: `~/.claude/skills/ultraswarm` (symlink)

- [ ] **Step 1: Check for collisions and link**

```bash
test -e ~/.claude/skills/ultraswarm && echo "COLLISION — stop and ask user" || ln -s ~/projects/ultraswarm/skills/ultraswarm ~/.claude/skills/ultraswarm
```

- [ ] **Step 2: Verify resolution**

```bash
readlink -f ~/.claude/skills/ultraswarm && test -f ~/.claude/skills/ultraswarm/SKILL.md && head -5 ~/.claude/skills/ultraswarm/SKILL.md
```

Expected: resolves to the repo path; frontmatter prints. Note for the user: the skill registry loads at session start, so `/ultraswarm` becomes invocable in the **next** session; within this session, the pipeline is exercised directly (Task 4).

---

### Task 4: End-to-end smoke test

**Files:**
- Create (throwaway): `/tmp/ultraswarm-e2e/` — scratch node repo, deleted at the end

- [ ] **Step 1: Create the scratch repo**

```bash
mkdir -p /tmp/ultraswarm-e2e/src /tmp/ultraswarm-e2e/test && cd /tmp/ultraswarm-e2e
git init -b main -q && git config user.name Fubak && git config user.email fubak@users.noreply.github.com
echo '{"name":"ultraswarm-e2e","type":"module","scripts":{"test":"node --test test/"}}' > package.json
git add -A && git commit -qm "chore: scaffold"
```

- [ ] **Step 2: Run the skill's pipeline exactly as written in SKILL.md**

Follow the installed SKILL.md faithfully (this validates the document, not memory of it): Phase 0 health check; define two **routine** tasks routed to the two CLIs that passed Task 1 verification most cleanly, e.g.:
- `t1` (codex): implement `src/math.js` exporting `add(a,b)` and `multiply(a,b)` with input validation (throw TypeError on non-numbers), plus `test/math.test.js` using `node:test`; acceptance: `npm test` passes.
- `t2` (grok or agy): implement `src/slugify.js` exporting `slugify(str)` (lowercase, trim, non-alphanumerics → single hyphens), plus `test/slugify.test.js`; acceptance: `npm test` passes.

Gates: `[{name:'test',cmd:'npm test'}]`. Launch the Workflow from the template with these args, then perform the inline merge protocol.

- [ ] **Step 3: Verify the outcome**

```bash
cd /tmp/ultraswarm-e2e && npm test && git log --oneline && git worktree list && ls ~/worktrees/ | grep ultraswarm-e2e
```

Expected: tests pass on main; two squash commits with `(ultraswarm: <cli>)` trailers; `git worktree list` shows only the main tree; no leftover `ultraswarm-e2e-us-*` dirs in `~/worktrees`. Confirm the report (Phase 4 format) was produced.

- [ ] **Step 4: Fix any SKILL.md defects found, then clean up and commit**

Defects discovered during the run (bad quoting, wrong flag, schema mismatch, worktree path issue) are fixed **in the SKILL.md**, not worked around — then note each fix in the commit message.

```bash
rm -rf /tmp/ultraswarm-e2e
cd ~/projects/ultraswarm && git add -A && git commit -m "fix: skill corrections from e2e smoke test" # only if changes exist
```

---

### Task 5: Push and report

- [ ] **Step 1: Push**

```bash
cd ~/projects/ultraswarm && git push
```

- [ ] **Step 2: Report to user**

Summarize: registry verification results (including any disabled CLI + substitute), e2e outcome (which CLIs coded, attempts, QA verdicts), defects fixed, and the note that `/ultraswarm` is live from the next session.
