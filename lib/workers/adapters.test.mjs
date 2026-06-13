import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ShellWorkerAdapter, WorkerManager } from './adapters.mjs'

test('worker adapter parses token and cost usage', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.deepEqual(adapter.parseUsage('tokens used: 42 cost: $0.25'), { totalTokens: 42, costUsd: 0.25 })
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
