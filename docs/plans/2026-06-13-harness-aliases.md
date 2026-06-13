# User-Defined Harness Aliases — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users register their own CLI aliases in config (e.g. multiple local-model setups), each `extends`-ing a built-in CLI, routed to by specialty with an optional `maxTier` cap.

**Architecture:** Introduce one seam — `buildRegistry(config)` returns a frozen merge of the hardcoded `DEFAULT_REGISTRY` and the user's resolved `aliases`. Every consumer that reads `DEFAULT_REGISTRY` directly (`resolveRoute`, `WorkerManager`, `routeTask`, `decompose`) switches to the effective registry. `DEFAULT_REGISTRY` stays frozen and untouched; with no `aliases` configured, behavior is byte-identical to today.

**Tech Stack:** Node ≥22 ESM, `node:test` + `node:assert/strict` (`npm test` → `node --test`). No new dependencies.

**Spec:** `docs/specs/2026-06-13-harness-aliases-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `lib/router.mjs` | Registry, config load/validate, route resolution | Add `buildRegistry`, `resolveAlias`, `validateAliases`, tier-ordering helpers; `maxTier` clamp in `resolveRoute` |
| `lib/router.test.mjs` | Router unit tests | Add alias resolution, validation, clamp, parity tests |
| `lib/workers/adapters.mjs` | Worker adapters + manager | Build adapters from effective registry; inherit binary + capabilities; `names()`; registry-aware `probes` default |
| `lib/workers/adapters.test.mjs` | Adapter tests | Add alias adapter + inheritance tests |
| `lib/routing.mjs` | Runner task→worker routing | Derive worker names from manager (effective registry) when `enabled` absent |
| `lib/routing.test.mjs` | Routing tests | Add alias-routing + enabled-gating tests |
| `lib/orchestrator/decompose.mjs` | Bare-shell decomposition roster | Build `ROSTER`/`cli` enum from effective registry + `maxTier` annotation; accept `config` |
| `lib/orchestrator/decompose.test.mjs` | Decompose tests | Add roster-includes-alias test |
| `bin/cli.mjs` | CLI entrypoint | Pass `config` into `decompose` |
| `ultraswarm.config.advanced.json`, `README.md`, `skills/ultraswarm/SKILL.md`, `CHANGELOG.md`, `.claude-plugin/plugin.json` | Docs + version | Worked example, docs, version bump |

**Build order:** Task 1 (resolution) → 2 (validation) → 3 (clamp/resolveRoute) are the router core. Tasks 4–6 wire consumers. Task 7 is docs + version bump. Each task is independently testable.

---

## Task 1: `buildRegistry` + alias resolution (`extends`)

**Files:**
- Modify: `lib/router.mjs` (add helpers near `DEFAULT_REGISTRY`, after line 319)
- Test: `lib/router.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `lib/router.test.mjs`. First add `buildRegistry` to the existing import block (the `from './router.mjs'` import near the top):

```javascript
import {
  DEFAULT_REGISTRY,
  loadConfig,
  validateConfig,
  resolveRoute,
  buildRegistry,
} from './router.mjs';
```

Then add this `describe` block inside the top-level `describe('router', …)`:

```javascript
  describe('buildRegistry', () => {
    it('returns DEFAULT_REGISTRY unchanged when no aliases are configured', () => {
      assert.deepStrictEqual(buildRegistry({}), DEFAULT_REGISTRY);
      assert.deepStrictEqual(buildRegistry({ enabled: ['codex'] }), DEFAULT_REGISTRY);
    });

    it('resolves an alias, inheriting binary/timeoutMs/effortFlags from the extends base', () => {
      const reg = buildRegistry({
        aliases: {
          'pi-qwen-coder': {
            extends: 'pi',
            specialty: 'local coding',
            models: { simple: { model: 'qwen3-coder:7b', invocation: 'pi -p --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      });
      const alias = reg['pi-qwen-coder'];
      assert.equal(alias.binary, 'pi');                       // inherited
      assert.equal(alias.timeoutMs, DEFAULT_REGISTRY.pi.timeoutMs); // inherited
      assert.deepStrictEqual(alias.effortFlags, DEFAULT_REGISTRY.pi.effortFlags); // inherited
      assert.equal(alias.specialty, 'local coding');          // overridden
      assert.equal(alias.models.simple.model, 'qwen3-coder:7b'); // owned
    });

    it('does NOT merge model tiers from the base — only the alias-declared tiers exist', () => {
      const reg = buildRegistry({
        aliases: {
          'pi-qwen-coder': {
            extends: 'pi',
            models: { simple: { model: 'qwen3-coder:7b', invocation: 'pi --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      });
      assert.deepStrictEqual(Object.keys(reg['pi-qwen-coder'].models), ['simple']);
      assert.equal(reg['pi-qwen-coder'].models.complex, undefined);
    });

    it('inherits the base specialty when the alias omits one, and carries maxTier through', () => {
      const reg = buildRegistry({
        aliases: {
          'pi-fast': {
            extends: 'pi',
            maxTier: 'moderate',
            models: { simple: { model: 'x', invocation: 'pi --model x "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      });
      assert.equal(reg['pi-fast'].specialty, DEFAULT_REGISTRY.pi.specialty);
      assert.equal(reg['pi-fast'].maxTier, 'moderate');
    });

    it('returns a frozen registry and leaves DEFAULT_REGISTRY untouched', () => {
      const reg = buildRegistry({
        aliases: { 'pi-x': { extends: 'pi', models: { simple: { model: 'x', invocation: 'pi "$(cat .ultraswarm-prompt.txt)"' } } } },
      });
      assert.ok(Object.isFrozen(reg));
      assert.equal(DEFAULT_REGISTRY['pi-x'], undefined);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/router.test.mjs`
Expected: FAIL — `buildRegistry is not a function` (it is not exported yet).

- [ ] **Step 3: Implement `resolveAlias` + `buildRegistry`**

In `lib/router.mjs`, immediately after the `DEFAULT_REGISTRY` definition closes (after line 319, the `});`), add:

```javascript
/**
 * Resolve one alias entry against its `extends` base. Inherits binary, timeoutMs,
 * effortFlags, and specialty (when omitted); the alias OWNS its models map (no per-tier
 * merge with the base) and carries maxTier through. Assumes the alias has already passed
 * validateAliases — buildRegistry never resolves an alias with a bad/missing base.
 */
function resolveAlias(name, alias) {
  const base = DEFAULT_REGISTRY[alias.extends] ?? {};
  return {
    specialty: alias.specialty ?? base.specialty,
    timeoutMs: alias.timeoutMs ?? base.timeoutMs,
    effortFlags: alias.effortFlags ?? base.effortFlags,
    binary: alias.binary ?? base.binary ?? alias.extends ?? name,
    models: alias.models,
    ...(alias.maxTier ? { maxTier: alias.maxTier } : {}),
    extends: alias.extends,
  };
}

/**
 * Effective registry = the frozen built-ins plus the user's resolved aliases.
 * With no aliases, returns DEFAULT_REGISTRY itself (referential identity preserved).
 */
export function buildRegistry(config = {}) {
  const aliases = config?.aliases;
  if (!aliases || typeof aliases !== 'object' || Object.keys(aliases).length === 0) {
    return DEFAULT_REGISTRY;
  }
  const resolved = {};
  for (const [name, alias] of Object.entries(aliases)) {
    resolved[name] = resolveAlias(name, alias);
  }
  return freezeDeep({ ...DEFAULT_REGISTRY, ...resolved });
}
```

> Note: `binary` falls back to `alias.extends` (the base's binary defaults to its own name in `ShellWorkerAdapter`, and built-in entries only set `binary` explicitly for `pi`/`pi-local`). This keeps `pi-qwen-coder` → binary `pi`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/router.test.mjs`
Expected: PASS (all `buildRegistry` tests green; existing tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add lib/router.mjs lib/router.test.mjs
git commit -m "feat(aliases): buildRegistry resolves user-defined CLI aliases via extends"
```

---

## Task 2: `validateAliases` folded into `validateConfig`

**Files:**
- Modify: `lib/router.mjs` (`validateConfig` near line 352; add `validateAliases`)
- Test: `lib/router.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('validateConfig', …)` block in `lib/router.test.mjs` (if no such block exists, add a new `describe('validateConfig aliases', …)` inside `describe('router', …)`):

```javascript
  describe('validateConfig aliases', () => {
    const goodAlias = {
      'pi-qwen-coder': {
        extends: 'pi',
        specialty: 'local coding',
        maxTier: 'moderate',
        models: { simple: { model: 'qwen3-coder:7b', invocation: 'pi --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"' } },
      },
    };

    it('accepts a well-formed alias and allows it in enabled without warnings', () => {
      const res = validateConfig({ aliases: goodAlias, enabled: ['codex', 'pi-qwen-coder'] });
      assert.equal(res.valid, true);
      assert.deepStrictEqual(res.errors, []);
      assert.equal(res.warnings.some((w) => w.includes('pi-qwen-coder')), false);
    });

    it('rejects an alias name that collides with a built-in', () => {
      const res = validateConfig({ aliases: { codex: { extends: 'pi', models: goodAlias['pi-qwen-coder'].models } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('codex') && e.includes('built-in')));
    });

    it('rejects extends that targets a non-built-in (and no binary given)', () => {
      const res = validateConfig({ aliases: { 'a-x': { extends: 'nope', models: goodAlias['pi-qwen-coder'].models } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('extends')));
    });

    it('rejects extends that targets another alias (no alias chains)', () => {
      const res = validateConfig({ aliases: {
        'a-1': { extends: 'pi', models: goodAlias['pi-qwen-coder'].models },
        'a-2': { extends: 'a-1', models: goodAlias['pi-qwen-coder'].models },
      } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('a-2') && e.includes('extends')));
    });

    it('rejects models missing the simple anchor', () => {
      const res = validateConfig({ aliases: { 'a-x': { extends: 'pi', models: { moderate: { model: 'm', invocation: 'pi "$(cat .ultraswarm-prompt.txt)"' } } } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('simple')));
    });

    it('rejects an invalid maxTier', () => {
      const res = validateConfig({ aliases: { 'a-x': { extends: 'pi', maxTier: 'huge', models: goodAlias['pi-qwen-coder'].models } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('maxTier')));
    });

    it('rejects an invocation missing the prompt file', () => {
      const res = validateConfig({ aliases: { 'a-x': { extends: 'pi', models: { simple: { model: 'm', invocation: 'pi --model m "hi"' } } } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('.ultraswarm-prompt.txt')));
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/router.test.mjs`
Expected: FAIL — `res.valid` is `true`/warnings-only where errors are expected (alias validation not implemented).

- [ ] **Step 3: Implement `validateAliases` and call it from `validateConfig`**

In `lib/router.mjs`, add this function just above `export function validateConfig` (before line 352):

```javascript
function validateAliases(aliases, errors) {
  if (aliases === undefined) return;
  if (typeof aliases !== 'object' || Array.isArray(aliases)) {
    errors.push(`aliases must be an object; got ${JSON.stringify(aliases)}.`);
    return;
  }
  const aliasNames = new Set(Object.keys(aliases));
  for (const [name, alias] of Object.entries(aliases)) {
    if (Object.hasOwn(DEFAULT_REGISTRY, name)) {
      errors.push(`aliases.${name} collides with the built-in CLI "${name}"; use overrides to tune built-ins, aliases to add new ones.`);
      continue;
    }
    if (!alias || typeof alias !== 'object' || Array.isArray(alias)) {
      errors.push(`aliases.${name} must be an object; got ${JSON.stringify(alias)}.`);
      continue;
    }
    const hasBinary = typeof alias.binary === 'string' && alias.binary.trim() !== '';
    if (alias.extends !== undefined) {
      if (aliasNames.has(alias.extends)) {
        errors.push(`aliases.${name}.extends targets another alias "${alias.extends}"; aliases may only extend a built-in CLI.`);
      } else if (!Object.hasOwn(DEFAULT_REGISTRY, alias.extends)) {
        errors.push(`aliases.${name}.extends must reference a built-in CLI; got ${JSON.stringify(alias.extends)}.`);
      }
    } else if (!hasBinary) {
      errors.push(`aliases.${name} must set "extends" (a built-in CLI) or its own "binary".`);
    }
    if (alias.maxTier !== undefined && !VALID_TIER_SET.has(alias.maxTier)) {
      errors.push(`aliases.${name}.maxTier must be one of ${VALID_TIERS.join(', ')}; got ${JSON.stringify(alias.maxTier)}.`);
    }
    validateModels(name, alias.models, errors); // reuses built-in tier/invocation/simple-anchor checks
  }
}
```

Then wire it into `validateConfig`. The current body builds `errors`/`warnings`, checks `enabled` and `overrides`, then calls `validateIntelligence`. Make two edits inside `validateConfig`:

1. Replace the `enabled` unknown-CLI loop so it consults the effective registry. Change:

```javascript
  for (const cli of Array.isArray(candidate.enabled) ? candidate.enabled : []) {
    if (!Object.hasOwn(DEFAULT_REGISTRY, cli)) {
      warnings.push(`enabled contains unknown CLI "${cli}"; it will be ignored.`);
    }
  }
```

to:

```javascript
  const aliasNames = new Set(Object.keys(candidate.aliases ?? {}));
  for (const cli of Array.isArray(candidate.enabled) ? candidate.enabled : []) {
    if (!Object.hasOwn(DEFAULT_REGISTRY, cli) && !aliasNames.has(cli)) {
      warnings.push(`enabled contains unknown CLI "${cli}"; it will be ignored.`);
    }
  }
```

2. Add the alias validation call immediately before `validateIntelligence(candidate, errors);`:

```javascript
  validateAliases(candidate.aliases, errors);
```

> `validateModels` already requires the `simple` anchor and checks each tier's `model` + invocation (`.ultraswarm-prompt.txt`), so the missing-simple, bad-invocation, and bad-tier cases are covered by reuse.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/router.test.mjs`
Expected: PASS (all seven alias-validation cases green).

- [ ] **Step 5: Commit**

```bash
git add lib/router.mjs lib/router.test.mjs
git commit -m "feat(aliases): validate alias entries and accept them in enabled"
```

---

## Task 3: `resolveRoute` uses the effective registry + `maxTier` clamp

**Files:**
- Modify: `lib/router.mjs` (`resolveRoute`, lines 375–401; add a tier-ordering helper)
- Test: `lib/router.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add inside `describe('router', …)` in `lib/router.test.mjs`:

```javascript
  describe('resolveRoute with aliases', () => {
    const cfg = {
      aliases: {
        'pi-qwen-coder': {
          extends: 'pi',
          specialty: 'local coding',
          maxTier: 'moderate',
          models: {
            simple: { model: 'qwen3-coder:7b', invocation: 'pi --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"' },
            moderate: { model: 'qwen3-coder:30b', invocation: 'pi --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"' },
          },
        },
      },
    };

    it('routes an explicit alias task to the alias invocation/model', () => {
      const r = resolveRoute({ cli: 'pi-qwen-coder', model_tier: 'simple' }, cfg);
      assert.equal(r.model, 'qwen3-coder:7b');
      assert.match(r.command, /qwen3-coder:7b/);
    });

    it('clamps a tier above maxTier down to maxTier', () => {
      const r = resolveRoute({ cli: 'pi-qwen-coder', model_tier: 'expert' }, cfg);
      assert.equal(r.tier, 'moderate');
      assert.equal(r.model, 'qwen3-coder:30b');
    });

    it('does not clamp a tier at or below maxTier', () => {
      const r = resolveRoute({ cli: 'pi-qwen-coder', model_tier: 'simple' }, cfg);
      assert.equal(r.tier, 'simple');
    });

    it('inherits the base effortFlags for {{EFFORT}} substitution', () => {
      const reg = buildRegistry(cfg);
      assert.deepStrictEqual(reg['pi-qwen-coder'].effortFlags, DEFAULT_REGISTRY.pi.effortFlags);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/router.test.mjs`
Expected: FAIL — `Unknown cli "pi-qwen-coder"` thrown by `resolveRoute` (it still reads `DEFAULT_REGISTRY`).

- [ ] **Step 3: Add the tier-ordering helper**

In `lib/router.mjs`, just below the `VALID_TIERS` constant (after line 5/6), add:

```javascript
const TIER_RANK = Object.freeze({ simple: 0, moderate: 1, complex: 2, expert: 3 });
function clampTier(tier, maxTier) {
  if (!maxTier || TIER_RANK[tier] <= TIER_RANK[maxTier]) return tier;
  return maxTier;
}
```

- [ ] **Step 4: Make `resolveRoute` use the effective registry and clamp**

In `lib/router.mjs`, edit `resolveRoute`. Replace the opening unknown-cli guard and the registry reads so they go through `buildRegistry(config)` and apply the clamp. Change the body from:

```javascript
export function resolveRoute(task, config = {}) {
  const cli = task?.cli;
  if (!Object.hasOwn(DEFAULT_REGISTRY, cli)) {
    throw new Error(`Unknown cli "${cli}". Allowed values: ${Object.keys(DEFAULT_REGISTRY).join(', ')}.`);
  }
```

to:

```javascript
export function resolveRoute(task, config = {}) {
  const registry = buildRegistry(config);
  const cli = task?.cli;
  if (!Object.hasOwn(registry, cli)) {
    throw new Error(`Unknown cli "${cli}". Allowed values: ${Object.keys(registry).join(', ')}.`);
  }
```

Then change the tier computation line from:

```javascript
  const tier = task?.model_tier ?? getTier(task?.complexity_score, thresholds);
```

to:

```javascript
  const requestedTier = task?.model_tier ?? getTier(task?.complexity_score, thresholds);
  const tier = clampTier(requestedTier, registry[cli].maxTier);
```

Finally, replace the three `DEFAULT_REGISTRY[cli]` reads further down in `resolveRoute` with `registry[cli]`:

```javascript
  const command = config.overrides?.[cli]?.models?.[tier]?.invocation
    ?? config.overrides?.[cli]?.models?.simple?.invocation
    ?? config.overrides?.[cli]?.invocation
    ?? registry[cli].models[tier]?.invocation
    ?? registry[cli].models.simple.invocation;
  const timeoutMs = config.overrides?.[cli]?.timeoutMs ?? registry[cli].timeoutMs;
  const model = config.overrides?.[cli]?.models?.[tier]?.model ?? config.overrides?.[cli]?.models?.simple?.model ?? registry[cli].models[tier]?.model ?? registry[cli].models.simple.model;

  const effort = task?.effort ?? DEFAULT_EFFORT;
  const effortFlags = config.overrides?.[cli]?.effortFlags ?? registry[cli].effortFlags;
```

> The `?? registry[cli].models.simple.invocation` fallback matters: an alias may define only `simple`, so a clamped/undefined tier resolves to its own `simple` (never the base's tier — aliases don't inherit tiers).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test lib/router.test.mjs`
Expected: PASS. Also run the full suite to confirm no regression: `npm test` — Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add lib/router.mjs lib/router.test.mjs
git commit -m "feat(aliases): resolveRoute resolves aliases and clamps to maxTier"
```

---

## Task 4: `WorkerManager` + `ShellWorkerAdapter` are alias-aware

**Files:**
- Modify: `lib/workers/adapters.mjs` (lines 17–23 adapter, 55–63 manager)
- Test: `lib/workers/adapters.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `lib/workers/adapters.test.mjs` (match the file's existing import/describe style; this assumes `WorkerManager` and a `cfg` with `repo` are constructible as in the existing tests):

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerManager } from './adapters.mjs';

describe('WorkerManager aliases', () => {
  const cfg = {
    repo: '/tmp/repo-aliases-test',
    aliases: {
      'pi-qwen-coder': {
        extends: 'pi',
        specialty: 'local coding',
        models: { simple: { model: 'qwen3-coder:7b', invocation: 'pi --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"' } },
      },
    },
  };

  it('creates an adapter for the alias whose binary is inherited from the base', () => {
    const mgr = new WorkerManager(cfg, { supervisor: { run: async () => ({}), close() {} } });
    const adapter = mgr.get('pi-qwen-coder');
    assert.equal(adapter.binary, 'pi');           // inherited from extends: pi
    mgr.close();
  });

  it('exposes alias names via names() and includes them in probes by default', () => {
    const mgr = new WorkerManager(cfg, { supervisor: { run: async () => ({}), close() {} } });
    assert.ok(mgr.names().includes('pi-qwen-coder'));
    mgr.close();
  });

  it('inherits the base capabilities for an alias', () => {
    const mgr = new WorkerManager(cfg, { supervisor: { run: async () => ({}), close() {} } });
    const caps = mgr.get('pi-qwen-coder').capabilities();
    assert.deepStrictEqual(caps.strengths, mgr.get('pi').capabilities().strengths);
    mgr.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/workers/adapters.test.mjs`
Expected: FAIL — `unknown worker pi-qwen-coder` (manager builds adapters only from `DEFAULT_REGISTRY`).

- [ ] **Step 3: Build adapters from the effective registry + inherit binary/capabilities**

In `lib/workers/adapters.mjs`:

a. Update the import on line 3 to include `buildRegistry`:

```javascript
import { resolveRoute, DEFAULT_REGISTRY, buildRegistry } from '../router.mjs'
```

b. Replace the `ShellWorkerAdapter` constructor (line 18) so binary and capabilities resolve through the effective registry:

```javascript
  constructor(name, cfg, supervisor, limit = (fn) => fn()) {
    this.name = name
    const registry = buildRegistry(cfg)
    this.base = registry[name]?.extends   // built-in name this alias inherits from, if any
    this.binary = registry[name]?.binary ?? name
    this.cfg = cfg
    this.supervisor = supervisor
    this.limit = limit
  }
```

c. Replace `capabilities()` (line 23) so an alias falls back to its base's capabilities:

```javascript
  capabilities() { return { name: this.name, ...(CAPABILITIES[this.name] ?? CAPABILITIES[this.base] ?? { languages: ['*'], strengths: ['general'] }) } }
```

d. In `WorkerManager` constructor (line 56), build adapters from the effective registry and remember its keys:

```javascript
  constructor(cfg, { supervisor } = {}) {
    this.cfg = cfg
    this.supervisor = supervisor ?? new ProcessSupervisor({ logDir: `${cfg.repo}/.ultraswarm/logs` })
    this._names = Object.keys(buildRegistry(cfg))
    this.adapters = new Map(this._names.map((name) => [name, new ShellWorkerAdapter(name, cfg, this.supervisor)]))
  }
  names() { return [...this._names] }
```

e. Update `probes` (line 62) to default to the effective registry keys instead of `DEFAULT_REGISTRY`:

```javascript
  probes(enabled = this._names) { return enabled.map((name) => ({ name, ...this.get(name).probe() })) }
```

> `DEFAULT_REGISTRY` stays imported — `resolveRoute` is still called inside `validateModel`/`executeNow`, and those go through `resolveRoute(…, this.cfg)` which now builds the effective registry itself.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/workers/adapters.test.mjs`
Expected: PASS (alias adapter, `names()`, capabilities inheritance all green).

- [ ] **Step 5: Commit**

```bash
git add lib/workers/adapters.mjs lib/workers/adapters.test.mjs
git commit -m "feat(aliases): WorkerManager builds alias adapters with inherited binary/capabilities"
```

---

## Task 5: `routeTask` considers aliases

**Files:**
- Modify: `lib/routing.mjs:24-26`
- Test: `lib/routing.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `lib/routing.test.mjs` (match its existing import/setup; this builds a real `WorkerManager` with a stub supervisor so `manager.names()`/`capabilities()` are available):

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from './routing.mjs';
import { WorkerManager } from './workers/adapters.mjs';

describe('routeTask with aliases', () => {
  const cfg = {
    repo: '/tmp/repo-route-aliases',
    aliases: {
      'pi-qwen-coder': {
        extends: 'pi',
        specialty: 'local coding',
        models: { simple: { model: 'q', invocation: 'pi --model q "$(cat .ultraswarm-prompt.txt)"' } },
      },
    },
  };
  const stub = { run: async () => ({}), close() {} };
  const healthyProbes = (mgr) => mgr.names().map((name) => ({ name, healthy: true }));

  it('selects the alias when explicitly requested and it is enabled', () => {
    const mgr = new WorkerManager(cfg, { supervisor: stub });
    const res = routeTask({ cli: 'pi-qwen-coder', description: 'x', files: [] },
      { manager: mgr, enabled: ['pi-qwen-coder'], probes: healthyProbes(mgr) });
    assert.equal(res.worker, 'pi-qwen-coder');
    mgr.close();
  });

  it('rejects an explicit alias that is not in enabled', () => {
    const mgr = new WorkerManager(cfg, { supervisor: stub });
    assert.throws(
      () => routeTask({ cli: 'pi-qwen-coder', description: 'x', files: [] },
        { manager: mgr, enabled: ['codex'], probes: healthyProbes(mgr) }),
      /not enabled/);
    mgr.close();
  });

  it('considers the alias in auto-routing when enabled is omitted', () => {
    const mgr = new WorkerManager(cfg, { supervisor: stub });
    const res = routeTask({ description: 'write some local code', files: ['a.js'] },
      { manager: mgr, probes: healthyProbes(mgr) });
    assert.ok(res.scores.some((s) => s.worker === 'pi-qwen-coder'));
    mgr.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/routing.test.mjs`
Expected: FAIL — the auto-routing test fails because `names` falls back to `Object.keys(DEFAULT_REGISTRY)` (no alias), so `pi-qwen-coder` never appears in `scores`.

- [ ] **Step 3: Derive worker names from the manager (effective registry)**

In `lib/routing.mjs`, change line 25 from:

```javascript
  const names = enabled?.length ? enabled : Object.keys(DEFAULT_REGISTRY)
```

to:

```javascript
  const names = enabled?.length ? enabled : (manager?.names?.() ?? Object.keys(DEFAULT_REGISTRY))
```

> Keep the `DEFAULT_REGISTRY` import — it remains the fallback when no manager is supplied.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/routing.test.mjs`
Expected: PASS (explicit-select, enabled-gating, and auto-routing all green).

- [ ] **Step 5: Commit**

```bash
git add lib/routing.mjs lib/routing.test.mjs
git commit -m "feat(aliases): routeTask considers aliases via manager.names()"
```

---

## Task 6: Decomposition roster includes aliases + `maxTier` annotation

**Files:**
- Modify: `lib/orchestrator/decompose.mjs:4-6,32,41`
- Modify: `bin/cli.mjs:55` (pass config)
- Test: `lib/orchestrator/decompose.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `lib/orchestrator/decompose.test.mjs` (match its existing import/style; `decompose` takes a stub brain):

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decompose } from './decompose.mjs';

describe('decompose roster with aliases', () => {
  it('lists configured aliases (with maxTier annotation) in the brain prompt', async () => {
    let seenPrompt = '';
    const brain = { complete: async ({ prompt }) => { seenPrompt = prompt; return { object: { tasks: [] } }; } };
    const cfg = {
      aliases: {
        'pi-qwen-coder': {
          extends: 'pi',
          specialty: 'local coding',
          maxTier: 'moderate',
          models: { simple: { model: 'q', invocation: 'pi --model q "$(cat .ultraswarm-prompt.txt)"' } },
        },
      },
    };
    await decompose(brain, 'do a thing', '/tmp/repo', 'opus', cfg);
    assert.match(seenPrompt, /pi-qwen-coder/);
    assert.match(seenPrompt, /max tier: moderate/);
  });

  it('omits the alias roster entirely when no config is passed (parity)', async () => {
    let seenPrompt = '';
    const brain = { complete: async ({ prompt }) => { seenPrompt = prompt; return { object: { tasks: [] } }; } };
    await decompose(brain, 'do a thing', '/tmp/repo', 'opus');
    assert.doesNotMatch(seenPrompt, /pi-qwen-coder/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/orchestrator/decompose.test.mjs`
Expected: FAIL — `decompose` ignores the 5th arg; `ROSTER` is a module constant built from `DEFAULT_REGISTRY`, so `pi-qwen-coder` never appears.

- [ ] **Step 3: Build the roster from the effective registry**

In `lib/orchestrator/decompose.mjs`:

a. Update the import (line 4) and remove the module-level `ROSTER` constant (line 6):

```javascript
import { DEFAULT_REGISTRY, buildRegistry } from '../router.mjs'
```

(delete the `const ROSTER = …` line entirely)

b. Add a roster helper after the imports:

```javascript
function rosterFor(registry) {
  return Object.entries(registry)
    .map(([cli, r]) => `${cli} (${r.specialty}${r.maxTier ? `; max tier: ${r.maxTier}` : ''})`)
    .join('; ')
}
```

c. Change the `decompose` signature (line 32) to accept `config` and build the registry/roster locally:

```javascript
export async function decompose(brain, task, repo, model, config = {}) {
  const registry = buildRegistry(config)
  const roster = rosterFor(registry)
```

d. In the prompt template (line 41), replace the `cli:` line so it uses the local `registry`/`roster`:

```javascript
- cli: ONE of: ${Object.keys(registry).join(', ')}. Choose by specialty — ${roster}.
```

- [ ] **Step 4: Pass config from the CLI entrypoint**

In `bin/cli.mjs`, line 55, change:

```javascript
    const result = await decompose(brain(), task, context.repo, resolveBrainModel('opus', context.config).model)
```

to:

```javascript
    const result = await decompose(brain(), task, context.repo, resolveBrainModel('opus', context.config).model, context.config)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test lib/orchestrator/decompose.test.mjs`
Expected: PASS (alias appears with annotation; parity test green).

Then run the whole suite: `npm test` — Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add lib/orchestrator/decompose.mjs bin/cli.mjs lib/orchestrator/decompose.test.mjs
git commit -m "feat(aliases): decomposition roster includes aliases with maxTier annotation"
```

---

## Task 7: Docs + version bump

**Files:**
- Modify: `ultraswarm.config.advanced.json`, `README.md`, `skills/ultraswarm/SKILL.md`, `CHANGELOG.md`, `.claude-plugin/plugin.json`

- [ ] **Step 1: Add a worked alias to the advanced config example**

In `ultraswarm.config.advanced.json`, add an `"aliases"` block (sibling to `"overrides"`) and a note. Insert after the `"notes"` array's last entry a new note string:

```json
    "aliases (opt-in): register your own CLI entries that extend a built-in. pi-qwen-coder below reuses the pi binary with a local Ollama model and a lean harness (--config), and is capped at moderate tier so it never receives expert work. Add the alias name to 'enabled' (or omit 'enabled') to activate it."
```

And add this top-level key (sibling to `overrides`):

```json
  "aliases": {
    "pi-qwen-coder": {
      "extends": "pi",
      "specialty": "local coding, small refactors, unit tests",
      "maxTier": "moderate",
      "models": {
        "simple":   { "model": "qwen3-coder:7b",  "invocation": "pi -p --provider ollama --model qwen3-coder:7b --config ~/.pi/lean.json \"$(cat .ultraswarm-prompt.txt)\"" },
        "moderate": { "model": "qwen3-coder:30b", "invocation": "pi -p --provider ollama --model qwen3-coder:30b \"$(cat .ultraswarm-prompt.txt)\"" }
      }
    }
  }
```

Verify it stays valid JSON: `node -e "JSON.parse(require('fs').readFileSync('ultraswarm.config.advanced.json','utf8')); console.log('ok')"` — Expected: `ok`.

- [ ] **Step 2: Add a README section**

In `README.md`, find the configuration/overrides section and add a subsection after it:

```markdown
### Harness aliases (custom CLI entries)

Beyond the built-in CLIs, you can register your own named entries under `aliases`. An alias
`extends` a built-in (inheriting its binary, timeout, effort flags, and capabilities) and
overrides only what differs — its specialty, its model tiers, and its invocation. This is how
you run several local models, each tuned for a job, through one CLI binary:

```json
{
  "enabled": ["codex", "pi-qwen-coder", "pi-deepseek-docs"],
  "aliases": {
    "pi-qwen-coder": {
      "extends": "pi",
      "specialty": "local coding, small refactors, unit tests",
      "maxTier": "moderate",
      "models": {
        "simple": { "model": "qwen3-coder:7b", "invocation": "pi -p --provider ollama --model qwen3-coder:7b --config ~/.pi/lean.json \"$(cat .ultraswarm-prompt.txt)\"" }
      }
    }
  }
}
```

- **Lean harness:** put whatever makes a CLI's harness leaner directly in the `invocation`
  (a `--config` pointing at a stripped-down profile, fewer flags, etc.). Local models often do
  better with less wrapping.
- **`maxTier`:** caps the tiers an alias will accept. A task above the cap is clamped down (e.g.
  an expert task on a `maxTier: moderate` alias runs at moderate), so a small local model is
  never handed work it can't do.
- **Opt-in only:** nothing is auto-generated. An alias exists only if you declare it, and is
  active only when it appears in `enabled` (or when `enabled` is omitted entirely).
```
```

- [ ] **Step 3: Add one line to the SKILL roster note**

In `skills/ultraswarm/SKILL.md`, under the `## Operations` or `## Plan Contract` section, add a single line noting alias visibility:

```markdown
- User-defined `aliases` in config appear in the roster alongside built-in CLIs; `doctor`/`workers` and `explain-routing` show them, and the decomposition roster routes to them by specialty (respecting any `maxTier` cap).
```

- [ ] **Step 4: Add a CHANGELOG entry and bump the version**

In `CHANGELOG.md`, add a new entry at the top (match the existing heading style) for `## 3.2.0`:

```markdown
## 3.2.0

### Added
- **User-defined harness aliases.** Register custom CLI entries under a new `aliases` config key.
  Each alias `extends` a built-in (inheriting binary, timeout, effort flags, and capabilities) and
  overrides its specialty, model tiers, and invocation — generalizing the previously hardcoded
  `pi-local`. Supports an optional `maxTier` cap (tasks above it are clamped down) and routes by
  specialty like the built-ins. Strictly opt-in: with no `aliases`, behavior is unchanged.
```

In `.claude-plugin/plugin.json`, change `"version": "3.1.0"` to `"version": "3.2.0"`.

> Per project memory, the plugin cache is version-keyed — without this bump the skill/config edits won't reach `/ultraswarm` for symlink-free installs.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: all green.

```bash
git add ultraswarm.config.advanced.json README.md skills/ultraswarm/SKILL.md CHANGELOG.md .claude-plugin/plugin.json
git commit -m "docs(aliases): document harness aliases, add example, bump to 3.2.0"
```

---

## Verification (whole feature)

- [ ] `npm test` is fully green.
- [ ] **No-config parity:** `node -e "import('./lib/router.mjs').then(m => console.log(m.buildRegistry({}) === m.DEFAULT_REGISTRY))"` prints `true`.
- [ ] **Validation smoke:** a config with `aliases: { codex: {...} }` reports a collision error via `validateConfig`.
- [ ] **Routing smoke:** with a `pi-qwen-coder` alias enabled, `node bin/ultraswarm.mjs explain-routing "write a small util and its test"` lists `pi-qwen-coder` among the scored workers.
- [ ] **Clamp smoke:** `node -e "import('./lib/router.mjs').then(m => console.log(m.resolveRoute({cli:'pi-qwen-coder',model_tier:'expert'}, CFG).tier))"` (with `CFG` = the example alias config) prints `moderate`.
- [ ] Each task was committed separately with the messages above.
