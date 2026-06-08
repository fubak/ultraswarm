# CLI Verification Registry

Date: 2026-06-07
Purpose: source of truth for the `/ultraswarm` worker registry. Each entry records the exact verified one-shot invocation (prompt passed via `"$(cat .ultraswarm-prompt.txt)"`), smoke-test result, and quirks.

## Summary

| CLI | Version | Status | Smoke test |
|-----|---------|--------|------------|
| codex | codex-cli 0.137.0 | enabled | not run (help-verified per task spec) |
| gemini | 0.45.2 | enabled | not run (help-verified per task spec) |
| grok | 0.2.33 (c0ddec061) | enabled | PASS |
| agy | 1.0.6 | enabled | PASS |
| droid | 0.142.0 | **disabled** | FAIL — not authenticated |
| opencode | 1.16.2 | enabled | PASS (model corrected, see entry) |

## codex (enabled)

- Version: `codex-cli 0.137.0`
- Invocation: `codex exec --full-auto "$(cat .ultraswarm-prompt.txt)"`
- Smoke test: not run (flags known-good per task spec; help-output confirmation only).
- Quirks:
  - `--full-auto` is **hidden from `codex exec --help`** in 0.137.0 but still accepted (verified: `codex exec --full-auto --help` exits 0; an unknown flag would error). If it is removed in a future version, the explicit equivalent is `codex exec --sandbox workspace-write "$(cat .ultraswarm-prompt.txt)"` (sandbox modes: `read-only`, `workspace-write`, `danger-full-access`; `exec` is non-interactive so no approval prompts).
  - Prompt is a positional arg; `-` or piped stdin also works.
  - `--skip-git-repo-check` available if running outside a git repo.
  - `-o, --output-last-message <FILE>` writes only the final message to a file — useful for parsing results.

## gemini (enabled)

- Version: `0.45.2`
- Invocation: `gemini --yolo -p "$(cat .ultraswarm-prompt.txt)"`
- Smoke test: not run (flags known-good per task spec; help-output confirmation only).
- Quirks:
  - `-p/--prompt` is required for non-interactive (headless) mode; a bare positional query starts interactive mode and will hang.
  - `-y/--yolo` auto-approves all actions; `--approval-mode yolo` is the equivalent long form (`auto_edit` available if only file edits should be auto-approved).

## grok (enabled)

- Version: `grok 0.2.33 (c0ddec061) [stable]`
- Invocation: `grok --always-approve -p "$(cat .ultraswarm-prompt.txt)"`
- Smoke test: **PASS** — created `hello-grok.txt` with exact content, unattended.
- Quirks:
  - `-p/--single <PROMPT>` is the headless one-shot form (prints response to stdout and exits). `--prompt-file <PATH>` accepts a file directly, so `grok --always-approve --prompt-file .ultraswarm-prompt.txt` is an equivalent that avoids shell quoting entirely.
  - `--always-approve` is the named auto-approve flag.
  - **Noisy**: interleaves many `ERROR worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)` log lines into output even on successful runs (background leader/telemetry workers). Do not treat ERROR lines in output as task failure — verify via artifacts (files/commits), not log grep.
  - Honors `--cwd <CWD>` if running from a different directory.

## agy (enabled)

- Version: `1.0.6`
- Invocation: `agy -p "$(cat .ultraswarm-prompt.txt)"`
- Smoke test: **PASS** — created `hello-agy.txt` with exact content, unattended, with **no permission flag at all** (plain `-p`/`--print` performed file writes without prompting).
- Quirks:
  - `-p/--print` runs a single prompt non-interactively. Default `--print-timeout` is 5m; raise it for long tasks (e.g. `--print-timeout 15m`).
  - `--dangerously-skip-permissions` is agy's named auto-approve flag, but it was NOT verified here (this environment's policy forbids `--dangerously-*` flags) and was not needed for file writes. If a worker run stalls on a permission request in print mode, that flag is the documented escape hatch — decide policy at integration time.
  - No `--cwd` flag; must `cd` into the work directory first.

## droid (DISABLED)

- Version: `0.142.0`
- Status: **disabled — not authenticated.** `droid exec --auto low "<prompt>"` exits 1 with: `Error during droid execution: Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.` Per task policy, no authentication was attempted. Excluded from routing.
- Would-be invocation once authenticated (from help output, unverified end-to-end):
  - `droid exec --auto low "$(cat .ultraswarm-prompt.txt)"` — lowest autonomy level that allows file creation/modification without confirmation.
  - `--auto medium` additionally allows local git operations (commit/checkout/pull), package installs, and builds — likely the right level for ultraswarm workers that commit in worktrees. `--auto high` adds git push.
  - `-f, --file <path>` reads the prompt from a file (alternative to positional).
  - Default model: `claude-opus-4-8`; `--cwd <path>` and `-w/--worktree` supported.
- Re-verify (including a real smoke test) before enabling.

## opencode (enabled)

- Version: `1.16.2`
- Invocation: `opencode run --agent build -m "xai/grok-build-0.1" "$(cat .ultraswarm-prompt.txt)"`
- Smoke test: **PASS** — created `hello-opencode.txt` with exact content, unattended.
- Quirks:
  - **Model correction**: the previously known-good model `opencode/grok-code` no longer exists. Using it fails (exit 1) with an unhelpful `UnknownError: Unexpected server error` — twice reproduced. `opencode models` lists current options; the configured xAI credential offers `xai/grok-build-0.1` (purpose-built coding model, verified working), `xai/grok-4.3`, etc. Re-check `opencode models` if runs start failing with UnknownError.
  - `--agent build` selects the file-editing agent; prompt is positional.
  - Tool activity (Write/Read steps) is streamed to stdout; ANSI escape codes present in output.
  - No `--cwd`; use `--dir <directory>` or `cd` first.

## Cross-cutting notes for the registry

- All pass/fail verdicts above were verified by inspecting the artifact files the CLIs created (exact content match), not by exit codes. Exit codes were not independently characterized for grok/agy success paths — orchestrator should verify worker output via artifacts (files, commits) rather than trusting exit codes.
- Smoke tests ran in a fresh `git init` directory (`/tmp/cli-smoke`, since removed); none of the four tested CLIs required interactive input or hung.
- Each tested CLI completed the trivial task in well under 180 s.
