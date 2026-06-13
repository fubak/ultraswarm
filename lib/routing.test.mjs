import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTask, routeTask } from './routing.mjs'
import { WorkerManager } from './workers/adapters.mjs'

const manager = {
  probes: (names) => names.map((name) => ({ name, healthy: true })),
  get: (name) => ({ capabilities: () => ({ strengths: name === 'gemini' ? ['frontend'] : ['backend', 'debugging'] }) }),
}

test('classifyTask identifies UI work', () => assert.equal(classifyTask({ prompt: 'Build a React UI component' }).primary, 'frontend'))
test('routeTask honors an explicit healthy worker', () => assert.equal(routeTask({ cli: 'codex' }, { manager, enabled: ['codex'] }).worker, 'codex'))
test('routeTask scores capability fit and repository metrics', () => {
  const store = { getMetrics: () => [{ worker: 'gemini', task_class: 'frontend', runs: 4, passes: 4, total_duration_ms: 40, total_cost_usd: 0 }] }
  const result = routeTask({ prompt: 'Fix React frontend CSS' }, { manager, store, enabled: ['codex', 'gemini'] })
  assert.equal(result.worker, 'gemini'); assert.ok(result.scores[0].reasons.length >= 3)
})

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
