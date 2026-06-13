# Pi Worker + Local/Private Model Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new ultraswarm workers backed by the `pi` CLI — `pi` (provider-agnostic, Anthropic Claude spread) and `pi-local` (always-on local/private worker via Ollama) — with README, all docs, config examples, and tests updated.

**Architecture:** ultraswarm's worker roster is a single source of truth: `DEFAULT_REGISTRY` in `scripts/router.mjs` (invocations, tiers, timeouts, specialty) plus `CAPABILITIES` in `lib/workers/adapters.mjs` (routing strengths). `plan-schema`, `routing`, and the decomposition `ROSTER` all derive from the registry, so adding entries there propagates automatically. The only structural change: `ShellWorkerAdapter.probe()` currently assumes registry-key === binary name; we add an optional `binary` field so `pi-local` probes the real `pi` executable.

**Tech Stack:** Node 22+ (ESM, `node:test`, `node:assert/strict`), `node:child_process` `execFileSync`. No new dependencies.

**Reference spec:** `docs/specs/2026-06-13-pi-worker-and-local-models-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/router.mjs` | Worker registry (invocations, tiers, specialty, timeout, `binary`) | Add `pi` + `pi-local` entries |
| `scripts/router.test.mjs` | Registry/routing tests | Update allowed-CLI assertion; add `pi`/`pi-local` routing tests |
| `lib/workers/adapters.mjs` | Worker capabilities + probe | Add `pi`/`pi-local` to `CAPABILITIES`; resolve probe binary via `binary` field |
| `lib/workers/adapters.test.mjs` | Adapter tests | Add binary-resolution + capabilities tests |
| `ultraswarm.config.example.json` | Minimal example config | Add `pi`/`pi-local` to `enabled` |
| `ultraswarm.config.advanced.json` | Full override example | Add `pi`/`pi-local` `enabled` + override blocks + notes |
| `README.md` | User docs | Add workers to roster; add "Local / private models (Ollama)" section |
| `CHANGELOG.md` | Release notes | New `[Unreleased]` entry |

**No changes** to `lib/plan-schema.mjs`, `lib/routing.mjs`, `lib/orchestrator/decompose.mjs` (derive from registry), `hosts/*` or generated skills (worker-agnostic; SHA lock stays intact).

---

## Task 1: Register the `pi` worker (Anthropic Claude spread)

**Files:**
- Modify: `scripts/router.mjs` (append to `DEFAULT_REGISTRY`, after the `opencode` entry, before the closing `})`)
- Modify: `lib/workers/adapters.mjs:6-13` (`CAPABILITIES`)
- Modify: `scripts/router.test.mjs:203` (allowed-CLI assertion) and add new routing test
- Test: `scripts/router.test.mjs`

- [ ] **Step 1: Write the failing routing test**

Add inside the `describe('resolveRoute', ...)` block in `scripts/router.test.mjs` (e.g. after the existing `timeoutMs` test, before the block's closing `});`):

```javascript
    it('pi routes the Anthropic spread by tier; expert adds --thinking high', () => {
      assert.match(
        resolveRoute({ cli: 'pi', model_tier: 'simple' }).command,
        /^pi -p --provider anthropic --model claude-haiku-4-5 "\$\(cat \.ultraswarm-prompt\.txt\)"$/
      );
      assert.match(
        resolveRoute({ cli: 'pi', model_tier: 'moderate' }).command,
        /--model claude-sonnet-4-6/
      );
      const expert = resolveRoute({ cli: 'pi', complexity_score: 200 });
      assert.strictEqual(expert.tier, 'expert');
      assert.match(expert.command, /--model claude-opus-4-8 --thinking high/);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/router.test.mjs`
Expected: FAIL — `resolveRoute({ cli: 'pi', ... })` throws `Unknown cli "pi"` (pi not yet in registry).

- [ ] **Step 3: Add the `pi` entry to `DEFAULT_REGISTRY`**

In `scripts/router.mjs`, inside the `freezeDeep({ ... })` object, immediately after the entire `opencode: { ... }` entry (and its trailing comma), add:

```javascript
  pi: {
    specialty: 'provider-agnostic generalist, full-stack, refactors',
    timeoutMs: 600000,
    binary: 'pi',
    models: {
      simple: {
        model: 'claude-haiku-4-5',
        invocation: 'pi -p --provider anthropic --model claude-haiku-4-5 "$(cat .ultraswarm-prompt.txt)"'
      },
      moderate: {
        model: 'claude-sonnet-4-6',
        invocation: 'pi -p --provider anthropic --model claude-sonnet-4-6 "$(cat .ultraswarm-prompt.txt)"'
      },
      complex: {
        model: 'claude-opus-4-8',
        invocation: 'pi -p --provider anthropic --model claude-opus-4-8 "$(cat .ultraswarm-prompt.txt)"'
      },
      expert: {
        model: 'claude-opus-4-8',
        invocation: 'pi -p --provider anthropic --model claude-opus-4-8 --thinking high "$(cat .ultraswarm-prompt.txt)"'
      }
    }
  },
```

- [ ] **Step 4: Add `pi` to `CAPABILITIES`**

In `lib/workers/adapters.mjs`, inside the `CAPABILITIES` object (currently lines 6-13), after the `opencode:` line and before the closing `}`, add:

```javascript
  pi: { languages: ['*'], strengths: ['general', 'full-stack', 'refactors'], structuredOutput: false, resume: false },
```

- [ ] **Step 5: Update the `unknown cli` allowed-list assertion**

The `Unknown cli` error lists `Object.keys(DEFAULT_REGISTRY)`, which now ends with `pi`. In `scripts/router.test.mjs:203`, change:

```javascript
          assert(err.message.includes('codex, gemini, grok, agy, droid, opencode'));
```

to:

```javascript
          assert(err.message.includes('codex, gemini, grok, agy, droid, opencode, pi'));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/router.test.mjs`
Expected: PASS (new `pi` routing test + updated allowed-list assertion both green).

- [ ] **Step 7: Commit**

```bash
git add scripts/router.mjs scripts/router.test.mjs lib/workers/adapters.mjs
git commit -m "feat(workers): add pi worker with Anthropic Claude tier spread"
```

---

## Task 2: Register the `pi-local` worker (Ollama, always-on local tier)

**Files:**
- Modify: `scripts/router.mjs` (append `pi-local` to `DEFAULT_REGISTRY`, after the `pi` entry)
- Modify: `lib/workers/adapters.mjs` (`CAPABILITIES`)
- Modify: `scripts/router.test.mjs:203` (allowed-CLI assertion) and add a routing test
- Test: `scripts/router.test.mjs`

- [ ] **Step 1: Write the failing routing test**

Add inside the `describe('resolveRoute', ...)` block in `scripts/router.test.mjs`, after the `pi` routing test from Task 1:

```javascript
    it('pi-local routes Ollama models by tier and aliases its binary to pi', () => {
      assert.match(
        resolveRoute({ cli: 'pi-local', model_tier: 'simple' }).command,
        /^pi -p --provider ollama --model qwen3-coder:7b "\$\(cat \.ultraswarm-prompt\.txt\)"$/
      );
      assert.match(
        resolveRoute({ cli: 'pi-local', model_tier: 'complex' }).command,
        /--provider ollama --model qwen3-coder:30b/
      );
      assert.strictEqual(DEFAULT_REGISTRY['pi-local'].binary, 'pi');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/router.test.mjs`
Expected: FAIL — `resolveRoute({ cli: 'pi-local', ... })` throws `Unknown cli "pi-local"`.

- [ ] **Step 3: Add the `pi-local` entry to `DEFAULT_REGISTRY`**

In `scripts/router.mjs`, immediately after the `pi: { ... }` entry added in Task 1, add:

```javascript
  'pi-local': {
    specialty: 'local/private models via Ollama (offline-capable, lower-stakes work)',
    timeoutMs: 900000,
    binary: 'pi',
    models: {
      simple: {
        model: 'qwen3-coder:7b',
        invocation: 'pi -p --provider ollama --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"'
      },
      moderate: {
        model: 'qwen3-coder:30b',
        invocation: 'pi -p --provider ollama --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"'
      },
      complex: {
        model: 'qwen3-coder:30b',
        invocation: 'pi -p --provider ollama --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"'
      },
      expert: {
        model: 'qwen3-coder:30b',
        invocation: 'pi -p --provider ollama --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"'
      }
    }
  },
```

- [ ] **Step 4: Add `pi-local` to `CAPABILITIES`**

In `lib/workers/adapters.mjs`, after the `pi:` line added in Task 1, add:

```javascript
  'pi-local': { languages: ['*'], strengths: ['general', 'boilerplate', 'docs', 'tests'], structuredOutput: false, resume: false },
```

- [ ] **Step 5: Update the `unknown cli` allowed-list assertion**

In `scripts/router.test.mjs:203`, change the assertion (updated in Task 1) to its final value:

```javascript
          assert(err.message.includes('codex, gemini, grok, agy, droid, opencode, pi, pi-local'));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/router.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/router.mjs scripts/router.test.mjs lib/workers/adapters.mjs
git commit -m "feat(workers): add always-on pi-local Ollama worker"
```

---

## Task 3: Resolve the probe executable via the registry `binary` field

`ShellWorkerAdapter.probe()` runs `execFileSync(this.name, ['--version'])`. For `pi-local` that would run a nonexistent `pi-local` binary. Resolve the real executable from the registry's `binary` field, defaulting to the registry key.

**Files:**
- Modify: `lib/workers/adapters.mjs:16` (constructor) and `:17-18` (probe)
- Test: `lib/workers/adapters.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `lib/workers/adapters.test.mjs` (after the existing `parseUsage` test):

```javascript
test('adapter resolves the probe binary from the registry alias (pi-local -> pi)', () => {
  assert.equal(new ShellWorkerAdapter('pi-local', {}, {}).binary, 'pi')
})

test('adapter falls back to the registry key as binary when no alias is set', () => {
  assert.equal(new ShellWorkerAdapter('codex', {}, {}).binary, 'codex')
})

test('pi and pi-local expose distinct routing strengths', () => {
  assert.deepEqual(new ShellWorkerAdapter('pi', {}, {}).capabilities().strengths, ['general', 'full-stack', 'refactors'])
  assert.deepEqual(new ShellWorkerAdapter('pi-local', {}, {}).capabilities().strengths, ['general', 'boilerplate', 'docs', 'tests'])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/workers/adapters.test.mjs`
Expected: FAIL — `adapter.binary` is `undefined` (field not set yet).

- [ ] **Step 3: Set `this.binary` in the constructor**

In `lib/workers/adapters.mjs`, the constructor is currently (line 16):

```javascript
  constructor(name, cfg, supervisor, limit = (fn) => fn()) { this.name = name; this.cfg = cfg; this.supervisor = supervisor; this.limit = limit }
```

Change it to resolve the binary from the registry (`DEFAULT_REGISTRY` is already imported at the top of this file):

```javascript
  constructor(name, cfg, supervisor, limit = (fn) => fn()) { this.name = name; this.binary = DEFAULT_REGISTRY[name]?.binary ?? name; this.cfg = cfg; this.supervisor = supervisor; this.limit = limit }
```

- [ ] **Step 4: Probe the resolved binary**

In the `probe()` method (line 17-18), change `execFileSync(this.name, ...)` to `execFileSync(this.binary, ...)`:

```javascript
  probe() {
    try { return { healthy: true, version: execFileSync(this.binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), capabilities: this.capabilities() } }
    catch (error) { return { healthy: false, error: error.message, capabilities: this.capabilities() } }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test lib/workers/adapters.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `node --test`
Expected: PASS — all existing tests plus the new ones (probe change is backward-compatible: every existing worker's `binary` equals its name).

- [ ] **Step 7: Commit**

```bash
git add lib/workers/adapters.mjs lib/workers/adapters.test.mjs
git commit -m "feat(workers): probe the registry binary alias so pi-local probes pi"
```

---

## Task 4: Update config examples

**Files:**
- Modify: `ultraswarm.config.example.json`
- Modify: `ultraswarm.config.advanced.json`

- [ ] **Step 1: Add the new workers to the minimal example**

Replace the entire contents of `ultraswarm.config.example.json` with:

```json
{
  "enabled": ["codex", "gemini", "grok", "agy", "droid", "opencode", "pi", "pi-local"],
  "overrides": {
    "codex": { "timeoutMs": 900000 },
    "opencode": { "invocation": "opencode run --agent build -m \"xai/grok-4.3\" \"$(cat .ultraswarm-prompt.txt)\"" },
    "pi-local": {
      "models": {
        "simple": { "model": "qwen3-coder:7b", "invocation": "pi -p --provider ollama --model qwen3-coder:7b \"$(cat .ultraswarm-prompt.txt)\"" }
      }
    }
  }
}
```

- [ ] **Step 2: Add the new workers to the advanced example `enabled` list**

In `ultraswarm.config.advanced.json`, change the `enabled` line:

```json
  "enabled": ["codex", "gemini", "grok", "agy", "droid", "opencode"],
```

to:

```json
  "enabled": ["codex", "gemini", "grok", "agy", "droid", "opencode", "pi", "pi-local"],
```

- [ ] **Step 3: Add `pi` and `pi-local` override blocks**

In `ultraswarm.config.advanced.json`, inside the `"overrides": { ... }` object, after the `"droid": { ... }` block (add a comma after droid's closing brace), add:

```json
    "pi": {
      "models": {
        "simple": {
          "model": "claude-haiku-4-5",
          "invocation": "pi -p --provider anthropic --model claude-haiku-4-5 \"$(cat .ultraswarm-prompt.txt)\""
        },
        "moderate": {
          "model": "claude-sonnet-4-6",
          "invocation": "pi -p --provider anthropic --model claude-sonnet-4-6 \"$(cat .ultraswarm-prompt.txt)\""
        },
        "complex": {
          "model": "claude-opus-4-8",
          "invocation": "pi -p --provider anthropic --model claude-opus-4-8 \"$(cat .ultraswarm-prompt.txt)\""
        },
        "expert": {
          "model": "claude-opus-4-8",
          "invocation": "pi -p --provider anthropic --model claude-opus-4-8 --thinking high \"$(cat .ultraswarm-prompt.txt)\""
        }
      }
    },
    "pi-local": {
      "models": {
        "simple": {
          "model": "qwen3-coder:7b",
          "invocation": "pi -p --provider ollama --model qwen3-coder:7b \"$(cat .ultraswarm-prompt.txt)\""
        },
        "moderate": {
          "model": "qwen3-coder:30b",
          "invocation": "pi -p --provider ollama --model qwen3-coder:30b \"$(cat .ultraswarm-prompt.txt)\""
        },
        "complex": {
          "model": "qwen3-coder:30b",
          "invocation": "pi -p --provider ollama --model qwen3-coder:30b \"$(cat .ultraswarm-prompt.txt)\""
        },
        "expert": {
          "model": "qwen3-coder:30b",
          "invocation": "pi -p --provider ollama --model qwen3-coder:30b \"$(cat .ultraswarm-prompt.txt)\""
        }
      }
    }
```

- [ ] **Step 4: Document the Ollama prerequisite in the advanced `notes` array**

In `ultraswarm.config.advanced.json`, add this string as a new element at the end of the `"notes": [ ... ]` array (add a comma after the current last note):

```json
    "pi/pi-local both run the `pi` binary (earendil-works/pi). pi-local routes through an Ollama provider: register an `ollama` provider + the referenced models in ~/.pi/agent/models.json and `ollama pull` them. The qwen3-coder model IDs are defaults — override to match your locally pulled models."
```

- [ ] **Step 5: Verify both config files are valid JSON and pass the config validator**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('ultraswarm.config.example.json','utf8')); JSON.parse(require('fs').readFileSync('ultraswarm.config.advanced.json','utf8')); console.log('json ok')"
node -e "import('./scripts/router.mjs').then(m => { for (const f of ['ultraswarm.config.example.json','ultraswarm.config.advanced.json']) { const c = JSON.parse(require('fs').readFileSync(f,'utf8')); const r = m.validateConfig(c); if (!r.valid) { console.error(f, r.errors); process.exit(1) } } console.log('config valid'); })"
```
Expected: `json ok` then `config valid`.

- [ ] **Step 6: Commit**

```bash
git add ultraswarm.config.example.json ultraswarm.config.advanced.json
git commit -m "docs(config): add pi and pi-local to example configs"
```

---

## Task 5: Update the README

**Files:**
- Modify: `README.md` (Prerequisites worker list at lines 63-67; add a new "Local / private models (Ollama)" section)

- [ ] **Step 1: Add the new workers to the Prerequisites roster**

In `README.md`, the Prerequisites bullet currently reads:

```markdown
- At least two authenticated worker CLIs from `codex`, `gemini`, `grok`, `agy`,
  `droid`, and `opencode`
```

Change it to:

```markdown
- At least two authenticated worker CLIs from `codex`, `gemini`, `grok`, `agy`,
  `droid`, `opencode`, `pi`, and `pi-local`
```

- [ ] **Step 2: Add a "Local / private models (Ollama)" section**

In `README.md`, immediately before the `## State And Safety` section (line 186), insert:

```markdown
## Local / Private Models (Ollama)

`pi` and `pi-local` are both backed by the [`pi`](https://github.com/earendil-works/pi)
CLI. `pi` runs a provider-agnostic Anthropic Claude spread; `pi-local` is an always-on
worker that routes through **Ollama** for fully local, private, offline-capable runs.

Ollama is a model backend, not an agentic worker — it cannot edit files or run commands on
its own. `pi-local` is the harness that drives local models with tool-calling inside an
isolated worktree.

To use `pi-local`:

1. Install and run [Ollama](https://ollama.com).
2. Pull the models you want, e.g. `ollama pull qwen3-coder:7b` and
   `ollama pull qwen3-coder:30b`.
3. Register an `ollama` provider and those models in `~/.pi/agent/models.json` (Pi reads
   provider entries with `baseUrl: http://localhost:11434/v1`, `api: openai-completions`).
4. Override the default model IDs in `ultraswarm.config.json` to match the models you
   pulled (see `ultraswarm.config.advanced.json`).

`doctor` and `workers` probe the `pi` binary, so a green `pi-local` means "pi is
installed" — not "Ollama is running." If Ollama is down, `pi-local` tasks fail at execution
time and are reported and retried like any other worker failure.
```

- [ ] **Step 3: Verify validate.sh README checks still pass**

Run: `bash scripts/validate.sh`
Expected: PASS — including the README host-installation checks (unchanged) and no obsolete-path failures.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document pi/pi-local workers and Ollama local-model setup"
```

---

## Task 6: Update the CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (insert a new entry above `## [3.0.0]` at line 7)

- [ ] **Step 1: Add the Unreleased entry**

In `CHANGELOG.md`, immediately after line 5 (the intro paragraph ending in `Semantic Versioning`) and before `## [3.0.0] - 2026-06-13` (line 7), insert:

```markdown
## [Unreleased]

### Added
- **`pi` worker** — the provider-agnostic [`pi`](https://github.com/earendil-works/pi)
  coding CLI, with an Anthropic Claude tier spread (Haiku → Sonnet → Opus → Opus with
  `--thinking high`). Run non-interactively via `pi -p`, which auto-executes tools like
  the other workers.
- **`pi-local` worker** — an always-on local/private worker that drives **Ollama** models
  (default `qwen3-coder:7b`/`:30b`, overridable) through the same `pi` binary. Brings
  fully local, offline-capable runs into the routing pool. Requires a configured `ollama`
  provider in `~/.pi/agent/models.json`; see the README.
- Optional `binary` field on registry entries so a logical worker can map to a different
  executable (`pi-local` → `pi`); `ShellWorkerAdapter` now probes the resolved binary.

```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): record pi and pi-local workers"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `node --test`
Expected: PASS — all prior tests plus the new `pi`/`pi-local` routing, capabilities, and binary-resolution tests. No failures.

- [ ] **Step 2: Run repository validation**

Run: `bash scripts/validate.sh`
Expected: PASS (all checks green).

- [ ] **Step 3: Confirm generated host skills are unchanged (SHA lock intact)**

Run: `node scripts/generate-host-skills.mjs --check`
Expected: PASS — host skills are worker-agnostic, so adding workers does not change them; the provenance lock still matches.

- [ ] **Step 4: Smoke-test that the runner surfaces the new workers**

Run: `node bin/ultraswarm.mjs workers`
Expected: output lists `pi` and `pi-local` among the workers with their capabilities. (`pi`/`pi-local` show healthy only if the `pi` binary is installed; unhealthy-but-listed is acceptable here — we are verifying they are in the roster.)

- [ ] **Step 5: Smoke-test routing explanation for a local task**

Run: `node bin/ultraswarm.mjs explain-routing 'write JSDoc comments for utils'`
Expected: completes without error and includes `pi` and `pi-local` in the ranking output.

- [ ] **Step 6: Final confirmation**

Confirm all of the above passed. The feature is complete: two new workers in the roster, the local/Ollama path documented, README + both config examples + CHANGELOG updated, and the full suite + validation + host-skill lock all green.

---

## Self-Review Notes

- **Spec coverage:** `pi` worker (Task 1), `pi-local` always-on local tier (Task 2), `binary` probe change (Task 3), config examples (Task 4), README + Ollama section (Task 5), CHANGELOG (Task 6), verification incl. host-skill lock (Task 7). All spec sections mapped.
- **Hard-coded list:** `scripts/router.test.mjs:203` is the only test asserting the full registry list; updated in Tasks 1 and 2 so the suite stays green after each.
- **Derived consumers untouched:** `lib/plan-schema.mjs` (validates `cli` against `DEFAULT_REGISTRY`), `lib/routing.mjs`, and `lib/orchestrator/decompose.mjs` `ROSTER` all read the registry dynamically — no edits required, behavior verified in Task 7.
- **Type/name consistency:** `binary` field name is identical across `router.mjs` (definition) and `adapters.mjs` (`DEFAULT_REGISTRY[name]?.binary ?? name`); capabilities `strengths` arrays match between `CAPABILITIES` and the assertions in Task 3.
