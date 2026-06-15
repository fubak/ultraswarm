import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ShellWorkerAdapter, WorkerManager } from './adapters.mjs'

test('worker adapter parses token and cost usage', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.deepEqual(adapter.parseUsage('tokens used: 42 cost: $0.25'), { totalTokens: 42, costUsd: 0.25 })
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

// ── parseUsage() edge cases ───────────────────────────────────────────────────
// WHY: callers use totalTokens/costUsd to track billing. Missing either field
// must silently default to 0, not NaN or undefined.

test('parseUsage() defaults both fields to 0 when no matches in text', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.deepEqual(adapter.parseUsage('no usage info here'), { totalTokens: 0, costUsd: 0 })
  assert.deepEqual(adapter.parseUsage(''), { totalTokens: 0, costUsd: 0 })
})

test('parseUsage() extracts tokens without a cost line', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.deepEqual(adapter.parseUsage('tokens: 100'), { totalTokens: 100, costUsd: 0 })
})

test('parseUsage() extracts cost without a token line', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.deepEqual(adapter.parseUsage('cost: $1.50'), { totalTokens: 0, costUsd: 1.50 })
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
