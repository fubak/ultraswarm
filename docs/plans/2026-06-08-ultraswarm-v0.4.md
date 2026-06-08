# ultraswarm v0.4 — Implementation Plan

> **Theme:** Prove what's unproven, harden what's flaky, guard what's fragile. v0.4 adds almost no new surface — it makes the existing v0.3 feature set *trustworthy*: the high-risk path runs live, all reachable CLIs are verified end-to-end, token/failure handling is robust, and CI stops broken releases.

**Date:** 2026-06-08
**Target version:** 0.4.0
**Base:** v0.3 (`bcfe4f2`)

**Scope (4 workstreams, user-selected):**
- **A — Live-validate the high-risk competition path** (the standing gap: judge panel + 3-lens adversarial verify, never run live)
- **B — E2E-verify gemini + opencode** (today only probe-verified)
- **C — Harden token capture + failure handling**
- **D — Project hygiene: CHANGELOG + CI manifest/Workflow checks**

**Success criteria for the release:**
1. A real `risk: "high"` task has run through competition → judge → 3-lens verify → merge, with the transcript captured and any control-flow defects fixed in `SKILL.md`.
2. gemini and opencode each have a green end-to-end pipeline run recorded in `cli-verification.md` (status moves from "probe-verified" to "verified end-to-end").
3. Per-CLI token-usage parsing patterns are documented from real output, and the report honestly states capture coverage (e.g. "4/6 attempts").
4. A CI workflow validates both manifests + the embedded Workflow JS + the example config on every push; a CHANGELOG covers v0.1–v0.4.
5. `v0.4` tagged at HEAD, manifests at `0.4.0`, release notes written, plugin re-pulled.

**Working rules for the executor:**
- Develop in `~/projects/ultraswarm`; the installed plugin (marketplace clone) is downstream. E2E validation authors the Workflow from the **dev-repo** `SKILL.md` directly (no reinstall needed to test).
- Every `SKILL.md` Workflow-template edit must re-pass the JS parse check (Task D2's script) before commit.
- Keep `docs/notes/cli-verification.md` the source of truth; reconcile README + spec after.
- Real external-CLI runs cost provider tokens and minutes (codex ~5 min/task). Budget for it.

---

## Phase D (first) — CI guard + CHANGELOG

Landing CI first means every subsequent v0.4 commit is validated.

### Task D1: CHANGELOG.md

**Files:** Create `CHANGELOG.md`

- [ ] Write `CHANGELOG.md` in Keep-a-Changelog style with one section per release, derived from `git tag` + `gh release view`:
  - `v0.1` — first plugin (skill, Workflow template, tiered QA, merge protocol); packaged as a Claude Code plugin.
  - `v0.2` — `/ultraswarm config` + global/project config files; droid enabled; per-CLI timeout fix.
  - `v0.3` — per-run token-accounting metric; plugin manifest conflict fix; version bump.
  - `v0.4` — (placeholder header "Unreleased" until Task E3 fills it): high-risk path live-validated, gemini+opencode E2E-verified, token/failure hardening, CI.
- [ ] Add a one-line pointer to the CHANGELOG from `README.md` (near the top or in Repository layout).
- [ ] Commit: `docs: add CHANGELOG covering v0.1–v0.3`

### Task D2: Validation script (the reusable check)

**Files:** Create `scripts/validate.sh`

- [ ] Write `scripts/validate.sh` (bash, `set -euo pipefail`) that runs and exits non-zero on any failure:
  1. **Manifests parse:** `jq empty .claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
  2. **No manifest conflict:** assert the marketplace plugin entry does **not** contain a `skills`/`commands`/`agents` key while `plugin.json` exists (the v0.3 bug). Concretely: `jq -e '.plugins[0] | has("skills") or has("commands") or has("agents")' marketplace.json` must be **false** (script fails if true).
  3. **Versions agree:** the three version fields (`plugin.json`, marketplace `metadata.version`, marketplace `plugins[0].version`) are identical.
  4. **Embedded Workflow JS parses:** extract the fenced ` ```js ` block from `skills/ultraswarm/SKILL.md` (anchored `^```js$`/`^```$`), strip the `export const meta {…}` literal, and parse-wrap it: `node -e "new Function('args','agent','parallel','pipeline','log','budget','return (async()=>{'+src+'})()')"`.
  5. **No banned tokens in the template:** grep the JS block for `Date.now(`, `Math.random(`, `new Date(` → fail if present (they break Workflow resume).
  6. **Example config valid:** `jq empty ultraswarm.config.example.json`.
  7. **Skill frontmatter present:** `SKILL.md` starts with `---` and has `name:` + `description:`.
- [ ] Run it locally; expect all checks pass on the current tree. Fix the script (not the repo) if a check misfires.
- [ ] Commit: `chore: add scripts/validate.sh (manifests, workflow JS, config, versions)`

### Task D3: GitHub Actions CI

**Files:** Create `.github/workflows/validate.yml`

- [ ] Workflow triggers on `push` and `pull_request` to `main`. One job `validate` on `ubuntu-latest`:
  - `actions/checkout`
  - `actions/setup-node` (node 20+) — for the JS parse check
  - `run: jq --version` (jq is preinstalled on ubuntu runners)
  - `run: bash scripts/validate.sh`
- [ ] Push the branch and confirm the Action runs green on GitHub (`gh run list` / `gh run watch`).
- [ ] Commit: `ci: validate manifests + workflow template on push`

**Acceptance for Phase D:** `bash scripts/validate.sh` exits 0 locally and the Action is green on `main`.

---

## Phase A — Live-validate the high-risk competition path

This exercises the most complex, never-run code: `runTask`'s `risk === 'high'` branch (competition → judge panel → 3-lens verify → winner-retry → alternate → tombstone).

### Task A1: Design the high-risk smoke task

**Files:** none (design recorded inline in Task A2's run notes)

- [ ] Use a task that genuinely classifies **high** and gives all three lenses real material. **Chosen task:** a signed-token verifier (auth + security):
  - `src/token.js` — `signToken(payload, secret, expiresInSec)` and `verifyToken(token, secret)`. HMAC-SHA256 over `base64url(header).base64url(payload)`, constant-time signature comparison (`crypto.timingSafeEqual`), expiry check, and structured failures (throw `TypeError` on malformed input, return `{valid:false, reason}` on bad sig/expiry).
  - `test/token.test.js` — round-trip valid; tampered payload rejected; wrong secret rejected; expired token rejected; malformed input throws.
  - **Why high-risk:** touches auth + security-sensitive logic (the risk rubric's first trigger). Security lens has substance (timing-safe compare, signature bypass, no secret leakage in errors); correctness lens has the sign/verify round-trip; regression lens runs the suite.
- [ ] **Competition pair:** primary `codex` (backend/logic specialty) vs alternate `grok` — both verified writers, no subscription gate. Set `cfg.alternates = { codex:'grok', grok:'codex' }`.

### Task A2: Run the high-risk pipeline

**Files:** throwaway `/tmp/ultraswarm-hr` (deleted after)

- [ ] Scaffold the scratch repo exactly as the routine e2e (node ESM, `"test":"node --test"`, empty git, gate green on base).
- [ ] Author the Workflow from the **current dev-repo** `SKILL.md` template (copy it, don't reinvent), with `args.tasks = [the A1 task]`, `risk:"high"`, `cfg.timeouts.codex = 900000`.
- [ ] Launch it. **Observe and record** (this is the point of the task — verify each stage actually fires):
  - Two worktrees created (`…-hr-us-t1-codex`, `…-hr-us-t1-grok`)?
  - Both implementations ran and committed?
  - **Judge panel** ran one `judge:t1:<cli>` agent per ok impl, scored, picked a winner?
  - **3-lens verify** ran `verify:t1:correctness|security|regression`, majority decided pass/fail?
  - Winner advanced; on a QA rejection, did it retry on the **winner's** CLI then the alternate (attempt numbering 2-3 then 4-5)?
  - Final return shape carried `worktree`/`branch`/`cli` for the approved winner + `graft` ideas?
- [ ] Inline Phase 3 merge of the winner; full gate; Phase 4 report incl. token accounting.
- [ ] Save the run's agent/phase summary to `docs/notes/highrisk-e2e-2026-06-08.md` (labels, which CLI won, judge scores, lens verdicts, attempts).

### Task A3: Fix any defects the live run exposes

**Files:** `skills/ultraswarm/SKILL.md` (as needed)

- [ ] For each defect found (e.g. judge tie-handling, a lens agent dying and the `votes.length < 2` synthetic-issue path, graft threading, attempt numbering, winner-cli recovery), fix it in the Workflow template, re-run the JS parse check (Task D2 script), and note the fix in the run doc.
- [ ] If the path works clean, record that explicitly ("no defects; N agents; codex won 8.5 vs 7.0; 3/3 lenses passed").
- [ ] Re-run Task A2 after any fix until a clean high-risk run completes and merges green.
- [ ] Clean up `/tmp/ultraswarm-hr` + all `~/worktrees/ultraswarm-hr-*`.
- [ ] Commit: `test: live-validate high-risk competition path; fix <defects or 'no defects found'>`

**Acceptance for Phase A:** one high-risk task has competed, been judged, passed 3-lens verify, and merged green — with the transcript in `docs/notes/highrisk-e2e-2026-06-08.md` and the success criterion #1 met.

---

## Phase B — E2E-verify gemini + opencode

Move both from "probe-verified" to "verified end-to-end" via real routine-tier runs.

### Task B1: gemini end-to-end

**Files:** throwaway `/tmp/ultraswarm-gem`

- [ ] Scaffold scratch repo; gate green on base.
- [ ] One routine task routed to `gemini` (registry invocation `gemini --yolo -p "$(cat .ultraswarm-prompt.txt)"`). Give it a small, self-contained JS module + `node --test` test (e.g. `formatCurrency(cents, currency)` with validation). Alternate `grok`.
- [ ] Run the Workflow (single routine task), inline-merge, verify gates green.
- [ ] Capture gemini's **token-usage output format** verbatim (for Phase C) and whether `-p` ran unattended without hanging.
- [ ] Record result in `cli-verification.md` gemini entry: PASS/fail, smoke artifact, token format, quirks.

### Task B2: opencode end-to-end

**Files:** throwaway `/tmp/ultraswarm-oc`

- [ ] Same shape, routed to `opencode` (`opencode run --agent build -m "xai/grok-build-0.1" …`). Task: a boilerplate/junior-tier module + test (e.g. `clamp(n, lo, hi)` + tests).
- [ ] Before running, confirm the model still resolves (`opencode models | grep grok-build`); if drifted, update the registry invocation + note it.
- [ ] Run, merge, verify; capture opencode's token-usage format + ANSI-output handling.
- [ ] Record result in `cli-verification.md` opencode entry.
- [ ] Clean up both scratch repos + worktrees.
- [ ] Commit: `test: verify gemini and opencode end-to-end; update verification registry`

**Acceptance for Phase B:** both `cli-verification.md` entries say "verified end-to-end (2026-06-08)" with smoke evidence; README roster status updated in Phase E.

---

## Phase C — Harden token capture + failure handling

Fold the real CLI output formats observed in A + B into robust parsing, and make capture coverage honest.

### Task C1: Per-CLI token-parsing patterns

**Files:** `skills/ultraswarm/SKILL.md`, `docs/notes/cli-verification.md`

- [ ] From the captured outputs (codex, grok, agy from prior runs; gemini, opencode from Phase B; droid from its help/JSON), write a concrete per-CLI parsing table into the wrapper prompt (`implPrompt` step 6) and mirror it in `cli-verification.md` as a "Token reporting" line per CLI. For each CLI: the exact string/JSON path to read, or "does not report → cli_tokens 0".
- [ ] Keep it best-effort and non-fatal (unparseable → 0), as today.

### Task C2: Honest capture coverage in the report

**Files:** `skills/ultraswarm/SKILL.md`

- [ ] Extend the accumulator to also count attempts where tokens were captured vs missing: add `let tokenAttempts = 0, tokenCaptured = 0` and increment in `implement()` (captured when `cli_tokens > 0`).
- [ ] Return `token_coverage: { captured: tokenCaptured, total: tokenAttempts }` alongside `external_tokens`.
- [ ] Update Phase 4 report block to render coverage, e.g. `External CLIs — coding: ~140k tokens (captured 4/6 attempts; rest unreported)`. This replaces the vaguer "may be higher" hand-wave with a concrete fraction.
- [ ] Re-run the JS parse check.

### Task C3: Failure-handling edge cases surfaced by real runs

**Files:** `skills/ultraswarm/SKILL.md` (only if A/B exposed something)

- [ ] Address any retry/reassign/tombstone or merge edge case observed in Phases A–B that isn't already handled (e.g. a CLI that exits 0 but writes nothing — like grok without `--always-approve` — should be caught by the gate/artifact check, not counted "ok"). Add a guard or note as needed.
- [ ] If nothing surfaced, record "no new failure-path defects observed in v0.4 runs" in the run notes — don't invent changes.
- [ ] Commit: `feat: robust per-CLI token parsing + capture-coverage reporting; <failure-path fixes or none>`

**Acceptance for Phase C:** token parsing is documented per CLI, the report shows a captured/total fraction, and the JS template still parses.

---

## Phase E — Docs, version bump, release

### Task E1: Reconcile docs

**Files:** `README.md`, `docs/specs/2026-06-07-ultraswarm-design.md`, `docs/notes/cli-verification.md`

- [ ] README "Limitations & status": remove "high-risk path not yet exercised" (now validated); move gemini/opencode to verified end-to-end; note token capture-coverage.
- [ ] Spec: add a v0.4 amendment line (high-risk path validated; all non-subscription CLIs E2E-verified; token coverage reporting).
- [ ] Verification doc summary table reflects gemini/opencode = end-to-end.
- [ ] Run `bash scripts/validate.sh` (must pass).
- [ ] Commit: `docs: reconcile status after v0.4 validation`

### Task E2: Version bump

**Files:** `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`

- [ ] Bump all three version fields `0.3.0` → `0.4.0`; `scripts/validate.sh` confirms they agree.
- [ ] Commit: `chore: bump plugin version to 0.4.0`

### Task E3: Tag + release

- [ ] Fill the `v0.4` section of `CHANGELOG.md` (Task D1 placeholder) with the real changes; commit.
- [ ] `gh release create v0.4 --target main --title "ultraswarm v0.4"` with notes covering: high-risk path validated (with the run's headline numbers), gemini+opencode verified E2E, token capture-coverage, CI + CHANGELOG, manifest-conflict guard.
- [ ] Verify: `git rev-parse v0.4 == HEAD`; tagged tree contains `.github/workflows/validate.yml`, `CHANGELOG.md`, `scripts/validate.sh`.
- [ ] Tell the user to `/plugin marketplace update ultraswarm` + `/reload-plugins`.

**Acceptance for Phase E:** v0.4 is Latest, manifests at 0.4.0, CI green, and the README no longer lists the high-risk path or gemini/opencode as unverified.

---

## Execution order & dependencies

```
D1 CHANGELOG ─┐
D2 validate.sh ┼─→ D3 CI (green on main)         [land first: guards everything after]
              ┘
A1 design → A2 run → A3 fix/iterate (clean run)  [highest-value, may surface real bugs]
B1 gemini ─┐
B2 opencode┴─→ (capture token formats)           [feeds C1]
A2/A3 + B1/B2 outputs ─→ C1 parsing → C2 coverage → C3 edge cases
all of the above ─→ E1 docs → E2 bump → E3 release
```

- **D before everything** so CI catches regressions in A–E commits.
- **A and B can run in parallel** (independent scratch repos) but both must finish before **C1** (which needs their observed token formats).
- **C** before **E** (report changes are part of the release).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| High-risk path has a real control-flow bug (likely — never run) | That's the point; Task A3 fixes in `SKILL.md`, re-runs until clean. Budget 2–3 iterations. |
| A high-risk run is expensive/slow (2 CLIs + judge + 3 lenses + retries) | Single small task; codex 15-min timeout; one clean pass is enough. |
| opencode model `xai/grok-build-0.1` drifted again | Task B2 re-checks `opencode models` first; update registry if needed. |
| A CLI reports tokens in an unanticipated format | Parsing stays best-effort (→0); C2 coverage fraction makes missing capture visible, not silently zero. |
| CI flaky on Node version for the JS parse | Pin `setup-node` to 20; the parse-wrap is plain `new Function`, no deps. |

## Out of scope (explicitly deferred)

- Cumulative cross-run token stats / persisted history (was declined for v0.3; revisit v0.5 if wanted).
- Remote/CI *execution* of the swarm (still local-only).
- Automated tests of the Workflow template beyond parse-validation (no JS test harness for an LLM-orchestration script yet).
- New worker CLIs beyond the current six.
