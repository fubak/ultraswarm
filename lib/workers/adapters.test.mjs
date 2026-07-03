import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ShellWorkerAdapter, WorkerManager } from './adapters.mjs'
import { SMOKE_FILE } from './smoke.mjs'
import { DEFAULT_REGISTRY } from '../router.mjs'

const codexUsage = DEFAULT_REGISTRY.codex.usage
const opencodeUsage = DEFAULT_REGISTRY.opencode.usage
const geminiUsage = DEFAULT_REGISTRY.gemini.usage

test('parseUsage reads REAL structured usage from codex/opencode JSON (not a text scrape)', () => {
  // WHY: usage must come from the worker's structured JSON event — never a free-text scrape (the old
  // /tokens?\s*used?[:\s]+(\d+)/ matched incidental numbers and undercounted by orders of magnitude).
  // These are the exact event shapes the codex (`exec --json`) and opencode (`run --format json`)
  // invocations emit, captured from real runs.
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  // codex: top-level `usage` on a turn.completed event.
  const codex = '{"type":"turn.completed","usage":{"input_tokens":16810,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}'
  assert.deepEqual(adapter.parseUsage(codex, codexUsage), { input_tokens: 16810, output_tokens: 5, totalTokens: 16815, costUsd: null })
  // opencode: tokens nested under `.part` of a step_finish event, with cost.
  const oc = '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":4202,"input":4095,"output":107,"reasoning":0},"cost":0.012}}'
  assert.deepEqual(adapter.parseUsage(oc, opencodeUsage), { input_tokens: 4095, output_tokens: 107, totalTokens: 4202, costUsd: 0.012 })
  // Multiple events SUM (total tokens the worker processed across turns/steps).
  assert.equal(adapter.parseUsage(`${codex}\n${codex}`, codexUsage).totalTokens, 33630)
})

describe('parseUsage gemini descriptor', () => {
  it('reads a single-line gemini JSON object via the wildcard stats.models.* path', () => {
    const adapter = new ShellWorkerAdapter('gemini', {}, {})
    const text = '{"response":"done","stats":{"models":{"gemini-2.5-pro":{"tokens":{"prompt":1200,"candidates":340,"total":1540}}}}}'
    assert.deepEqual(adapter.parseUsage(text, geminiUsage), { input_tokens: 1200, output_tokens: 340, totalTokens: 1540, costUsd: null })
  })

  it('reads a pretty-printed multi-line gemini JSON object the same way', () => {
    const adapter = new ShellWorkerAdapter('gemini', {}, {})
    const text = JSON.stringify({ response: 'done', stats: { models: { 'gemini-2.5-pro': { tokens: { prompt: 1200, candidates: 340, total: 1540 } } } } }, null, 2)
    assert.deepEqual(adapter.parseUsage(text, geminiUsage), { input_tokens: 1200, output_tokens: 340, totalTokens: 1540, costUsd: null })
  })

  it('sums the wildcard across two models', () => {
    const adapter = new ShellWorkerAdapter('gemini', {}, {})
    const text = JSON.stringify({
      stats: {
        models: {
          'gemini-2.5-pro': { tokens: { prompt: 1000, candidates: 200 } },
          'gemini-2.5-flash': { tokens: { prompt: 500, candidates: 100 } },
        },
      },
    })
    assert.deepEqual(adapter.parseUsage(text, geminiUsage), { input_tokens: 1500, output_tokens: 300, totalTokens: 1800, costUsd: null })
  })

  it('does not double-count a single-line JSON object matched by both the line and whole-text passes', () => {
    const adapter = new ShellWorkerAdapter('gemini', {}, {})
    const text = '{"stats":{"models":{"gemini-2.5-pro":{"tokens":{"prompt":100,"candidates":50}}}}}'
    assert.deepEqual(adapter.parseUsage(text, geminiUsage), { input_tokens: 100, output_tokens: 50, totalTokens: 150, costUsd: null })
  })

  it('a config override usage descriptor wins over the registry default', () => {
    const adapter = new ShellWorkerAdapter('gemini', {}, {})
    const overrideDescriptors = [{ input: 'custom.in', output: 'custom.out' }]
    const text = '{"custom":{"in":7,"out":3},"stats":{"models":{"gemini-2.5-pro":{"tokens":{"prompt":1200,"candidates":340}}}}}'
    assert.deepEqual(adapter.parseUsage(text, overrideDescriptors), { input_tokens: 7, output_tokens: 3, totalTokens: 10, costUsd: null })
  })
})

// ── probe() ──────────────────────────────────────────────────────────────────
// WHY: probe() is the health-check path callers use to gate execution.
// A healthy probe must return { healthy: true } with version text.
// An unhealthy probe (binary not found) must return { healthy: false, error }.
// Neither branch was previously covered.

test('probe() returns healthy:true and version text when the binary exists', () => {
  // Use the node binary itself — always present, always emits a version string.
  const adapter = new ShellWorkerAdapter('node', {
    registry: { node: { binary: 'node' } },
  }, {})
  const result = adapter.probe()
  assert.equal(result.healthy, true, 'healthy must be true for an existing binary')
  assert.ok(typeof result.version === 'string' && result.version.length > 0, 'version must be a non-empty string')
  assert.ok(result.capabilities, 'capabilities must be present')
})

test('probe() returns healthy:false and error when the binary does not exist', () => {
  // WHY: callers must be able to detect a missing/broken worker and skip it.
  // A nonexistent binary triggers the catch branch; we assert the shape is correct
  // so callers can rely on {healthy, error} without throwing.
  const adapter = new ShellWorkerAdapter('__nonexistent_binary_xyz__', {}, {})
  const result = adapter.probe()
  assert.equal(result.healthy, false, 'healthy must be false when binary is missing')
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error must be a non-empty string')
  assert.ok(result.capabilities, 'capabilities must still be present on failure')
})

// ── classifyFailure() ─────────────────────────────────────────────────────────
// WHY: each branch maps a distinct failure signal to a distinct recovery strategy.
// Confusing 'timeout' and 'transport' (for example) would cause callers to retry
// the wrong way. Every branch must be exercised individually.

test('classifyFailure() returns "timeout" when result.timedOut is true', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.equal(adapter.classifyFailure({ timedOut: true, aborted: false, stdout: '', stderr: '' }), 'timeout')
})

// #SE3: a container worker builds `-v ${cwd}:/workspace`; a cwd containing ':' silently corrupts the
// volume spec (mounting the wrong path). Reject it loudly before launching the container.
test('container worker rejects a cwd containing ":" that would corrupt the -v mount (#SE3)', async () => {
  let ran = false
  const supervisor = { run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' } } }
  const adapter = new ShellWorkerAdapter('codex',
    { policy: { isolation: 'container', containerImage: 'img' }, registry: { codex: 'echo hi' } }, supervisor)
  await assert.rejects(
    () => adapter.executeNow({ task: { id: 't', model_tier: 'simple' }, cwd: '/tmp/a:b', timeoutMs: 1000, label: 'x', env: {}, onStart: () => {} }),
    /mount path|:/)
  assert.equal(ran, false, 'must reject before launching the container')
})

test('classifyFailure() returns "cancelled" when result.aborted is true', () => {
  // WHY: aborted tasks should not be retried — they were intentionally stopped.
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: true, stdout: '', stderr: '' }), 'cancelled')
})

test('classifyFailure() returns "auth" when output contains auth-related text', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'Error: unauthorized' }), 'auth')
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: 'login required', stderr: '' }), 'auth')
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'invalid api_key provided' }), 'auth')
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'credential expired' }), 'auth')
})

test('classifyFailure() returns "not_installed" when output contains command-not-found signals', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'command not found: codex' }), 'not_installed')
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'ENOENT: no such file' }), 'not_installed')
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'No such file or directory' }), 'not_installed')
})

test('classifyFailure() returns "transport" when output contains network/connection error signals', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'ECONNREFUSED 127.0.0.1:8080' }), 'transport')
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: 'transport error', stderr: '' }), 'transport')
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'channel closed unexpectedly' }), 'transport')
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'dns resolution failed' }), 'transport')
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: '', stderr: 'proxy refused connection' }), 'transport')
})

test('classifyFailure() returns "error" for unrecognised failure output', () => {
  // WHY: this is the default catch-all; if the regex list ever grows, this test still
  // validates that something unrecognised falls through cleanly rather than returning undefined.
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.equal(adapter.classifyFailure({ timedOut: false, aborted: false, stdout: 'some random failure text', stderr: '' }), 'error')
})

// ── parseUsage() no-fabrication ───────────────────────────────────────────────
// WHY: only STRUCTURED JSONL usage counts. Free text — even text that contains "tokens: 100" — must
// never be scraped into a number, so a worker printing that in its content can't be mistaken for
// reported usage; the report then honestly says "not reported" instead of a noise figure.

test('parseUsage() returns nulls for non-JSON / no-usage text (no fabrication)', () => {
  const nulls = { input_tokens: null, output_tokens: null, totalTokens: null, costUsd: null }
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.deepEqual(adapter.parseUsage('tokens: 100 cost: $1.50'), nulls)
  assert.deepEqual(adapter.parseUsage('no usage info here'), nulls)
  assert.deepEqual(adapter.parseUsage('{"type":"text","content":"done, used some tokens"}'), nulls)
  assert.deepEqual(adapter.parseUsage(''), nulls)
})

// ── capabilities() parity with the deleted CAPABILITIES map ──────────────────
// WHY: the CAPABILITIES map was deleted in favor of deriving from the registry (router.mjs
// DEFAULT_REGISTRY entries). These are the exact old hard-coded values — capabilities() must
// still return them byte-for-byte for every built-in.

describe('capabilities() parity with the old hard-coded CAPABILITIES map', () => {
  const oldCapabilities = {
    codex: { languages: ['*'], strengths: ['backend', 'logic', 'debugging', 'architecture'], structuredOutput: true, resume: true },
    gemini: { languages: ['*'], strengths: ['frontend', 'ui', 'design'], structuredOutput: false, resume: false },
    grok: { languages: ['*'], strengths: ['tests', 'refactors', 'general'], structuredOutput: false, resume: false },
    agy: { languages: ['*'], strengths: ['docs', 'boilerplate', 'automation'], structuredOutput: false, resume: false },
    droid: { languages: ['*'], strengths: ['full-stack', 'refactors', 'architecture'], structuredOutput: false, resume: false },
    opencode: { languages: ['*'], strengths: ['boilerplate', 'lint', 'tests', 'docs'], structuredOutput: false, resume: false },
    pi: { languages: ['*'], strengths: ['general', 'full-stack', 'refactors'], structuredOutput: false, resume: false },
    'pi-local': { languages: ['*'], strengths: ['general', 'boilerplate', 'docs', 'tests'], structuredOutput: false, resume: false },
    'small-harness': { languages: ['*'], strengths: ['tool-rich', 'mcp-integration', 'cost-tracking', 'multi-backend', 'local-models'], structuredOutput: false, resume: false },
    agent: { languages: ['*'], strengths: ['general', 'full-stack', 'refactors', 'debugging', 'tests'], structuredOutput: false, resume: true },
  }

  for (const [name, expected] of Object.entries(oldCapabilities)) {
    it(`${name} matches the old hard-coded capabilities`, () => {
      const caps = new ShellWorkerAdapter(name, {}, {}).capabilities()
      assert.deepStrictEqual(caps, { name, ...expected })
    })
  }
})

// ── recover() ────────────────────────────────────────────────────────────────
// WHY: orchestrators check recover().recoverable before deciding whether to
// re-queue. Shell workers cannot self-recover; callers must not re-queue them.

test('recover() always returns { recoverable: false }', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.deepEqual(adapter.recover(), { recoverable: false })
})

// ── cancel() delegates to supervisor ─────────────────────────────────────────
// WHY: cancel() is the orchestrator's kill switch for a running worker process.
// It must pass the pid through to supervisor.cancel so the process is actually killed.

test('cancel() delegates to supervisor.cancel with the provided pid', () => {
  let cancelledPid
  const supervisor = { cancel: (pid) => { cancelledPid = pid } }
  const adapter = new ShellWorkerAdapter('codex', {}, supervisor)
  adapter.cancel(1234)
  assert.equal(cancelledPid, 1234)
})

test('cancel() is a no-op when supervisor has no cancel method', () => {
  // WHY: the optional chaining (supervisor.cancel?.()) must not throw when supervisor
  // is a minimal stub without cancel. This is common in unit test setups.
  const supervisor = {}
  const adapter = new ShellWorkerAdapter('codex', {}, supervisor)
  assert.doesNotThrow(() => adapter.cancel(9999))
})

// ── executeNow container branch: --network none is omitted when policy.network != 'deny' ──
// WHY: the existing test covers network:'deny'. This covers the complementary case:
// container isolation WITH network allowed must NOT pass --network none to docker.

test('container isolation without network:deny does NOT pass --network none to docker', async () => {
  let call
  const supervisor = { run: async (options) => { call = options; return { code: 0, stdout: '', stderr: '' } } }
  const adapter = new ShellWorkerAdapter('codex', {
    registry: { codex: 'echo ok' },
    policy: { isolation: 'container', containerImage: 'worker:test' },
  }, supervisor)
  await adapter.execute({ task: { model_tier: 'simple' }, cwd: '/repo', timeoutMs: 1 })
  assert.equal(call.command, 'docker')
  // --network none must NOT appear when policy.network is not 'deny'
  const networkIdx = call.args.indexOf('--network')
  assert.equal(networkIdx, -1, '--network flag must not be passed when network policy is not deny')
})

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

// ── small-harness worker ──────────────────────────────────────────────────────
// WHY: small-harness is a distinct built-in worker that uses its own binary and
// offers MCP integration, multi-backend support, and cost tracking — capabilities
// not present in the other workers. Its adapter must resolve correctly.

test('small-harness uses its own binary (not inherited from another CLI)', () => {
  assert.equal(new ShellWorkerAdapter('small-harness', {}, {}).binary, 'small-harness')
})

test('small-harness capabilities include tool-rich and mcp-integration strengths', () => {
  const caps = new ShellWorkerAdapter('small-harness', {}, {}).capabilities()
  assert.ok(caps.strengths.includes('tool-rich'), 'must include tool-rich')
  assert.ok(caps.strengths.includes('mcp-integration'), 'must include mcp-integration')
  assert.ok(caps.strengths.includes('multi-backend'), 'must include multi-backend')
})

// ── agent worker (Cursor CLI) ─────────────────────────────────────────────────

test('agent uses its own binary', () => {
  assert.equal(new ShellWorkerAdapter('agent', {}, {}).binary, 'agent')
})

test('agent capabilities include general full-stack strengths', () => {
  const caps = new ShellWorkerAdapter('agent', {}, {}).capabilities()
  assert.ok(caps.strengths.includes('general'), 'must include general')
  assert.ok(caps.strengths.includes('full-stack'), 'must include full-stack')
  assert.equal(caps.resume, true, 'agent supports session resume')
})

test('container isolation wraps execution with network and workspace controls', async () => {
  let call
  const supervisor = { run: async (options) => { call = options; return { code: 0, stdout: '', stderr: '' } } }
  const adapter = new ShellWorkerAdapter('codex', {
    registry: { codex: 'echo ok' },
    policy: { isolation: 'container', network: 'deny', containerImage: 'worker:test' },
  }, supervisor)
  await adapter.execute({ task: { model_tier: 'simple' }, cwd: '/repo', timeoutMs: 1 })
  assert.equal(call.command, 'docker')
  assert.ok(call.args.includes('none'))
  assert.ok(call.args.includes('worker:test'))
  assert.ok(call.args.includes('/repo:/workspace'))
})

// ── executeNow: usage descriptor resolution ───────────────────────────────────
// WHY: executeNow must resolve usage descriptors from config.overrides first, then the
// (alias-resolved) registry entry, and feed them into parseUsage — codex/opencode behavior
// stays byte-identical since their registry descriptors match the old hard-coded shapes.

test('executeNow parses gemini usage via its registry descriptor', async () => {
  const geminiOutput = '{"stats":{"models":{"gemini-2.5-pro":{"tokens":{"prompt":10,"candidates":5}}}}}'
  const supervisor = { run: async () => ({ code: 0, stdout: geminiOutput, stderr: '' }) }
  const adapter = new ShellWorkerAdapter('gemini', {}, supervisor)
  const result = await adapter.execute({ task: { model_tier: 'simple' }, cwd: '/repo', timeoutMs: 1 })
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5, totalTokens: 15, costUsd: null })
})

test('executeNow prefers a config.overrides usage descriptor over the registry default', async () => {
  const supervisor = { run: async () => ({ code: 0, stdout: '{"custom":{"in":9,"out":1}}', stderr: '' }) }
  const cfg = { overrides: { gemini: { usage: [{ input: 'custom.in', output: 'custom.out' }] } } }
  const adapter = new ShellWorkerAdapter('gemini', cfg, supervisor)
  const result = await adapter.execute({ task: { model_tier: 'simple' }, cwd: '/repo', timeoutMs: 1 })
  assert.deepEqual(result.usage, { input_tokens: 9, output_tokens: 1, totalTokens: 10, costUsd: null })
})

// ── alias inheritance of usage + strengths ────────────────────────────────────

describe('alias inheritance of declarative usage descriptors', () => {
  it('an alias extending codex inherits its usage descriptor and strengths', () => {
    const cfg = {
      aliases: {
        'codex-fast': { extends: 'codex', models: { simple: { model: 'm', invocation: 'codex "$(cat .ultraswarm-prompt.txt)"' } } },
      },
    }
    const adapter = new ShellWorkerAdapter('codex-fast', cfg, {})
    assert.deepEqual(adapter.entry.usage, [{ input: 'usage.input_tokens', output: 'usage.output_tokens' }])
    assert.deepEqual(adapter.capabilities().strengths, ['backend', 'logic', 'debugging', 'architecture'])
    assert.equal(adapter.capabilities().structuredOutput, true)
  })

  it('an alias with its own usage descriptor keeps it instead of inheriting the base', () => {
    const cfg = {
      aliases: {
        'codex-custom': {
          extends: 'codex',
          usage: [{ input: 'my.in', output: 'my.out' }],
          models: { simple: { model: 'm', invocation: 'codex "$(cat .ultraswarm-prompt.txt)"' } },
        },
      },
    }
    const adapter = new ShellWorkerAdapter('codex-custom', cfg, {})
    assert.deepEqual(adapter.entry.usage, [{ input: 'my.in', output: 'my.out' }])
  })
})

// ── WorkerManager.get() error path ───────────────────────────────────────────
// WHY: callers are expected to handle unknown worker names gracefully. The error
// must be thrown (not silently returned as undefined) so callers can fail fast.

test('WorkerManager.get() throws for an unknown worker name', () => {
  const mgr = new WorkerManager({ repo: '/tmp/test-repo' }, { supervisor: { run: async () => ({}), close() {} } })
  assert.throws(
    () => mgr.get('__no_such_worker__'),
    { message: /unknown worker/ },
    'must throw with a descriptive message for unknown workers',
  )
  mgr.close()
})

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

// ── functionalProbes(): installed ≠ functional ────────────────────────────────
// WHY: probe() (--version) only proves a binary exists. functionalProbes runs a real smoke write and
// marks healthy=false for a worker that can't produce a file — the exact gemini/opencode failure
// from the motivating report. Aliases use binary `node` so the --version probe is healthy, and a fake
// supervisor decides whether the smoke "writes" the artifact.

const nodeAlias = (extras = {}) => ({
  extends: 'pi', binary: 'node',
  models: { simple: { model: 'm', invocation: 'node -e 1 "$(cat .ultraswarm-prompt.txt)"' } },
  ...extras,
})

// Supervisor that writes (or doesn't write) the smoke artifact into the worker cwd.
const smokeSupervisor = (shouldWrite) => ({
  run: async ({ cwd, args }) => {
    // args[1] is the shell command string ('node ...'); the cwd is the worker worktree (smoke temp).
    if (shouldWrite) fs.writeFileSync(path.join(cwd, SMOKE_FILE), 'OK')
    return { code: 0, stdout: 'tokens used: 3', stderr: '', durationMs: 1 }
  },
  close() {},
})

describe('WorkerManager.functionalProbes', () => {
  const makeRepo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'us-fprobe-'))

  it('marks a worker that writes the artifact functional + healthy', async () => {
    const repo = makeRepo()
    const mgr = new WorkerManager({ repo, aliases: { good: nodeAlias() } }, { supervisor: smokeSupervisor(true) })
    const probes = await mgr.functionalProbes(['good'])
    assert.equal(probes[0].installed, true)
    assert.equal(probes[0].functional, true)
    assert.equal(probes[0].healthy, true, 'routing keys off healthy — a functional worker must be healthy')
    mgr.close()
  })

  it('marks a worker that writes nothing UNUSABLE (healthy=false) so routing skips it', async () => {
    const repo = makeRepo()
    const mgr = new WorkerManager({ repo, aliases: { dead: nodeAlias() } }, { supervisor: smokeSupervisor(false) })
    const probes = await mgr.functionalProbes(['dead'])
    assert.equal(probes[0].installed, true)
    assert.equal(probes[0].functional, false)
    assert.equal(probes[0].kind, 'no_op')
    assert.equal(probes[0].healthy, false)
    mgr.close()
  })

  it('caches the verdict (second probe within TTL does not re-run the smoke test)', async () => {
    const repo = makeRepo()
    let runs = 0
    const supervisor = { run: async ({ cwd }) => { runs++; fs.writeFileSync(path.join(cwd, SMOKE_FILE), 'OK'); return { code: 0 } }, close() {} }
    const mgr = new WorkerManager({ repo, aliases: { good: nodeAlias() } }, { supervisor })
    await mgr.functionalProbes(['good'])
    assert.equal(runs, 1, 'first probe runs the smoke test')
    const again = await mgr.functionalProbes(['good'])
    assert.equal(runs, 1, 'cached probe does NOT re-run the worker')
    assert.equal(again[0].fromCache, true)
    assert.ok(fs.existsSync(path.join(repo, '.ultraswarm', 'functional-probe.json')), 'verdict is persisted')
    mgr.close()
  })

  it('force re-runs the smoke test even with a fresh cache', async () => {
    const repo = makeRepo()
    let runs = 0
    const supervisor = { run: async ({ cwd }) => { runs++; fs.writeFileSync(path.join(cwd, SMOKE_FILE), 'OK'); return { code: 0 } }, close() {} }
    const mgr = new WorkerManager({ repo, aliases: { good: nodeAlias() } }, { supervisor })
    await mgr.functionalProbes(['good'])
    await mgr.functionalProbes(['good'], { force: true })
    assert.equal(runs, 2, 'force bypasses the cache')
    mgr.close()
  })

  it('does not smoke-test an uninstalled worker (probe fails → not_installed)', async () => {
    const repo = makeRepo()
    let runs = 0
    const supervisor = { run: async () => { runs++; return { code: 0 } }, close() {} }
    const mgr = new WorkerManager({ repo, aliases: { missing: nodeAlias({ binary: '__nonexistent_bin_zzz__' }) } }, { supervisor })
    const probes = await mgr.functionalProbes(['missing'])
    assert.equal(probes[0].installed, false)
    assert.equal(probes[0].functional, false)
    assert.equal(probes[0].kind, 'not_installed')
    assert.equal(runs, 0, 'a worker that fails --version is never smoke-tested')
    mgr.close()
  })
})
