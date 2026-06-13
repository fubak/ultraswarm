# User-Defined Harness Aliases — Design Spec

**Date:** 2026-06-13
**Status:** Approved (design) — implementation to follow
**Extends:** `docs/specs/2026-06-07-ultraswarm-design.md`
**Builds on (git):** the `pi`/`pi-local` registry entries (PR #18, `feature/pi-worker-local-models`). `pi-local` is the hardcoded prototype of the pattern this spec generalizes.
**Motivation:** User feedback — *"It would be good if you can configure harness aliases, then you can configure the same CLI with different models configured. Local models might perform best with less bloated harnesses, and having multiple local LLMs with the specific CLI for the job will yield better results."*

## Problem

`DEFAULT_REGISTRY` (`lib/router.mjs`) is a frozen, hardcoded set of 8 CLIs. `pi-local` already demonstrates the key idea: it reuses the `pi` **binary** (`binary: 'pi'`) but points at a different provider and a different model set (Ollama + `qwen3-coder`). It is, in effect, an *alias* of `pi`.

But config `overrides` can only **modify** the 8 baked-in entries — `validateOverride` warns "unknown CLI" for anything else, and `WorkerManager`, `routeTask`, the `decompose` `ROSTER`, and the `CAPABILITIES` map are all driven off `Object.keys(DEFAULT_REGISTRY)`. So a user who wants **three** local setups (a coding-tuned model, a docs model, a fast boilerplate model) has only the **one** `pi-local` slot.

The "less bloated harness" need is already expressible *inside* an invocation string (point a CLI at a lean config / fewer flags). What is missing is the ability to **name new alias entries** so each can carry its own binary, specialty, model tiers, and invocation — and be routed to by specialty like any built-in.

## Approved Decisions

| Decision | Choice |
|---|---|
| Core mechanism | **User-defined CLI aliases in config.** A new top-level `aliases` key registers brand-new registry entries. Generalizes the hardcoded `pi-local`. |
| "Lean harness" | Expressed **inside each alias's invocation string** (e.g. `pi … --config ~/.pi/lean.json`). No separate harness-profile primitive in v1. |
| Inheritance | **`extends`** — an alias names a built-in base and inherits `binary`, `timeoutMs`, `effortFlags`, `capabilities`, and `specialty` (if omitted). It overrides only what differs. |
| Per-tier model inheritance | **None.** An alias's `models` map stands alone; undefined tiers fall back to the alias's own `simple`, never to the base CLI's tier. (Safety: prevents a local alias from silently routing to the base's *frontier* model.) |
| Routing | **Auto-route + tier caps.** Aliases appear in the decomposition roster and are routed by specialty like the built-ins. An optional `maxTier` caps the tiers an alias will accept. |
| Provenance | **Strictly user-opt-in.** No auto-discovery, no probing of `ollama list`. `buildRegistry` only resolves what the user declared. No `aliases` → effective registry is byte-identical to `DEFAULT_REGISTRY` and behavior is unchanged. |

## Design

### 1. Config shape (`aliases`, sibling to `overrides`)

```json
{
  "enabled": ["codex", "gemini", "pi-qwen-coder", "pi-deepseek-docs"],
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
}
```

An alias entry's fields:

- `extends` (**required** unless the alias is fully self-contained with its own `binary`): names a **built-in** CLI (a `DEFAULT_REGISTRY` key). Alias→alias chains are rejected.
- `specialty` (optional): roster description the brain routes on. Inherits the base's specialty if omitted; overriding is strongly recommended for local models so the brain matches them to appropriate work.
- `models` (**required**): same shape as registry `models`; must include a `simple` anchor. Per-tier invocations stand alone (no inheritance from the base's tiers).
- `maxTier` (optional): one of `simple|moderate|complex|expert`. Caps the tier this alias accepts.
- `capabilities`, `binary`, `timeoutMs`, `effortFlags` (optional): override the inherited values.

### 2. The effective registry (`buildRegistry`, `lib/router.mjs`)

New exported function `buildRegistry(config)` returns a deeply-frozen `{ ...DEFAULT_REGISTRY, ...resolvedAliases }`. `DEFAULT_REGISTRY` itself stays frozen and untouched (immutability — no global mutation).

Each resolved alias merges the base with the alias overrides:

```
resolved = {
  ...base,                         // registry fields: binary, timeoutMs, effortFlags, specialty
  specialty: alias.specialty ?? base.specialty,
  binary:     alias.binary     ?? base.binary ?? base-name,
  timeoutMs:  alias.timeoutMs  ?? base.timeoutMs,
  effortFlags: alias.effortFlags ?? base.effortFlags,
  models:     alias.models,        // owned — NOT merged per-tier with base
  maxTier:    alias.maxTier        // undefined when absent
}
```

(`capabilities` is **not** a registry field — it lives in the `CAPABILITIES` map in `adapters.mjs` and is inherited separately, per §5.)

`buildRegistry` is the single seam. Every consumer that currently imports `DEFAULT_REGISTRY` directly switches to the effective registry derived from `config`.

### 3. `resolveRoute` + `maxTier` clamp (`lib/router.mjs`)

`resolveRoute(task, config)` builds the effective registry from `config`, then resolves against it instead of `DEFAULT_REGISTRY`. After computing the requested `tier` (from `task.model_tier` or `complexity_score`), it applies the **hard** cap:

```
const cap = registry[cli].maxTier
if (cap) tier = minTier(tier, cap)   // by ordering simple<moderate<complex<expert
```

So an expert task assigned to `pi-qwen-coder` (`maxTier: moderate`) resolves the `moderate` invocation. Tier fallback to the alias's own `simple` is unchanged. The clamp is the safety net regardless of routing decisions.

### 4. Validation (`validateAliases`, folded into `validateConfig`)

New `validateAliases(config, errors, warnings)`. Errors on:

- alias name colliding with a built-in (`Object.hasOwn(DEFAULT_REGISTRY, name)`) — *use `overrides` to tune built-ins, `aliases` to add new ones*.
- `extends` referencing a non-built-in (and no `binary` provided to stand alone).
- alias→alias `extends`.
- `models` missing the `simple` anchor (reuse `validateModels`).
- `maxTier` not in the tier vocabulary.
- any invocation missing `.ultraswarm-prompt.txt` (reuse `validateInvocation`).

The existing "unknown CLI" warnings for `enabled` and `overrides` start consulting the effective-registry keys, so listing an alias in `enabled` no longer warns.

### 5. Worker wiring (`lib/workers/adapters.mjs`)

- `WorkerManager` builds adapters from **effective-registry** keys, not `Object.keys(DEFAULT_REGISTRY)`.
- `ShellWorkerAdapter` resolves `binary` from the effective registry (`registry[name].binary ?? name`), so an alias inherits its base's binary.
- `capabilities()` resolves `CAPABILITIES[name] ?? CAPABILITIES[base] ?? default`, where `base` is the alias's `extends` target — so `pi-qwen-coder` inherits `pi`'s strengths unless it declares its own `capabilities`.

### 6. Runner routing (`lib/routing.mjs`)

`routeTask` enumerates effective-registry keys (`names = enabled?.length ? enabled : Object.keys(effectiveRegistry)`), so aliases compete for unassigned tasks and explicit `task.cli = "pi-qwen-coder"` validates against `enabled`. Capabilities come from `manager.get(name).capabilities()`, already alias-aware via §5.

### 7. Decomposition roster (`lib/orchestrator/decompose.mjs`)

`ROSTER` and the `cli` enum become functions of the effective registry (pass `config`/registry into `decompose`). Each alias is listed with its `maxTier` annotation as a soft nudge:

```
pi-qwen-coder (local coding, small refactors, unit tests; max tier: moderate)
```

This complements the hard clamp in §3 — the brain prefers other CLIs for hard work; the clamp guarantees safety if it doesn't.

### 8. CLI surfaces (`bin/cli.mjs`)

- `enabled` defaults to effective-registry keys (so aliases are allowed when `enabled` is omitted).
- `doctor` / `workers` / `explain-routing` enumerate the effective registry, so aliases show up in health/capability/routing output.

## Scope / Blast Radius

**Touched:** `lib/router.mjs` (new `buildRegistry`, `validateAliases`, `maxTier` clamp), `lib/workers/adapters.mjs`, `lib/routing.mjs`, `lib/orchestrator/decompose.mjs`, `bin/cli.mjs`, plus their `*.test.mjs`. Docs: `ultraswarm.config.advanced.json`, `README.md`, `skills/ultraswarm/SKILL.md` (one line), `CHANGELOG.md`, `.claude-plugin/plugin.json` (**version bump** — per project memory the plugin cache is version-keyed; without a bump edits don't reach `/ultraswarm`).

**Untouched / unchanged behavior:** `DEFAULT_REGISTRY` stays frozen and identical. With no `aliases` configured, the effective registry equals `DEFAULT_REGISTRY` and every consumer behaves exactly as today — this is a strictly additive, opt-in feature.

## Verification / Success Criteria

1. **No-config parity:** with no `aliases`, `buildRegistry(config)` deep-equals `DEFAULT_REGISTRY`; the full existing suite passes unchanged.
2. **Resolution:** an alias with `extends: "pi"` inherits `binary`/`timeoutMs`/`effortFlags`/`capabilities`; its `models` are used verbatim; an undefined tier falls back to the alias's `simple`, never to `pi`'s tier.
3. **maxTier clamp:** `resolveRoute` for an `expert` task on a `maxTier: moderate` alias returns the `moderate` invocation/model.
4. **Validation:** each of the six error conditions in §4 is asserted; a well-formed alias yields `{ valid: true }`.
5. **Worker:** `WorkerManager` creates an adapter for the alias; `probe()` shells the inherited binary; `capabilities()` reflects inheritance and override.
6. **Routing:** `routeTask` can select the alias for a matching task and rejects it when `enabled` excludes it.
7. **Roster:** the decomposition prompt lists the alias with its `maxTier` annotation.
8. **End-to-end:** a config defining `pi-qwen-coder` + `pi-deepseek-docs` plans, routes, and (with the binaries present) executes against the right local models.
