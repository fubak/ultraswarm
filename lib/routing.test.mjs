import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTask, routeTask } from './routing.mjs'

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
