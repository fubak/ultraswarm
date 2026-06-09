# High-risk competition path — live validation (2026-06-08)

First end-to-end run of the `risk: "high"` path (competition → judge panel → 3-lens adversarial verify), which had been review-verified but never exercised live. **Result: the path works as designed; no control-flow defects found.**

## Setup

- Scratch repo `/tmp/ultraswarm-hr` (Node ESM, gate `npm test`), gate green on base.
- One high-risk task `t1`: a **signed-token verifier** (`signToken`/`verifyToken`, HMAC-SHA256, base64url, `crypto.timingSafeEqual`, expiry, structured `{valid, reason}` failures, TypeError on malformed input). Chosen because it is auth + security-sensitive (triggers the `high` rubric) and gives all three lenses real material.
- Competition pair: **codex** (primary) vs **grok** (alternate). `timeouts.codex = 900000`.
- Workflow authored from the current dev-repo `SKILL.md` template (`/tmp/hr-wf.js`).

## What fired (verified)

7 agents total = **2 competition impls + 2 judges + 3 verify lenses** — exactly the high-risk design with no retries (winner passed on attempt 1):

| Stage | Observed |
|---|---|
| Competition | Both worktrees created and committed an attempt — codex `787a6b7`, grok `2bd8d75` (real 2-CLI competition, not a degenerate single-impl) |
| Judge panel | One judge per ok impl (2); grok selected as winner; runner-up's `graft_ideas` collected (7) |
| 3-lens verify | correctness / security / regression all ran on the winner; 2-of-3 majority → approved |
| Return shape | `{task:t1, cli:'grok', impl:{worktree,branch,...}, attempts:1, graft:[...]}` — carries worktree/branch/cli + graft as required |
| Merge (Phase 3) | grok's branch squash-merged to main; gate green; committed `(ultraswarm: grok)` |
| Final verify | 6/6 tests on merged main; both competition worktrees + branches swept |

## Winner quality (spot-checked)

grok's `src/token.js`: `import { createHmac, timingSafeEqual } from 'node:crypto'`; `exp` appended **after** spreading the payload (`{...payload, exp}`) so a caller-supplied `exp` can't override the computed expiry; length-guard before `timingSafeEqual` (avoids the throw-on-unequal-length pitfall); thorough TypeError validation; 6/6 tests including tampered-body, wrong-secret, expired, and malformed cases. Genuinely sound security code — the security lens had real substance to check and the winner survived it.

## Token capture

`external_tokens: 21428` — captured from codex (which prints "tokens used"); grok reported `cli_tokens: 0` (does not emit a parseable usage line). This confirms the v0.3 best-effort capture works and is **partial** per CLI — motivating the v0.4 Phase C capture-coverage fraction (e.g. "captured 1/2 attempts").

## Defects found

**None in the control flow.** The high-risk branch (competition dispatch, cli tagging, judge selection, graft collection, 3-lens majority, winner-retry numbering, return shape) all behaved as written on the first live run. Task A3 ("fix defects") had nothing to fix.

Observation (not a defect): grok emits unrelated MCP transport/auth ERROR lines at startup (already documented in `cli-verification.md`); they did not affect the run, consistent with the "verify via artifacts, never log-grep" rule.
