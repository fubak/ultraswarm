# Pi Worker + Local/Private Model Support — Design Spec

**Date:** 2026-06-13
**Status:** Approved (design) — implementation to follow
**Extends:** `docs/specs/2026-06-07-ultraswarm-design.md`, `docs/specs/2026-06-12-portable-host-runner-design.md`
**Schema/contract impact:** None. No plan-schema change, no host-contract change, no host-skill regeneration.

## Problem

ultraswarm wants to (1) add support for the **Pi** coding CLI (`pi`, from
`earendil-works/pi`), (2) expand the set of models/providers available to workers, (3)
increase worker-pool diversity for routing, and (4) support **local/private models such as
Ollama**.

### Key insight: Ollama is a model backend, not a worker

ultraswarm workers must **edit files inside an isolated git worktree and run shell
commands**, then have their changes checked against `allowed_paths` (`ShellWorkerAdapter` in
`lib/workers/adapters.mjs`). Plain `ollama run` is a chat REPL — no tool-calling, no file
edits — so **Ollama cannot be a standalone worker**. It needs an *agentic harness* to drive
it.

**Pi is the ideal vehicle for all four goals at once.** It is provider-agnostic (Claude,
GPT, Gemini, Grok, and local models) and has first-class Ollama/LM Studio/vLLM support via a
provider entry in `~/.pi/agent/models.json` (`baseUrl: http://localhost:11434/v1`,
`api: openai-completions`). Adding Pi therefore delivers a new worker (diversity),
provider/model expansion, and the path to local/private models in a single integration.

Pi's headless invocation fits the existing registry pattern exactly:

```
pi -p --provider <name> --model <pattern> "$(cat .ultraswarm-prompt.txt)"
```

`-p` (print mode) has no TTY and shows no trust prompt, so it auto-executes tools — the same
non-interactive, auto-approve behavior ultraswarm already relies on for `codex exec`,
`gemini --yolo`, and `grok --always-approve`.

## Approved Decisions

| Decision | Choice |
|---|---|
| Primary CLI to add | **Pi only.** Defer aider/aichat/others to a later release (YAGNI). |
| Pi default tiers | **Anthropic Claude spread** — Haiku → Sonnet → Opus → Opus + `--thinking high`. Works for anyone with an Anthropic key; does not require multiple providers. |
| Local/private support | **Dedicated always-on local tier.** A distinct `pi-local` worker, permanently in `DEFAULT_REGISTRY`, routed through Pi to Ollama. |
| Docs/tests | README, all docs, and tests updated as part of this work. |

## Design

### Two workers, one binary

A "dedicated always-on local tier" that is also a real routable worker means **two registry
entries backed by the same `pi` binary**:

| Worker | Binary | Provider | Tiers (model) | Pool role |
|---|---|---|---|---|
| `pi` | `pi` | `anthropic` | simple→`claude-haiku-4-5`, moderate→`claude-sonnet-4-6`, complex→`claude-opus-4-8`, expert→`claude-opus-4-8` + `--thinking high` | Provider-agnostic flexible generalist |
| `pi-local` | `pi` | `ollama` | simple→`qwen3-coder:7b`, moderate/complex/expert→`qwen3-coder:30b` | Always-present private/offline worker |

`pi-local` lives in `DEFAULT_REGISTRY` permanently, so `workers`, `doctor`, and
`explain-routing` always surface it as a distinct routing option. The Ollama model IDs are
overridable defaults like every other worker (see `ultraswarm.config.advanced.json`).

### The one structural change it forces

Today `ShellWorkerAdapter.probe()` runs `execFileSync(this.name, ['--version'])` — it assumes
**registry key === binary name**. That assumption breaks for `pi-local` (`pi-local --version`
does not exist).

**Change:** add an optional `binary` field to registry entries. `ShellWorkerAdapter` resolves
the probe binary as `DEFAULT_REGISTRY[name]?.binary ?? name`. Both `pi` and `pi-local` set
`binary: 'pi'`.

This is the **only** change to adapter logic:

- `probe()` already is the sole place a registry key is used as an executable.
- `execute()` uses the full invocation string (`route.command`), which is unaffected.
- `validateModel()` / `resolveRoute()` key on the registry name, which is `pi-local` — a real
  registry entry — so they already work.
- `WorkerManager` builds adapters from `Object.keys(DEFAULT_REGISTRY)`, so `pi-local` gets an
  adapter automatically.

Probe semantics for `pi-local`: a healthy `pi` binary makes `pi-local` probe healthy even if
Ollama is not running. This matches existing worker behavior (all workers probe `--version`,
not live auth/backend). If Ollama is down, the task fails at execution time and is
reported/retried like any other worker failure. The README documents the Ollama setup
prerequisite.

### Invocations

```
# pi  (anthropic spread)
simple   : pi -p --provider anthropic --model claude-haiku-4-5  "$(cat .ultraswarm-prompt.txt)"
moderate : pi -p --provider anthropic --model claude-sonnet-4-6 "$(cat .ultraswarm-prompt.txt)"
complex  : pi -p --provider anthropic --model claude-opus-4-8   "$(cat .ultraswarm-prompt.txt)"
expert   : pi -p --provider anthropic --model claude-opus-4-8 --thinking high "$(cat .ultraswarm-prompt.txt)"

# pi-local  (ollama)
simple   : pi -p --provider ollama --model qwen3-coder:7b  "$(cat .ultraswarm-prompt.txt)"
moderate : pi -p --provider ollama --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"
complex  : pi -p --provider ollama --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"
expert   : pi -p --provider ollama --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"
```

Every invocation includes `.ultraswarm-prompt.txt`, satisfying the config validator's
`validateInvocation` rule.

### Capabilities (`CAPABILITIES` in `lib/workers/adapters.mjs`)

```
pi:       { languages: ['*'], strengths: ['general', 'full-stack', 'refactors'],   structuredOutput: false, resume: false }
pi-local: { languages: ['*'], strengths: ['general', 'boilerplate', 'docs', 'tests'], structuredOutput: false, resume: false }
```

- `pi` is positioned as a strong flexible generalist.
- `pi-local` is positioned toward lower-stakes/private work, since local models are weaker
  than frontier cloud models. (Routing matches `strengths` against the task class; this skews
  `pi-local` toward simpler classes by default without hard-coding any cloud-vs-local rule.)
- `resume: false` for both — each ultraswarm task runs single-shot in a fresh worktree, so
  Pi's session-resume feature is not used.

### Setup dependency (documented, not hidden)

`pi-local` requires the user to: (1) run Ollama, (2) register an `ollama` provider and the
referenced models in `~/.pi/agent/models.json`, and (3) `ollama pull` the models. README adds
a "Local / private models (Ollama)" section covering this. `doctor` probes the `pi` binary;
the README notes that a green `pi-local` probe means "pi is installed," not "Ollama is ready."

## Scope / Blast Radius

In scope (and to be updated):

- `scripts/router.mjs` — add `pi` and `pi-local` to `DEFAULT_REGISTRY` (with `binary`).
- `lib/workers/adapters.mjs` — add `pi`/`pi-local` to `CAPABILITIES`; resolve probe binary
  via `DEFAULT_REGISTRY[name]?.binary ?? name`.
- Tests — `scripts/router.test.mjs` (routing/registry for both workers, tier resolution,
  config-override merge), `lib/workers/adapters.test.mjs` (binary-resolved probe for
  `pi-local`, capabilities), plus any registry-count assertions elsewhere.
- `README.md` — add `pi`/`pi-local` to the worker list and a "Local / private models
  (Ollama)" section.
- `ultraswarm.config.example.json` and `ultraswarm.config.advanced.json` — include `pi` and
  `pi-local` in `enabled` and document override shape (incl. Ollama model IDs + verification
  note).
- `CHANGELOG.md` — new entry.

Explicitly **out of scope** (unchanged):

- `lib/plan-schema.mjs`, `lib/routing.mjs` — derive from `DEFAULT_REGISTRY`; no edits needed.
- `hosts/host-contract.json` and generated host skills — worker-agnostic; **SHA provenance
  lock stays intact**.
- aider / aichat / any other CLI.

## Verification / Success Criteria

1. `node --test` passes, including new `pi`/`pi-local` coverage.
2. `bash scripts/validate.sh` passes.
3. `node scripts/generate-host-skills.mjs --check` passes (host skills unchanged → lock
   intact).
4. `node bin/ultraswarm.mjs workers` lists both `pi` and `pi-local` with capabilities.
5. `node bin/ultraswarm.mjs explain-routing '<task>'` ranks `pi`/`pi-local` without error.
6. `resolveRoute({ cli: 'pi-local', model_tier: 'simple' }, {})` returns the Ollama
   invocation; `resolveRoute({ cli: 'pi', complexity_score: 200 }, {})` returns the expert
   Anthropic invocation with `--thinking high`.
7. A config override for `pi-local` model IDs merges correctly (project over global).
8. README and both config examples reference `pi`/`pi-local`; CHANGELOG documents the change.
