# Portable Host Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone Node runner (`bin/ultraswarm.mjs` + `lib/`) so Codex CLI, Grok CLI, or a bare shell can host the ultraswarm swarm, while Claude Code + the `Workflow` tool stays the primary host and the orchestrator brain runs on Anthropic models.

**Architecture:** The **host** (Codex/Grok/Claude Code) decomposes the task — it has repo access — and produces a validated **plan JSON**. The **runner** validates that plan and owns everything after: compute dependency waves → implement (subprocess, no model) + QA cascade (Anthropic brain) → merge each wave (gate after each) → report + cleanup. A host-agnostic **pure core** (the existing `scripts/router.mjs`, plus extracted prompts and orchestration algorithms) receives its engine primitives by dependency injection; Claude Code supplies native `Workflow` versions, the standalone runner supplies `lib/engine.mjs` and `lib/llm/anthropic.mjs`.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test`, `node:child_process` (git + worker CLIs), `@anthropic-ai/sdk` (brain), `ajv` (schema validation). Design source of truth: [`docs/specs/2026-06-12-portable-host-runner-design.md`](../specs/2026-06-12-portable-host-runner-design.md).

---

## Dependency & infra decision (read first)

The repo is currently **zero-dependency** (no `package.json`; scripts run via `node --test` + builtins). This plan ends that: the brain needs the official Anthropic SDK (per `claude-api` guidance — do not hand-roll the HTTP) and validation uses `ajv`. Phase A adds `package.json`, `.gitignore`, and an `npm ci` CI step. **All tests use a `MockLlmClient` + a fake worker CLI + throwaway git repos — no real API key, network, or spend in CI.**

## File structure

| File | Responsibility |
|---|---|
| `package.json` | deps (`@anthropic-ai/sdk`, `ajv`), test script |
| `lib/prompts.mjs` | **shared** prompt templates + QA schemas, lifted from `SKILL.md` |
| `lib/plan-schema.mjs` | `PLAN_SCHEMA` + `validatePlan()` — the host→runner input contract |
| `lib/engine.mjs` | Node `parallel`/`pipeline`/`phase`/`log` + concurrency limiter |
| `lib/validate.mjs` | ajv validate + retry wrapper around a raw model call |
| `lib/llm/client.mjs` | `LlmClient` interface + `MockLlmClient` |
| `lib/llm/anthropic.mjs` | Anthropic adapter, **per-model request shape** |
| `lib/llm/brain-router.mjs` | abstract tier → provider/model |
| `lib/orchestrator/implement.mjs` | impl wrapper: worktree + worker subprocess + gates (no model) |
| `lib/orchestrator/waves.mjs` | topological wave computation + cycle/intra-wave guard |
| `lib/orchestrator/merge.mjs` | sequential wave merge, gate after each, conflict → fail-loud (brain resolution = later) |
| `lib/orchestrator/report.mjs` | report + worktree cleanup |
| `lib/orchestrator/runner.mjs` | drives waves → implement+QA → merge → report |
| `lib/orchestrator/core.mjs` | (Phase F) full QA cascade + competition, lifted from `SKILL.md` |
| `lib/orchestrator/decompose.mjs` | bare-shell fallback: single brain call → plan JSON |
| `lib/journal.mjs` | per-run JSONL journal + replay, keyed on label + prompt-hash |
| `bin/ultraswarm.mjs` | CLI: `--plan-file <json>` \| `--decompose "<task>"`, `--yes`, `--resume` |
| `hosts/codex/`, `hosts/grok/` | launchers: host decomposes → writes plan.json → execs runner |
| `scripts/router.mjs` | **reused unchanged** |

---

## Phase A — Foundation

### Task A1: package.json, deps, CI

**Files:** Create `package.json`, `.gitignore`; Modify `.github/workflows/validate.yml`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ultraswarm",
  "version": "2.3.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" },
  "dependencies": { "@anthropic-ai/sdk": "*", "ajv": "^8.17.1" },
  "engines": { "node": ">=20" }
}
```

> After `npm install`, pin `@anthropic-ai/sdk` to the installed major (`npm view @anthropic-ai/sdk version`); do not leave `*`.

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.ultraswarm/
*.log
```

- [ ] **Step 3: Install**

Run: `npm install`
Expected: creates `node_modules/` + `package-lock.json`, no errors. Then edit `package.json` to pin the SDK version printed by `npm view @anthropic-ai/sdk version`.

- [ ] **Step 4: CI installs deps**

In `.github/workflows/validate.yml`: set `node-version: 22`, and after `setup-node` add:

```yaml
      - name: Install dependencies
        run: npm ci
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore .github/workflows/validate.yml
git commit -m "chore: add package.json + deps (@anthropic-ai/sdk, ajv) and CI npm ci"
```

### Task A2: Extract shared prompts + schemas from SKILL.md

**Files:** Create `lib/prompts.mjs`, `lib/prompts.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IMPL_SCHEMA, enhancedImplPrompt, expertLensPrompt, EXPERT_LENSES } from './prompts.mjs'

test('IMPL_SCHEMA requires the fields the runner consumes', () => {
  for (const f of ['status', 'gate_results', 'cli_tokens', 'worktree', 'branch']) {
    assert.ok(IMPL_SCHEMA.required.includes(f), `missing ${f}`)
  }
})

test('enhancedImplPrompt embeds the resolved command and worktree path', () => {
  const cfg = { repo: '/r', baseBranch: 'HEAD', worktreeRoot: '/w', repoName: 'r',
    gates: [{ name: 'test', cmd: 'npm test' }] }
  const t = { id: 't1', description: 'd', files: ['a.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const s = enhancedImplPrompt(cfg, t, 'codex', 1, [], 'codex exec -m gpt-5.4-mini ...', 900000)
  assert.match(s, /codex exec -m gpt-5\.4-mini/)
  assert.match(s, /\/w\/r-us-t1-codex/)
})

test('EXPERT_LENSES are correctness/security/regression and the security lens prompt sets polarity', () => {
  assert.deepEqual(EXPERT_LENSES, ['correctness', 'security', 'regression'])
  const s = expertLensPrompt('security', { id: 't1', description: 'd', complexity_score: 60 },
    { worktree: '/w/x', branch: 'b', model_used: 'm' }, 'HEAD')
  assert.match(s, /refuted=true ONLY if/)
})
```

- [ ] **Step 2: Run test — expect FAIL** (`Cannot find module './prompts.mjs'`)

Run: `node --test lib/prompts.test.mjs`

- [ ] **Step 3: Create `lib/prompts.mjs`**

Copy the four schema consts (`IMPL_SCHEMA`, `ENHANCED_REVIEW_SCHEMA`, `ADAPTIVE_JUDGE_SCHEMA`, `EXPERT_VERDICT_SCHEMA`) and the four prompt builders (`enhancedImplPrompt`, `adaptiveReviewPrompt`, `intelligentJudgePrompt`, `expertLensPrompt`) out of the ```js block in `skills/ultraswarm/SKILL.md` **verbatim**, with these mechanical changes so they are pure (no closure over Workflow globals):
- Builders take `cfg` as an explicit first parameter; `enhancedImplPrompt` also takes `command` and `timeoutMs`; `expertLensPrompt` takes `baseBranch`. New signatures:
  `enhancedImplPrompt(cfg, t, cli, attempt, feedback, command, timeoutMs)`,
  `adaptiveReviewPrompt(cfg, t, impl)`, `intelligentJudgePrompt(cfg, t, impl)`,
  `expertLensPrompt(lens, t, impl, baseBranch)`.
- Inline the `wt`/`br`/`gateList` helpers as locals inside each builder (currently module-scope in the embedded JS).
- `export` all four schemas, all four builders, and: `export const EXPERT_LENSES = ['correctness','security','regression']`, `export const VALID_MODEL_TIERS = ['simple','moderate','complex','expert']`, `export const VALID_CLAUDE_MODELS = ['haiku','sonnet','opus','fable']`.

- [ ] **Step 4: Run test — expect PASS (3 tests)**

Run: `node --test lib/prompts.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add lib/prompts.mjs lib/prompts.test.mjs
git commit -m "feat: extract shared prompt templates + schemas into lib/prompts.mjs"
```

---

## Phase B — Engine + validation

### Task B1: Node engine primitives

**Files:** Create `lib/engine.mjs`, `lib/engine.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parallel, pipeline, makeLimiter } from './engine.mjs'

test('parallel resolves all and maps a throwing thunk to null', async () => {
  const r = await parallel([() => Promise.resolve(1), () => { throw new Error('x') }, async () => 3])
  assert.deepEqual(r, [1, null, 3])
})

test('pipeline runs each item through all stages, no barrier', async () => {
  assert.deepEqual(await pipeline([1, 2], (v) => v + 1, (v) => v * 10), [20, 30])
})

test('pipeline passes (prev, originalItem, index) — index correct for duplicate primitives', async () => {
  const r = await pipeline([2, 2], (_v, _item, idx) => idx)
  assert.deepEqual(r, [0, 1])   // indexOf would wrongly give [0, 0]
})

test('limiter caps concurrency', async () => {
  let active = 0, peak = 0
  const limit = makeLimiter(2)
  const job = () => limit(async () => { active++; peak = Math.max(peak, active)
    await new Promise(r => setTimeout(r, 5)); active--; return 1 })
  await Promise.all([job(), job(), job(), job()])
  assert.ok(peak <= 2, `peak ${peak} must be <= 2`)
})
```

- [ ] **Step 2: Run test — expect FAIL** (`Cannot find module './engine.mjs'`)

- [ ] **Step 3: Create `lib/engine.mjs`**

```js
import os from 'node:os'

export function makeLimiter(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next() })
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next() })
}

const globalLimit = makeLimiter(Math.max(1, Math.min(16, os.cpus().length - 2)))

export async function parallel(thunks) {
  return Promise.all(thunks.map((t) => globalLimit(t).catch(() => null)))
}

export async function pipeline(items, ...stages) {
  return Promise.all(items.map((item, idx) => globalLimit(async () => {
    let v = item
    for (let i = 0; i < stages.length; i++) {
      try { v = await stages[i](v, item, idx) } catch { return null }
    }
    return v
  })))
}

export function phase(title) { process.stderr.write(`\n=== ${title} ===\n`) }
export function log(message) { process.stderr.write(`· ${message}\n`) }
```

- [ ] **Step 4: Run test — expect PASS (4 tests)**

- [ ] **Step 5: Commit**

```bash
git add lib/engine.mjs lib/engine.test.mjs
git commit -m "feat: Node engine primitives (parallel/pipeline/phase/log + limiter)"
```

### Task B2: Schema validation + retry

**Files:** Create `lib/validate.mjs`, `lib/validate.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateOrThrow, completeWithSchema } from './validate.mjs'

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }

test('validateOrThrow accepts conforming, throws on non-conforming', () => {
  assert.deepEqual(validateOrThrow({ ok: true }, SCHEMA), { ok: true })
  assert.throws(() => validateOrThrow({ nope: 1 }, SCHEMA), /required/)
})

test('completeWithSchema retries once then succeeds', async () => {
  let n = 0
  const raw = async () => (++n === 1 ? { object: { nope: 1 }, usage: {} } : { object: { ok: true }, usage: {} })
  const r = await completeWithSchema(raw, { schema: SCHEMA, maxRetries: 2 })
  assert.deepEqual(r.object, { ok: true })
  assert.equal(n, 2)
})

test('completeWithSchema returns null after exhausting retries', async () => {
  const r = await completeWithSchema(async () => ({ object: { nope: 1 }, usage: {} }), { schema: SCHEMA, maxRetries: 1 })
  assert.equal(r, null)
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/validate.mjs`**

```js
import Ajv from 'ajv'
const ajv = new Ajv({ allErrors: true, strict: false })

export function validateOrThrow(object, schema) {
  const v = ajv.compile(schema)
  if (!v(object)) throw new Error(`schema validation failed: ${ajv.errorsText(v.errors)}`)
  return object
}

// rawComplete(feedback?) -> { object, usage }. Retries feeding the validation error back.
export async function completeWithSchema(rawComplete, { schema, maxRetries = 2 }) {
  let feedback = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { object, usage } = await rawComplete(feedback)
    try { validateOrThrow(object, schema); return { object, usage } }
    catch (e) { feedback = `Your previous output was invalid: ${e.message}. Return JSON matching the schema exactly.` }
  }
  return null
}
```

- [ ] **Step 4: Run test — expect PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add lib/validate.mjs lib/validate.test.mjs
git commit -m "feat: ajv schema validation + retry wrapper"
```

---

## Phase C — Brain (Anthropic primary)

### Task C1: LlmClient interface + MockLlmClient

**Files:** Create `lib/llm/client.mjs`, `lib/llm/client.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockLlmClient } from './client.mjs'

test('MockLlmClient routes by label and records calls', async () => {
  const c = new MockLlmClient((label) =>
    label.startsWith('review') ? { object: { approve: true }, usage: {} } : { object: {}, usage: {} })
  const r = await c.complete({ label: 'review:t1', prompt: 'p', model: 'haiku' })
  assert.deepEqual(r.object, { approve: true })
  assert.equal(c.calls[0].model, 'haiku')
  assert.equal(c.calls[0].label, 'review:t1')
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/llm/client.mjs`**

```js
// LlmClient.complete({ system?, prompt, schema?, model, effort?, label? }) -> { object, usage }
export class MockLlmClient {
  constructor(behavior) { this.behavior = behavior; this.calls = [] }
  async complete(opts) {
    this.calls.push({ label: opts.label || '', model: opts.model, prompt: opts.prompt })
    return this.behavior(opts.label || '', opts)
  }
}
```

- [ ] **Step 4: Run test — expect PASS (1 test)**

- [ ] **Step 5: Commit**

```bash
git add lib/llm/client.mjs lib/llm/client.test.mjs
git commit -m "feat: LlmClient interface + MockLlmClient"
```

### Task C2: Brain-router

**Files:** Create `lib/llm/brain-router.mjs`, `lib/llm/brain-router.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBrainModel } from './brain-router.mjs'

test('default tiers map to current Anthropic ids', () => {
  assert.deepEqual(resolveBrainModel('haiku'), { provider: 'anthropic', model: 'claude-haiku-4-5' })
  assert.deepEqual(resolveBrainModel('opus'),  { provider: 'anthropic', model: 'claude-opus-4-8' })
  assert.deepEqual(resolveBrainModel('fable'), { provider: 'anthropic', model: 'claude-fable-5' })
})

test('config can override a tier model', () => {
  const cfg = { intelligence: { modelRouting: { models: { sonnet: 'claude-sonnet-4-6' } } } }
  assert.equal(resolveBrainModel('sonnet', cfg).model, 'claude-sonnet-4-6')
})

test('unknown tier throws', () => {
  assert.throws(() => resolveBrainModel('mega'), /Unknown brain tier/)
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/llm/brain-router.mjs`**

```js
const DEFAULTS = Object.freeze({
  haiku:  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  opus:   { provider: 'anthropic', model: 'claude-opus-4-8' },
  fable:  { provider: 'anthropic', model: 'claude-fable-5' },
})

export function resolveBrainModel(tier, config = {}) {
  const base = DEFAULTS[tier]
  if (!base) throw new Error(`Unknown brain tier "${tier}". Allowed: ${Object.keys(DEFAULTS).join(', ')}`)
  const override = config.intelligence?.modelRouting?.models?.[tier]
  return override ? { ...base, model: override } : { ...base }
}
```

- [ ] **Step 4: Run test — expect PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add lib/llm/brain-router.mjs lib/llm/brain-router.test.mjs
git commit -m "feat: brain-router (abstract tier -> provider/model)"
```

### Task C3: Anthropic adapter (per-model request shape)

The adapter must shape the request by model capability: `output_config.effort` and adaptive
thinking are valid on **Sonnet 4.6 / Opus / Fable** but **400 on Haiku 4.5**; structured output
(`output_config.format`) is valid on all. A unit test covers the request-shaping logic with a
fake SDK; a key-gated smoke script verifies the real binding.

**Files:** Create `lib/llm/anthropic.mjs`, `lib/llm/anthropic.test.mjs`, `scripts/smoke-brain.mjs`

- [ ] **Step 1: Write the failing test (request-shaping, injected fake client)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest } from './anthropic.mjs'

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }

test('haiku request omits effort and thinking (they 400 on haiku), keeps structured format', () => {
  const req = buildRequest({ prompt: 'p', schema: SCHEMA, model: 'claude-haiku-4-5', effort: 'high' })
  assert.equal(req.thinking, undefined)
  assert.equal(req.output_config.effort, undefined)
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: SCHEMA })
})

test('opus request includes adaptive thinking and effort', () => {
  const req = buildRequest({ prompt: 'p', schema: SCHEMA, model: 'claude-opus-4-8', effort: 'high' })
  assert.deepEqual(req.thinking, { type: 'adaptive' })
  assert.equal(req.output_config.effort, 'high')
})
```

- [ ] **Step 2: Run test — expect FAIL** (`buildRequest` not exported)

- [ ] **Step 3: Create `lib/llm/anthropic.mjs`**

```js
import Anthropic from '@anthropic-ai/sdk'

// Models that accept adaptive thinking + output_config.effort. Haiku 4.5 rejects both (400).
const THINKING_MODELS = new Set(['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5'])

export function buildRequest({ system, prompt, schema, model, effort = 'high' }) {
  const req = { model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }], output_config: {} }
  if (system) req.system = system
  if (THINKING_MODELS.has(model)) { req.thinking = { type: 'adaptive' }; req.output_config.effort = effort }
  if (schema) req.output_config.format = { type: 'json_schema', schema }
  return req
}

export class AnthropicClient {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for the standalone runner brain')
    this.client = new Anthropic({ apiKey })
  }
  async complete(opts) {
    const res = await this.client.messages.create(buildRequest(opts))
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    return { object: opts.schema ? JSON.parse(text) : text, usage: res.usage }
  }
}
```

- [ ] **Step 4: Run test — expect PASS (2 tests)**

Run: `node --test lib/llm/anthropic.test.mjs`

- [ ] **Step 5: Create `scripts/smoke-brain.mjs` and verify the real binding (only with a key)**

```js
import { AnthropicClient } from '../lib/llm/anthropic.mjs'
const c = new AnthropicClient()
const r = await c.complete({ prompt: 'Return JSON {"ok": true}.', model: 'claude-haiku-4-5',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } })
console.log('object:', r.object, 'usage:', r.usage)
```

Run: `ANTHROPIC_API_KEY=... node scripts/smoke-brain.mjs`
Expected: prints `object: { ok: true }`. If the SDK rejects `output_config.format`, fix the binding here per the installed SDK's docs (verification gate — do not guess).

- [ ] **Step 6: Commit**

```bash
git add lib/llm/anthropic.mjs lib/llm/anthropic.test.mjs scripts/smoke-brain.mjs
git commit -m "feat: Anthropic brain adapter with per-model request shaping (+ smoke)"
```

---

## Phase D — Plan contract + impl wrapper

### Task D1: Plan schema + validation

**Files:** Create `lib/plan-schema.mjs`, `lib/plan-schema.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlan } from './plan-schema.mjs'

const task = (over = {}) => ({ id: 't1', description: 'd', files: ['a.js'], cli: 'codex',
  model_tier: 'simple', complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go', ...over })

test('valid plan passes', () => {
  const r = validatePlan({ tasks: [task()] })
  assert.equal(r.valid, true)
  assert.deepEqual(r.errors, [])
})

test('unknown cli is rejected', () => {
  const r = validatePlan({ tasks: [task({ cli: 'rm -rf' })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /cli/.test(e)))
})

test('invalid model_tier is rejected', () => {
  assert.equal(validatePlan({ tasks: [task({ model_tier: 'mega' })] }).valid, false)
})

test('a dependency cycle is rejected', () => {
  const r = validatePlan({ tasks: [task({ id: 'a', dependencies: ['b'] }), task({ id: 'b', dependencies: ['a'] })] })
  assert.equal(r.valid, false)
  assert.ok(r.errors.some((e) => /cycle/.test(e)))
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/plan-schema.mjs`**

```js
import Ajv from 'ajv'
import { DEFAULT_REGISTRY } from '../scripts/router.mjs'
import { VALID_MODEL_TIERS } from './prompts.mjs'

const ajv = new Ajv({ allErrors: true, strict: false })

export const PLAN_SCHEMA = {
  type: 'object',
  required: ['tasks'],
  properties: {
    tasks: { type: 'array', minItems: 1, items: {
      type: 'object',
      required: ['id', 'description', 'files', 'cli', 'model_tier', 'complexity_score', 'risk', 'dependencies', 'prompt'],
      properties: {
        id: { type: 'string' }, description: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        cli: { type: 'string' }, model_tier: { type: 'string' },
        complexity_score: { type: 'number' }, risk: { type: 'string' },
        dependencies: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' },
      },
    } },
  },
}

function hasCycle(tasks) {
  const ids = new Set(tasks.map((t) => t.id))
  const deps = new Map(tasks.map((t) => [t.id, (t.dependencies || []).filter((d) => ids.has(d))]))
  const state = new Map()   // id -> 'visiting' | 'done'
  const visit = (id) => {
    if (state.get(id) === 'done') return false
    if (state.get(id) === 'visiting') return true
    state.set(id, 'visiting')
    for (const d of deps.get(id) || []) if (visit(d)) return true
    state.set(id, 'done')
    return false
  }
  return tasks.some((t) => visit(t.id))
}

export function validatePlan(plan) {
  const errors = []
  const validate = ajv.compile(PLAN_SCHEMA)
  if (!validate(plan)) return { valid: false, errors: [ajv.errorsText(validate.errors)] }
  for (const t of plan.tasks) {
    if (!Object.hasOwn(DEFAULT_REGISTRY, t.cli)) errors.push(`task ${t.id}: unknown cli "${t.cli}"`)
    if (!VALID_MODEL_TIERS.includes(t.model_tier)) errors.push(`task ${t.id}: invalid model_tier "${t.model_tier}"`)
  }
  if (hasCycle(plan.tasks)) errors.push('dependency cycle detected in the task graph')
  return { valid: errors.length === 0, errors }
}
```

- [ ] **Step 4: Run test — expect PASS (4 tests)**

- [ ] **Step 5: Commit**

```bash
git add lib/plan-schema.mjs lib/plan-schema.test.mjs
git commit -m "feat: plan-schema contract (validate host plan: cli/tier/cycle)"
```

### Task D2: Subprocess impl wrapper

**Files:** Create `lib/orchestrator/implement.mjs`, `lib/orchestrator/implement.test.mjs`, `test/fixtures/fake-cli.mjs`

- [ ] **Step 1: Create the fake worker CLI fixture**

```js
#!/usr/bin/env node
// test/fixtures/fake-cli.mjs — pretends to be a worker CLI: writes a file, prints a token line.
import fs from 'node:fs'
fs.writeFileSync('generated.js', 'export const x = 1\n')
console.log('tokens used: 1234')
```

- [ ] **Step 2: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runImplementation } from './implement.mjs'

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-impl-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed',
    { cwd: dir, shell: '/bin/bash' })
  return dir
}
const fakeCli = path.resolve('test/fixtures/fake-cli.mjs')

test('runImplementation: worktree + CLI + gates → ok, tokens parsed', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'present', cmd: 'test -f generated.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 't1', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'ok')
  assert.ok(r.files_changed.includes('generated.js'))
  assert.equal(r.gate_results[0].pass, true)
  assert.equal(r.cli_tokens, 1234)
})

test('runImplementation: failing gate → gates_failed', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: 'HEAD', worktreeRoot,
    gates: [{ name: 'fail', cmd: 'test -f nope.js' }], registry: { codex: `node ${fakeCli}` } }
  const t = { id: 't2', description: 'd', files: ['generated.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const r = await runImplementation(cfg, t, 'codex', 1, [])
  assert.equal(r.status, 'gates_failed')
})
```

- [ ] **Step 3: Run test — expect FAIL**

- [ ] **Step 4: Create `lib/orchestrator/implement.mjs`**

```js
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import path from 'node:path'
import { enhancedImplPrompt } from '../prompts.mjs'

const wtPath = (cfg, t, cli) => path.join(cfg.worktreeRoot, `${cfg.repoName}-us-${t.id}-${cli}`)
const branchName = (t, cli) => `ultraswarm/${t.id}-${cli}`
const sh = (cmd, cwd) => execSync(cmd, { cwd, shell: '/bin/bash', encoding: 'utf8' })

function resolveCommand(cfg, t, cli) {
  const entry = cfg.registry[cli]
  return typeof entry === 'string' ? entry : (entry[t.model_tier] || entry.simple)
}
const parseTokens = (out) => { const m = (out || '').match(/tokens?\s*(?:used)?[:\s]+(\d+)/i); return m ? Number(m[1]) : 0 }
const impl = (status, worktree, branch, files_changed, gate_results, summary, cli_tokens) =>
  ({ status, worktree, branch, files_changed, gate_results, summary, concerns: [], cli_tokens, model_used: 'external', complexity_achieved: 0 })

export async function runImplementation(cfg, t, cli, attempt, feedback) {
  const wt = wtPath(cfg, t, cli), br = branchName(t, cli)
  const command = resolveCommand(cfg, t, cli)
  const timeoutMs = cfg.timeouts?.[`${cli}-${t.model_tier}`] ?? cfg.timeouts?.[cli] ?? cfg.timeoutMs ?? 600000
  try {
    if (!fs.existsSync(wt)) sh(`git worktree add ${wt} -b ${br} ${cfg.baseBranch}`, cfg.repo)
    fs.writeFileSync(path.join(wt, '.ultraswarm-prompt.txt'),
      enhancedImplPrompt(cfg, t, cli, attempt, feedback, command, timeoutMs))
    let out = ''
    try { out = execSync(command, { cwd: wt, shell: '/bin/bash', encoding: 'utf8', timeout: timeoutMs }) }
    catch (e) { return impl('cli_failed', wt, br, [], [], `CLI failed: ${e.message}`, parseTokens(e.stdout)) }
    const gate_results = cfg.gates.map((g) => {
      try { sh(g.cmd, wt); return { name: g.name, pass: true } }
      catch (e) { return { name: g.name, pass: false, detail: String(e.stderr || e.message).slice(0, 500) } }
    })
    fs.rmSync(path.join(wt, '.ultraswarm-prompt.txt'), { force: true })
    const changed = sh('git status --porcelain', wt).split('\n').filter(Boolean).map((l) => l.slice(3))
    sh(`git add -A && git commit -q -m "ultraswarm: ${t.id}/${t.model_tier} attempt ${attempt}" || true`, wt)
    const status = gate_results.every((g) => g.pass) ? 'ok' : 'gates_failed'
    return impl(status, wt, br, changed, gate_results, `attempt ${attempt} on ${cli}`, parseTokens(out))
  } catch (e) { return impl('cli_failed', wt, br, [], [], `wrapper error: ${e.message}`, 0) }
}
```

- [ ] **Step 5: Run test — expect PASS (2 tests)**

- [ ] **Step 6: Commit**

```bash
git add lib/orchestrator/implement.mjs lib/orchestrator/implement.test.mjs test/fixtures/fake-cli.mjs
git commit -m "feat: subprocess impl wrapper (worktree + worker CLI + gates, no model)"
```

---

## Phase E — Proof-of-life: waves → implement+QA → merge → report (MILESTONE)

This delivers a genuinely end-to-end routine swarm — a one-task plan that implements, passes QA,
and **merges to the working branch** — runnable from a bare shell with a mock brain.

### Task E1: Wave computation

**Files:** Create `lib/orchestrator/waves.mjs`, `lib/orchestrator/waves.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeWaves } from './waves.mjs'
const t = (id, deps = []) => ({ id, dependencies: deps })

test('independent tasks form one wave', () => {
  assert.deepEqual(computeWaves([t('a'), t('b')]).map((w) => w.map((x) => x.id)), [['a', 'b']])
})

test('a→b→c forms three ordered waves', () => {
  assert.deepEqual(computeWaves([t('c', ['b']), t('a'), t('b', ['a'])]).map((w) => w.map((x) => x.id)),
    [['a'], ['b'], ['c']])
})

test('a cycle throws', () => {
  assert.throws(() => computeWaves([t('a', ['b']), t('b', ['a'])]), /cycle/)
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/orchestrator/waves.mjs`**

```js
// Topologically group tasks into ordered waves over their in-plan dependency edges.
// Wave 1 = tasks with no in-plan deps; wave N = tasks whose deps are all in earlier waves.
export function computeWaves(tasks) {
  const ids = new Set(tasks.map((t) => t.id))
  const remaining = new Map(tasks.map((t) => [t.id, (t.dependencies || []).filter((d) => ids.has(d))]))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const placed = new Set()
  const waves = []
  while (placed.size < tasks.length) {
    const wave = [...remaining.keys()].filter((id) => !placed.has(id) && remaining.get(id).every((d) => placed.has(d)))
    if (wave.length === 0) throw new Error('dependency cycle detected — cannot compute waves')
    wave.forEach((id) => placed.add(id))
    waves.push(wave.map((id) => byId.get(id)))
  }
  return waves
}
```

- [ ] **Step 4: Run test — expect PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add lib/orchestrator/waves.mjs lib/orchestrator/waves.test.mjs
git commit -m "feat: topological wave computation + cycle rejection"
```

### Task E2: Wave merge

**Files:** Create `lib/orchestrator/merge.mjs`, `lib/orchestrator/merge.test.mjs`

Note: conflict resolution via a `sonnet` brain call is deferred to a later task. For now, a clean
merge commits; a conflict is **failed loud** (`git merge --abort`, marked unmerged), never blended.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { mergeWave } from './merge.mjs'

function repoWithBranch(file, content) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-merge-'))
  const run = (c) => execSync(c, { cwd: repo, shell: '/bin/bash' })
  run('git init -q && git config user.email t@t && git config user.name t && echo base > base.txt && git add -A && git commit -q -m seed')
  run(`git checkout -q -b ultraswarm/t1-codex && echo "${content}" > ${file} && git add -A && git commit -q -m work && git checkout -q -`)
  return repo
}

test('mergeWave squash-merges an approved branch and gates pass → merged', async () => {
  const repo = repoWithBranch('new.txt', 'hello')
  const cfg = { repo, gates: [{ name: 'present', cmd: 'test -f new.txt' }] }
  const approved = [{ task: 't1', cli: 'codex', impl: { branch: 'ultraswarm/t1-codex' } }]
  const r = await mergeWave(cfg, null, approved)
  assert.deepEqual(r, [{ task: 't1', merged: true }])
  assert.ok(fs.existsSync(path.join(repo, 'new.txt')))
})

test('mergeWave rolls back when a post-merge gate regresses', async () => {
  const repo = repoWithBranch('new.txt', 'hello')
  const cfg = { repo, gates: [{ name: 'fail', cmd: 'test -f missing.txt' }] }
  const approved = [{ task: 't1', cli: 'codex', impl: { branch: 'ultraswarm/t1-codex' } }]
  const r = await mergeWave(cfg, null, approved)
  assert.equal(r[0].merged, false)
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/orchestrator/merge.mjs`**

```js
import { execSync } from 'node:child_process'
const sh = (cmd, cwd) => execSync(cmd, { cwd, shell: '/bin/bash', encoding: 'utf8' })
const tryGate = (cmd, cwd) => { try { sh(cmd, cwd); return true } catch { return false } }

// approved: [{ task, cli, impl: { branch } }]. Sequential, gate after each, never blend.
export async function mergeWave(cfg, agent, approved) {
  const results = []
  for (const r of approved) {
    try {
      sh(`git merge --squash ${r.impl.branch}`, cfg.repo)
    } catch {
      sh('git merge --abort || git reset --hard HEAD', cfg.repo)
      results.push({ task: r.task, merged: false, reason: 'conflict (needs resolution)' })
      continue
    }
    const ok = cfg.gates.every((g) => tryGate(g.cmd, cfg.repo))
    if (!ok) { sh('git reset --hard HEAD', cfg.repo); results.push({ task: r.task, merged: false, reason: 'post-merge gate regression' }); continue }
    sh(`git add -A && git commit -q -m "feat: ${r.task} (ultraswarm: ${r.cli})"`, cfg.repo)
    results.push({ task: r.task, merged: true })
  }
  return results
}
```

- [ ] **Step 4: Run test — expect PASS (2 tests)**

- [ ] **Step 5: Commit**

```bash
git add lib/orchestrator/merge.mjs lib/orchestrator/merge.test.mjs
git commit -m "feat: sequential wave merge with gate-after-each + rollback"
```

### Task E3: Report + worktree cleanup

**Files:** Create `lib/orchestrator/report.mjs`, `lib/orchestrator/report.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport } from './report.mjs'

test('buildReport summarizes merged, failed, and external tokens', () => {
  const r = buildReport({
    merged: [{ task: 't1', merged: true }, { task: 't2', merged: false, reason: 'post-merge gate regression' }],
    failed: ['t3'], externalTokens: 1234,
  })
  assert.match(r, /t1/); assert.match(r, /t3/); assert.match(r, /1234/)
  assert.match(r, /post-merge gate regression/)
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/orchestrator/report.mjs`**

```js
import { execSync } from 'node:child_process'

export function buildReport({ merged, failed, externalTokens }) {
  const lines = ['# ultraswarm run report', '', '| task | status |', '|---|---|']
  for (const m of merged) lines.push(`| ${m.task} | ${m.merged ? 'merged ✓' : `NOT merged — ${m.reason}`} |`)
  for (const id of failed) lines.push(`| ${id} | FAILED (exhausted) |`)
  lines.push('', `External CLI tokens (best-effort): ~${externalTokens}`)
  return lines.join('\n')
}

// Remove ultraswarm worktrees + branches after the report.
export function cleanup(cfg) {
  try {
    const list = execSync('git worktree list --porcelain', { cwd: cfg.repo, encoding: 'utf8' })
    for (const line of list.split('\n')) {
      if (line.startsWith('worktree ') && line.includes(`${cfg.repoName}-us-`)) {
        const p = line.slice('worktree '.length)
        try { execSync(`git worktree remove --force ${p}`, { cwd: cfg.repo }) } catch { /* best-effort */ }
      }
    }
    execSync(`git branch --list 'ultraswarm/*' | xargs -r git branch -D`, { cwd: cfg.repo, shell: '/bin/bash' })
  } catch { /* cleanup is best-effort; never fail the run on it */ }
}
```

- [ ] **Step 4: Run test — expect PASS (1 test)**

- [ ] **Step 5: Commit**

```bash
git add lib/orchestrator/report.mjs lib/orchestrator/report.test.mjs
git commit -m "feat: run report + worktree cleanup sweep"
```

### Task E4: Runner — drive waves → implement+QA → merge → report

**Files:** Create `lib/orchestrator/runner.mjs`, `lib/orchestrator/runner.test.mjs`

This is the proof-of-life integration: validated plan → waves → per wave (implement + routine
review) → merge wave → advance base → report. (High-risk competition/adversarial lands in Phase F.)

- [ ] **Step 1: Write the failing test (mock brain + fake CLI + real git, asserts the file lands on the branch)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runSwarm } from './runner.mjs'
import { MockLlmClient } from '../llm/client.mjs'

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-run-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed',
    { cwd: dir, shell: '/bin/bash' })
  return dir
}
const fakeCli = path.resolve('test/fixtures/fake-cli.mjs')

test('runSwarm: one routine task implements, passes review, MERGES to branch', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: { codex: `node ${fakeCli}` }, alternates: { codex: 'codex' },
    tasks: [{ id: 't1', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient((label) => label.startsWith('review')
    ? { object: { approve: true, issues: [], quality_score: 90, complexity_assessment: 10 }, usage: {} }
    : { object: {}, usage: {} })
  const result = await runSwarm(cfg, brain)
  assert.equal(result.merged.filter((m) => m.merged).length, 1)
  assert.ok(fs.existsSync(path.join(repo, 'generated.js')), 'approved file landed on the working branch')
})

test('runSwarm: review rejection 3x → task tombstones, nothing merges', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: { codex: `node ${fakeCli}` }, alternates: { codex: 'codex' },
    tasks: [{ id: 't2', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient(() => ({ object: { approve: false, issues: ['bad'], quality_score: 10, complexity_assessment: 0 }, usage: {} }))
  const result = await runSwarm(cfg, brain)
  assert.deepEqual(result.failed, ['t2'])
  assert.equal(result.merged.length, 0)
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/orchestrator/runner.mjs`**

```js
import { execSync } from 'node:child_process'
import { pipeline, phase, log } from '../engine.mjs'
import { computeWaves } from './waves.mjs'
import { runImplementation } from './implement.mjs'
import { mergeWave } from './merge.mjs'
import { completeWithSchema } from '../validate.mjs'
import { adaptiveReviewPrompt, ENHANCED_REVIEW_SCHEMA } from '../prompts.mjs'

// Brain agent for review/judge/lens labels. Impl labels never reach here (see runRoutineTask).
function makeAgent(brain) {
  return async (prompt, { label, model, schema }) => {
    const r = await completeWithSchema(
      (fb) => brain.complete({ prompt: fb ? `${prompt}\n\n${fb}` : prompt, model, schema, label }),
      { schema, maxRetries: 2 })
    return r ? r.object : null
  }
}

async function reviewTask(cfg, agent, t, impl) {
  const model = t.complexity_score <= 30 ? 'haiku' : 'sonnet'
  const r = await agent(adaptiveReviewPrompt(cfg, t, impl), { label: `review:${t.id}`, model, schema: ENHANCED_REVIEW_SCHEMA })
  return r ? { approve: r.approve, issues: r.issues || [] } : { approve: false, issues: ['reviewer died'] }
}

async function runRoutineTask(cfg, agent, t) {
  let feedback = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    const impl = await runImplementation(cfg, t, t.cli, attempt, feedback)
    if (impl.status !== 'ok') { feedback = [...feedback, `attempt ${attempt}: ${impl.status} — ${impl.summary}`]; continue }
    const verdict = await reviewTask(cfg, agent, t, impl)
    if (verdict.approve) return { task: t.id, cli: t.cli, impl, attempts: attempt }
    feedback = [...feedback, ...verdict.issues]
    log(`${t.id}: attempt ${attempt} rejected (${verdict.issues.length} issues)`)
  }
  return { task: t.id, failed: true }
}

export async function runSwarm(cfg, brain) {
  const agent = makeAgent(brain)
  const waves = computeWaves(cfg.tasks)
  const merged = []
  const failed = []
  let externalTokens = 0
  let baseBranch = cfg.baseBranch
  for (let w = 0; w < waves.length; w++) {
    phase(`Wave ${w + 1}/${waves.length}`)
    const waveCfg = { ...cfg, baseBranch }
    const results = (await pipeline(waves[w], (t) => runRoutineTask(waveCfg, agent, t))).filter(Boolean)
    results.forEach((r) => { externalTokens += r.impl?.cli_tokens || 0 })
    const approved = results.filter((r) => !r.failed)
    failed.push(...results.filter((r) => r.failed).map((r) => r.task))
    merged.push(...(await mergeWave(waveCfg, agent, approved)))
    baseBranch = execSync('git rev-parse HEAD', { cwd: cfg.repo }).toString().trim()  // rebase next wave on merged HEAD
  }
  return { merged, failed, externalTokens }
}
```

- [ ] **Step 4: Run test — expect PASS (2 tests)**

- [ ] **Step 5: Commit**

```bash
git add lib/orchestrator/runner.mjs lib/orchestrator/runner.test.mjs
git commit -m "feat: runner drives waves -> implement+QA -> merge -> rebase (proof-of-life)"
```

### Task E5: CLI entrypoint (`--plan-file` primary, `--decompose` fallback)

**Files:** Create `bin/ultraswarm.mjs`, `bin/ultraswarm.test.mjs`, `lib/orchestrator/decompose.mjs`

- [ ] **Step 1: Write the failing test (config assembly + plan validation gate)**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRunConfig } from './ultraswarm.mjs'

test('buildRunConfig merges repo context with a validated plan', () => {
  const base = { repo: '/r', repoName: 'r', baseBranch: 'HEAD', worktreeRoot: '/w',
    gates: [{ name: 'test', cmd: 'npm test' }], registry: { codex: 'c' }, alternates: { codex: 'codex' } }
  const plan = { tasks: [{ id: 't1', description: 'd', files: ['a.js'], cli: 'codex', model_tier: 'simple',
    complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'p' }] }
  const cfg = buildRunConfig(base, plan)
  assert.equal(cfg.tasks.length, 1)
  assert.equal(cfg.repo, '/r')
})

test('buildRunConfig throws on an invalid plan (unknown cli)', () => {
  const base = { repo: '/r', repoName: 'r', baseBranch: 'HEAD', worktreeRoot: '/w', gates: [], registry: {}, alternates: {} }
  const plan = { tasks: [{ id: 't1', description: 'd', files: [], cli: 'evil', model_tier: 'simple',
    complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'p' }] }
  assert.throws(() => buildRunConfig(base, plan), /unknown cli/)
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/orchestrator/decompose.mjs` (bare-shell fallback)**

```js
import { completeWithSchema } from '../validate.mjs'
import { PLAN_SCHEMA } from '../plan-schema.mjs'

// Bare-shell fallback ONLY: single brain call, no repo exploration. Hosts should pass --plan-file.
export async function decompose(brain, task, repo, model) {
  const r = await completeWithSchema(
    (fb) => brain.complete({ model, schema: PLAN_SCHEMA,
      prompt: `Decompose into atomic, independent subtasks for external coding CLIs.\nTask: ${task}\nRepo: ${repo}\n` +
        `Return JSON {tasks:[{id,description,files,cli,model_tier,complexity_score,risk,dependencies,prompt}]}.${fb ? '\n' + fb : ''}` }),
    { schema: PLAN_SCHEMA, maxRetries: 2 })
  return r ? r.object : null
}
```

- [ ] **Step 4: Create `bin/ultraswarm.mjs`**

```js
#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'
import { execSync } from 'node:child_process'
import { loadConfig } from '../scripts/router.mjs'
import { validatePlan } from '../lib/plan-schema.mjs'
import { AnthropicClient } from '../lib/llm/anthropic.mjs'
import { resolveBrainModel } from '../lib/llm/brain-router.mjs'
import { decompose } from '../lib/orchestrator/decompose.mjs'
import { runSwarm } from '../lib/orchestrator/runner.mjs'
import { buildReport, cleanup } from '../lib/orchestrator/report.mjs'

export function buildRunConfig(base, plan) {
  const { valid, errors } = validatePlan(plan)
  if (!valid) throw new Error(`invalid plan: ${errors.join('; ')}`)
  return { ...base, tasks: plan.tasks }
}

function detectGates(repo) {
  const pkg = path.join(repo, 'package.json')
  if (!fs.existsSync(pkg)) return []
  const s = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts || {}
  return ['build', 'test', 'lint'].filter((g) => s[g]).map((g) => ({ name: g, cmd: `npm run ${g}` }))
}

function arg(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }

async function main() {
  const planFile = arg('--plan-file')
  const decomposeTask = arg('--decompose')
  const yes = process.argv.includes('--yes')
  const repo = process.cwd(), repoName = path.basename(repo)
  const userConfig = loadConfig()
  const base = {
    repo, repoName, baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot: path.join(process.env.HOME, 'worktrees'), gates: detectGates(repo),
    registry: userConfig.registry || {}, alternates: userConfig.alternates || {}, intelligence: userConfig.intelligence || {},
  }

  let plan
  if (planFile) plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  else if (decomposeTask) {
    const brain = new AnthropicClient()
    plan = await decompose(brain, decomposeTask, repo, resolveBrainModel('opus', userConfig).model)
    if (!plan) { console.error('decomposition failed'); process.exit(1) }
  } else { console.error('usage: ultraswarm --plan-file <json> | --decompose "<task>" [--yes]'); process.exit(2) }

  console.log(JSON.stringify(plan.tasks.map((t) => ({ id: t.id, cli: t.cli, tier: t.model_tier, risk: t.risk })), null, 2))
  if (!yes) { console.error('re-run with --yes to execute'); process.exit(0) }

  const cfg = buildRunConfig(base, plan)
  const brain = new AnthropicClient()
  const result = await runSwarm(cfg, brain)
  console.log('\n' + buildReport(result))
  cleanup(cfg)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
```

- [ ] **Step 5: Run test — expect PASS (2 tests)**

Run: `node --test bin/ultraswarm.test.mjs`

- [ ] **Step 6: Manual end-to-end (proof-of-life) on a throwaway repo with a mock plan + fake CLI**

Create `/tmp/plan.json` with one routine task pointing `cli` at a registry entry that runs `test/fixtures/fake-cli.mjs`, then run `node bin/ultraswarm.mjs --plan-file /tmp/plan.json --yes` from a throwaway git repo. Expected: the plan prints, the task implements + reviews + merges, the report prints `merged ✓`, and the generated file is committed on the branch. (Review uses the real brain here — needs `ANTHROPIC_API_KEY`; or stub by temporarily importing `MockLlmClient`.)

- [ ] **Step 7: Commit**

```bash
git add bin/ultraswarm.mjs bin/ultraswarm.test.mjs lib/orchestrator/decompose.mjs
git commit -m "feat: CLI entrypoint (--plan-file primary, --decompose fallback) + report/cleanup"
```

---

## Phase F — QA breadth: adversarial cascade + competition (port)

### Task F1: Extract the full orchestration core; reuse the harness

**Files:** Create `lib/orchestrator/core.mjs`, `lib/orchestrator/core.harness.test.mjs`; Modify `lib/orchestrator/runner.mjs`

- [ ] **Step 1: Create `lib/orchestrator/core.mjs`**

Lift these functions out of the ```js block in `skills/ultraswarm/SKILL.md` into an exported factory `createOrchestrator({ agent, parallel, log, cfg })` returning `{ runIntelligentTask, adaptiveQA }`:
`validateCliName`, `validateModelTier`, `runSimpleQA`, `runModerateQA`, `runExpertEscalation`, `runAdversarialQA` (the security-`ceiling` + Sonnet→`ceiling` cascade, where `ceiling = cfg.intelligence?.maxIntelligence ? 'fable' : 'opus'`), `adaptiveQA`, `intelligentAttemptLoop`, `runCompetitiveTask`, `judgeCompetition`, `handleFailedCompetition`, `runStandardTask`, `runIntelligentTask`, plus `LENS_BORDERLINE`, `QA_CONFIDENCE_THRESHOLD`, `SIMPLE_COMPLEXITY_THRESHOLD`, `EXPERT_COMPLEXITY_THRESHOLD`, `COMPLEX_THRESHOLD`. Keep the logic byte-for-byte; only change: (a) functions read `cfg`/`agent`/`parallel`/`log` from the factory closure, (b) `intelligentImplement` is **replaced** by a call to `runImplementation` from `implement.mjs` (no brain; the standalone impl is a subprocess), (c) prompt builders import from `lib/prompts.mjs` with the explicit-`cfg` signatures.

- [ ] **Step 2: Modify `runner.mjs` to route high-risk tasks through the core**

In `runRoutineTask`'s caller, branch on risk/complexity: `t.risk === 'high' || t.complexity_score > 70` → `createOrchestrator(...).runIntelligentTask(t)`; else the existing routine path. The injected `agent` dispatches by label prefix — `review:`/`judge:`/`verify:` to the brain (`makeAgent`), everything else stays subprocess. Keep the merge/wave loop unchanged.

- [ ] **Step 3: Create `lib/orchestrator/core.harness.test.mjs`**

Port the high-risk and escalation assertions from `scripts/workflow-harness.test.mjs` — but instead of extracting JS from `SKILL.md`, import `createOrchestrator` and drive it with the same mock `agent`/`parallel` and fixtures (`makeTask`, `okImpl`, `judgeScore`, `passVerdict`, etc.). Copy the bodies for: security-Opus + cascade lenses, borderline-escalation, quorum (<2 votes), critical-override, all-lenses-die, escalation simple→moderate→complex, and primary→alternate exhaustion. This proves the extracted core is behavior-identical to the skill.

- [ ] **Step 4: Run the harness against the core — expect PASS (all ported cases)**

Run: `node --test lib/orchestrator/core.harness.test.mjs`

- [ ] **Step 5: Run the whole suite — expect PASS**

Run: `npm test`

- [ ] **Step 6: Commit**

```bash
git add lib/orchestrator/core.mjs lib/orchestrator/core.harness.test.mjs lib/orchestrator/runner.mjs
git commit -m "feat: extract full QA cascade + competition core; standalone reaches parity"
```

---

## Phase G — Journal + resume

### Task G1: Run journal keyed on label + prompt-hash

**Files:** Create `lib/journal.mjs`, `lib/journal.test.mjs`; Modify `lib/orchestrator/runner.mjs`

The journal keys each brain call on `label + sha256(prompt)` so a retry (which changes the prompt
via accumulated feedback) gets a fresh key instead of replaying a stale verdict.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { Journal } from './journal.mjs'

test('Journal replays a cached key and runs a new one; different prompt = different key', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'us-j-')), 'run.jsonl')
  let ran = 0
  const j1 = new Journal(file)
  assert.deepEqual(await j1.step('review:t1', 'PROMPT-A', async () => { ran++; return { v: 1 } }), { v: 1 })

  const j2 = new Journal(file)   // resume
  assert.deepEqual(await j2.step('review:t1', 'PROMPT-A', async () => { ran++; return { v: 999 } }), { v: 1 }, 'cached replayed')
  assert.equal(ran, 1)
  assert.deepEqual(await j2.step('review:t1', 'PROMPT-B', async () => { ran++; return { v: 2 } }), { v: 2 }, 'new prompt -> new key')
  assert.equal(ran, 2)
})
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Create `lib/journal.mjs`**

```js
import fs from 'node:fs'
import { createHash } from 'node:crypto'

export class Journal {
  constructor(file) {
    this.file = file
    this.cache = new Map()
    if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const { key, result } = JSON.parse(line); this.cache.set(key, result)
    }
  }
  async step(label, prompt, fn) {
    const key = `${label}:${createHash('sha256').update(prompt).digest('hex').slice(0, 16)}`
    if (this.cache.has(key)) return this.cache.get(key)
    const result = await fn()
    this.cache.set(key, result)
    fs.appendFileSync(this.file, JSON.stringify({ key, result }) + '\n')
    return result
  }
}
```

- [ ] **Step 4: Run test — expect PASS (1 test)**

- [ ] **Step 5: Wire `--resume <id>` into runner + CLI**

In `bin/ultraswarm.mjs`: if `--resume <id>` is present, create `.ultraswarm/` and `new Journal('.ultraswarm/run-<id>.jsonl')`; otherwise derive `<id>` from the base SHA + a `--run <n>` counter (default 1) — **no `Date.now()`** (keeps resume deterministic). Pass the journal into `runSwarm`. In `makeAgent` (runner.mjs), wrap each brain call: `journal.step(label, prompt, () => brain.complete(...))`. Impl-label subprocess steps are **not** journaled (they mutate worktrees).

- [ ] **Step 6: Commit**

```bash
git add lib/journal.mjs lib/journal.test.mjs lib/orchestrator/runner.mjs bin/ultraswarm.mjs
git commit -m "feat: run journal + --resume (brain replay keyed on label+prompt-hash)"
```

---

## Phase H — Host shims + docs

### Task H1: Codex and Grok launchers

**Files:** Create `hosts/codex/AGENTS.md`, `hosts/grok/ultraswarm.md`

- [ ] **Step 1: Create `hosts/codex/AGENTS.md`**

```markdown
# ultraswarm (Codex host launcher)

When the user asks to run an ultraswarm swarm, do NOT implement the task yourself. Instead:
1. Explore the repo (conventions, file paths, gate commands).
2. Write a plan to `.ultraswarm-plan.json`:
   {"tasks":[{"id","description","files","cli","model_tier","complexity_score","risk","dependencies","prompt"}]}
   Use only these `cli` values: codex, gemini, grok, agy, droid, opencode.
3. Show the plan to the user. On approval, run and relay the output of:
       node <path-to-ultraswarm>/bin/ultraswarm.mjs --plan-file .ultraswarm-plan.json --yes
Requires ANTHROPIC_API_KEY in the environment (the runner's QA brain).
```

- [ ] **Step 2: Create `hosts/grok/ultraswarm.md`** — same contract, Grok phrasing.

- [ ] **Step 3: Manual verification (host integration — no automated test)**

From a test repo, hand-write `.ultraswarm-plan.json` (one routine task) and run `node bin/ultraswarm.mjs --plan-file .ultraswarm-plan.json` (no `--yes`). Expected: prints the validated plan summary and exits 0 without executing.

- [ ] **Step 4: Commit**

```bash
git add hosts/
git commit -m "feat: Codex/Grok host launchers (decompose -> --plan-file)"
```

### Task H2: README + validate.sh

**Files:** Modify `README.md`, `scripts/validate.sh`

- [ ] **Step 1: Add a "Running from other hosts" section to `README.md`**

Document: the host-decomposes/runner-executes model; `node bin/ultraswarm.mjs --plan-file plan.json --yes`; the Codex/Grok launchers; the **billing/auth note** (standalone bills Anthropic API tokens for the QA brain; needs `ANTHROPIC_API_KEY` + each worker CLI's own auth); and that **Claude Code remains the primary, highest-fidelity host** (native live UI + resume).

- [ ] **Step 2: Add validate.sh check [12] — `lib/` and `bin/` parse**

Add a check looping `node --check` over `bin/ultraswarm.mjs` and every `lib/**/*.mjs`; fail loud on any syntax error.

- [ ] **Step 3: Run the full validator — expect all green**

Run: `npm ci && bash scripts/validate.sh`

- [ ] **Step 4: Commit**

```bash
git add README.md scripts/validate.sh
git commit -m "docs: document standalone runner + hosts; validate.sh parses lib/ and bin/"
```

---

## Self-review

**Spec coverage:**
- Host-decomposes/runner-executes + plan-JSON contract → D1 (`plan-schema`), E5 (`--plan-file`), H1 (host shims) ✓
- Bare-shell `--decompose` fallback → E5 (`decompose.mjs`) ✓
- Engine primitives (pipeline index bug fixed) → B1 ✓ · validate+retry → B2 ✓
- Anthropic brain, **per-model request shape (no effort/thinking on Haiku)** → C3 ✓ · brain-router → C2 ✓
- Impl wrapper = subprocess, no model → D2 ✓
- **Dependency waves** → E1 (`waves.mjs`) + E4 (runner chaining + rebase) ✓
- **Merge (gate-after-each, rollback, no-blend)** → E2 ✓ · **report + cleanup** → E3 ✓
- QA cascade + competition parity (reuse harness) → F1 ✓
- Journal/resume **keyed on label+prompt-hash** → G1 ✓
- Cost/auth surfaced; Claude Code primary → H2 ✓
- `router.mjs` reused unchanged (imported in D1/D2/E5; not modified) ✓
- Proof-of-life now genuinely merges to the branch → E4 test asserts the file lands ✓

**Placeholder scan:** No "TBD"/"implement later"/"add error handling". The two lift-and-adapt tasks (A2, F1) name exact source functions in `SKILL.md` and the exact mechanical transformation — concrete, because the source exists and is harness-tested. Conflict-resolution-via-brain is explicitly deferred (E2 note) with fail-loud behavior shipped now, not hand-waved.

**Type consistency:** `IMPL_SCHEMA` fields (`status`/`gate_results`/`cli_tokens`/`worktree`/`branch`/`model_used`/`complexity_achieved`) match `runImplementation`'s return (D2) and the runner/merge consumers (E2/E4). `validatePlan(plan) → {valid, errors}` consistent (D1/E5). `resolveBrainModel(tier, config)` consistent (C2/E5). `mergeWave(cfg, agent, approved)` where `approved[i] = {task, cli, impl:{branch}}` consistent (E2/E4). `Journal.step(label, prompt, fn)` consistent (G1). `computeWaves(tasks) → wave[]` consistent (E1/E4).

## Execution handoff

Implement **Phase A → E first** (the proof-of-life vertical slice: a one-task plan that implements, reviews, and **merges to the working branch** from a bare shell), validate end-to-end, then add **F** (high-risk QA parity), **G** (resume), **H** (host launchers + docs). Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — batch tasks in this session with checkpoints.
