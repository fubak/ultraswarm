# CLI Verification Registry

Date: 2026-06-07
Purpose: source of truth for the `/ultraswarm` worker registry. Each entry records the exact verified one-shot invocation (prompt passed via `"$(cat .ultraswarm-prompt.txt)"`), smoke-test result, and quirks.

> **Update (2026-06-19): the manual "Phase 0 write probe" is now automated.** The `preflight` command
> (and `run` by default) executes the same verify-by-artifact smoke test in code — `lib/workers/smoke.mjs`
> writes `ULTRASWARM_OK.txt` in an isolated temp dir and checks the file actually appears, exactly the
> rule this note established ("verify worker output via artifacts, not exit codes"). Verdicts are cached
> in `.ultraswarm/functional-probe.json` (24h TTL, keyed by `name@version`); non-functional workers are
> excluded from routing automatically.

> **Update (2026-06-22): token capture is now STRUCTURED, not a scrape.** The free-text token scrape
> (which matched incidental digits and undercounted by orders of magnitude) was removed in v3.5.13 and
> replaced in v3.5.14 by parsing each CLI's structured usage events: codex `exec --json`
> (`turn.completed.usage.{input_tokens,output_tokens}`) and opencode `run --format json`
> (`step_finish.part.tokens.{input,output}`). The run report's "Work offloaded" section now shows real
> per-CLI usage (landed vs spent vs retry/competition overhead). A CLI invoked without its JSON flag, or
> one with no parser yet (gemini/grok/agy/droid/pi), runs fine and the report says "not reported" rather
> than inventing a number. **The 2026-06-08 token observations at the bottom of this file are historical
> (pre-structured-capture) — the "undercount/floor" framing no longer applies to codex/opencode.**

Global precondition: every invocation string below assumes the current working directory is the worker's git worktree, containing `.ultraswarm-prompt.txt`. `cd` there first (or use the per-CLI `--cwd`/`--dir` flag where noted).

## Summary

| CLI | Version | Status | Smoke test |
|-----|---------|--------|------------|
| codex | codex-cli 0.137.0 | enabled | PASS (2026-06-08, corrected flags — see codex entry and "E2E re-verification") |
| gemini | 0.45.2 | enabled | PASS — verified end-to-end 2026-06-08 (formatCurrency task, 8/8, approved attempt 1, merged green) |
| grok | 0.2.33 (c0ddec061) | enabled | PASS |
| agy | 1.0.6 | enabled | PASS |
| droid | 0.142.0 | enabled | help-verified — needs a Factory subscription; not smoke-tested here (no plan on the test machine) |
| opencode | 1.16.2 | enabled | PASS — verified end-to-end 2026-06-08 (clamp task, 8/8, approved attempt 1; model xai/grok-build-0.1 still valid) |

## codex (enabled — re-verified 2026-06-08 with corrected flags)

- Vendor: **OpenAI Codex CLI** — https://github.com/openai/codex.
- Version: `codex-cli 0.137.0`
- Invocation: `codex exec -s workspace-write --skip-git-repo-check "$(cat .ultraswarm-prompt.txt)" </dev/null`
- Smoke test: **PASS (2026-06-08)** — created exact-content file in a linked worktree, and ran the backend math task through the full ultraswarm pipeline (4/4 tests, approved attempt 1, merged green). The earlier `--full-auto` form failed (bwrap rejected worktree writes) and bare `exec` hung on stdin; both are fixed by the invocation above. **Slow (~5 min/task)** — use a 15-min wrapper timeout.
- Quirks:
  - `--full-auto` is **hidden from `codex exec --help`** in 0.137.0 but still accepted (`codex exec --full-auto --help` exits 0 — strong evidence the flag parses, since clap normally rejects unknown flags, but flag acceptance was not exercised in a real run here). If it is removed in a future version, the explicit equivalent is `codex exec --sandbox workspace-write "$(cat .ultraswarm-prompt.txt)"` (sandbox modes: `read-only`, `workspace-write`, `danger-full-access`; `exec` is non-interactive so no approval prompts).
  - Prompt is a positional arg; `-` or piped stdin also works.
  - `--skip-git-repo-check` available if running outside a git repo.
  - `-o, --output-last-message <FILE>` writes only the final message to a file — useful for parsing results.

## gemini (enabled)

- Vendor: **Google Gemini CLI** — https://github.com/google-gemini/gemini-cli.
- Version: `0.45.2`
- Invocation: `gemini --yolo -p "$(cat .ultraswarm-prompt.txt)"`
- Smoke test: not run (flags known-good; docs/plans/2026-06-07-ultraswarm.md Task 1 says help-output confirmation suffices for codex and gemini).
- Quirks:
  - `-p/--prompt` is required for non-interactive (headless) mode. Per the help text ("Defaults to interactive mode. Use -p/--prompt for non-interactive"), a bare positional query starts interactive mode — expected to hang an unattended worker, though this was not exercised here. Always include `-p`.
  - `-y/--yolo` auto-approves all actions; `--approval-mode yolo` is the equivalent long form (`auto_edit` available if only file edits should be auto-approved).

## grok (enabled)

- Vendor: **xAI Grok CLI** — https://x.ai/cli (standalone binary; auth via `grok login`, OAuth through auth.x.ai). Not the npm `superagent-ai/grok-cli`.
- Version: `grok 0.2.33 (c0ddec061) [stable]`
- Invocation: `grok --always-approve -p "$(cat .ultraswarm-prompt.txt)"`
- Smoke test: **PASS** — created `hello-grok.txt` with exact content, unattended.
- Quirks:
  - `-p/--single <PROMPT>` is the headless one-shot form (prints response to stdout and exits). `--prompt-file <PATH>` accepts a file directly, so `grok --always-approve --prompt-file .ultraswarm-prompt.txt` is an equivalent that avoids shell quoting entirely.
  - `--always-approve` is the named auto-approve flag, and it is **REQUIRED** for unattended file writes. Verified 2026-06-08: bare `grok -p "<prompt>"` (no `--always-approve`) prints "Creating `probe.txt`…" but writes **no file** — in headless mode the file-write tool isn't approved, so grok narrates the edit without performing it. With `--always-approve -p` the same prompt writes the file (exit 0). Do not drop `--always-approve`.
  - **Noisy**: interleaves many `ERROR worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)` log lines into output even on successful runs (background leader/telemetry workers). Do not treat ERROR lines in output as task failure — verify via artifacts (files/commits), not log grep.
  - Honors `--cwd <CWD>` if running from a different directory.

## agy (enabled)

- Vendor: **Google Antigravity CLI** — https://antigravity.google (binary self-identifies as `antigravity-cli`; `agy` is the command).
- Version: `1.0.6`
- Invocation: `agy --print-timeout 15m --prompt "$(cat .ultraswarm-prompt.txt)"`
- Smoke test: **PASS** — created `hello-agy.txt` with exact content, unattended, with **no permission flag at all** (plain `-p`/`--print` performed file writes without prompting).
- Quirks:
  - `--prompt`, `-p`, and `--print` are **the same flag** (per `agy --help`: `--prompt` is "Alias for --print"; `-p` is "Short alias for --print"). The canonical invocation uses `--prompt`; re-verified 2026-06-08 (`agy --print-timeout 15m --prompt "<prompt>"` wrote the file unattended, exit 0).
  - Default `--print-timeout` is **5m — below the 10-min worker budget**, which is why the canonical invocation bakes in `--print-timeout 15m`. Do not drop it when copying.
  - `--dangerously-skip-permissions` is agy's named auto-approve flag, but it was NOT verified here (this environment's policy forbids `--dangerously-*` flags) and was not needed for file writes. If a worker run stalls on a permission request in print mode, that flag is the documented escape hatch — decide policy at integration time.
  - No `--cwd` flag; must `cd` into the work directory first.

## droid (enabled — help-verified, needs a Factory subscription)

- Vendor: **Factory CLI (droid)** — https://factory.ai/product/cli.
- Version: `0.142.0`
- Invocation: `droid exec "$(cat .ultraswarm-prompt.txt)"`
- Status: **enabled.** Per Factory's help docs, `droid exec "<prompt>"` is the non-interactive form. **Requires an active Factory subscription** to run; not smoke-tested in this environment because the test machine had no plan (see the re-probe note below). On a subscribed machine, Phase 0's write probe confirms it before routing.
- Would-be invocation once authenticated (from help output, unverified end-to-end):
  - `droid exec --auto low "$(cat .ultraswarm-prompt.txt)"` — lowest autonomy level that allows file creation/modification without confirmation.
  - `--auto medium` additionally allows local git operations (commit/checkout/pull), package installs, and builds — likely the right level for ultraswarm workers that commit in worktrees. `--auto high` adds git push.
  - `-f, --file <path>` reads the prompt from a file (alternative to positional).
  - Default model: `claude-opus-4-8`; `--cwd <path>` and `-w/--worktree` supported.
- Re-verify (including a real smoke test) before enabling.

## opencode (enabled)

- Vendor: **opencode** — https://opencode.ai/docs/#install.
- Version: `1.16.2`
- Invocation: `opencode run --agent build -m "xai/grok-build-0.1" "$(cat .ultraswarm-prompt.txt)"`
- Smoke test: **PASS** — created `hello-opencode.txt` with exact content, unattended.
- Quirks:
  - **Model correction**: the previously known-good model `opencode/grok-code` no longer exists. Using it fails (exit 1) with an unhelpful `UnknownError: Unexpected server error` — twice reproduced. `opencode models` lists current options; the configured xAI credential offers `xai/grok-build-0.1` (purpose-built coding model, verified working), `xai/grok-4.3`, etc. Re-check `opencode models` if runs start failing with UnknownError.
  - `--agent build` selects the file-editing agent; prompt is positional.
  - Tool activity (Write/Read steps) is streamed to stdout; ANSI escape codes present in output.
  - No `--cwd`; use `--dir <directory>` or `cd` first.

## Cross-cutting notes for the registry

- **The plan's Task 2 template rows for gemini and opencode are stale — replace them with the invocations in this file as well (gemini needs `-p`; opencode model is `xai/grok-build-0.1`).** Task 2 of `docs/plans/2026-06-07-ultraswarm.md` instructs substituting only the grok and agy rows from this file, but its hardcoded template has `gemini --yolo "$(cat .ultraswarm-prompt.txt)"` (missing `-p`, so it would start interactive mode) and `opencode run --agent build -m "opencode/grok-code" ...` (model no longer exists; fails with UnknownError).
- **Alternates map (all six enabled).** Recommended: `{ codex:'droid', gemini:'grok', grok:'agy', agy:'grok', droid:'codex', opencode:'agy' }`. Phase 0 drops any CLI that fails the health check or write probe (e.g. droid on a machine with no Factory plan), and re-routes its alternates accordingly.
- All pass/fail verdicts above were verified by inspecting the artifact files the CLIs created (exact content match), not by exit codes. Exit codes were not independently characterized for grok/agy success paths — orchestrator should verify worker output via artifacts (files, commits) rather than trusting exit codes.
- Smoke tests ran in a fresh `git init` directory (`/tmp/cli-smoke`, since removed); none of the four tested CLIs required interactive input or hung.
- Each tested CLI completed the trivial task in well under 180 s.

## E2E smoke-test findings (2026-06-07, ultraswarm-e2e run)

- **codex 0.137.0 — initially FAILED, now PASSES with corrected flags (re-verified 2026-06-08).** With `codex exec --full-auto` it failed every write in a linked worktree ("the workspace sandbox rejected all writes due to a `bwrap` permission failure"), and bare `codex exec` hung. **Fix:** `codex exec -s workspace-write --skip-git-repo-check "$(cat .ultraswarm-prompt.txt)" </dev/null` — `-s workspace-write` allows worktree writes (and falls back to non-sandboxed exec if bwrap can't initialize), and closing stdin (`</dev/null`) stops codex from blocking on it. Verified end-to-end in the pipeline: codex (gpt-5.5) implemented the math task + tests in a worktree, 4/4 green, merged clean. **Caveat: codex is slow (~5 min/task)** — use a 15-min wrapper timeout.
- **agy 1.0.6 — PASSED a write probe inside a linked worktree** (created exact-content file via `-p`). Worktree routing verified, not just plain-repo.
- **grok 0.2.33 — verified end-to-end in worktrees**: created correct implementation + tests on attempt 1 of the first e2e run (rejected only because the project's gate command was broken, not its code).
- **Environment quirk (not a CLI quirk): Node 26 `node --test test/` does NOT do directory discovery** — it resolves `test/` as a module and crashes MODULE_NOT_FOUND. Use bare `node --test`. A broken gate like this poisons every wrapper/QA cycle; SKILL.md Phase 0 now requires verifying gates green on the base tree before any Workflow launch.
- **Workflow `args` may arrive as a JSON string** depending on the caller — the SKILL.md template now validates at the boundary (`const cfg = typeof args === 'string' ? JSON.parse(args) : args`).

## E2E re-verification (2026-06-08)

- **codex — NOW VERIFIED end-to-end.** Invocation: `codex exec -s workspace-write --skip-git-repo-check "$(cat .ultraswarm-prompt.txt)" </dev/null`. Ran the backend math task through the full pipeline (worktree → code → gates → review → merge): 4/4 tests, approved attempt 1, merged green. Slow (~5 min/task); registry timeout raised to 15 min. Status: **enabled**.
- **droid — enabled with `droid exec "<prompt>"` (help-verified, not smoke-tested here).** Login works (model Claude Opus 4.8 reachable via `droid --list-tools`), but on the test machine `droid exec` returned `{is_error:true, num_turns:0, output_tokens:0, result:"Exec failed"}` in <1 s — never reaching a model turn. This is consistent with **no active Factory subscription** (droid exec needs a paid plan to run a model), not a CLI defect. The correct invocation per Factory's help docs is `droid exec "$(cat .ultraswarm-prompt.txt)"`; on a subscribed machine Phase 0's write probe verifies it live before routing.
- Second routine-tier pipeline run (codex + grok) was clean: both approved attempt 1, sequential squash-merge gated green after each, final 10/10 on main, worktrees swept.

## v0.4 e2e (2026-06-08)

- **High-risk competition path — VALIDATED live (first time).** A signed-token verifier (auth/security) ran codex vs grok through competition → judge panel → 3-lens adversarial verify → merge. 7 agents (2 impls + 2 judges + 3 lenses); grok won; passed 3-lens at attempt 1; merged green. No control-flow defects. Full write-up: `docs/notes/highrisk-e2e-2026-06-08.md`.
- **gemini — VERIFIED end-to-end** (formatCurrency, 8/8, approved attempt 1, merged green).
- **opencode — VERIFIED end-to-end** (clamp, 8/8, approved attempt 1; model `xai/grok-build-0.1` re-confirmed present via `opencode models`).
- **Token reporting (observed, for the best-effort token metric):** only **codex** emits a parseable count (a `tokens used` line; ~21k on the high-risk task), and **droid** reports a `usage` JSON object in `-o json` mode (unverified — unsubscribed). **grok, gemini, opencode, agy report no parseable token usage** in default output → `cli_tokens` 0 for them. The report therefore shows a capture-coverage fraction (`captured/total`) and treats `external_tokens` as an undercount, not a precise figure.
