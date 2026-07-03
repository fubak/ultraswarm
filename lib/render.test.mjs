import { test } from 'node:test'
import assert from 'node:assert/strict'
import { table, renderRoster, renderPlanPreview, renderDoctor, renderStatus, renderMetrics, renderModels } from './render.mjs'

test('table aligns columns and draws a header rule', () => {
  const out = table(['A', 'BB'], [['x', 'yy'], ['zzz', 'q']])
  const lines = out.split('\n')
  assert.equal(lines.length, 4) // header + rule + 2 rows
  assert.match(lines[1], /─/)
  assert.match(out, /zzz/)
})

test('renderRoster surfaces functional verdicts, not just install state', () => {
  const probes = [
    { name: 'codex', installed: true, functional: true, capabilities: { strengths: ['backend'] } },
    { name: 'gemini', installed: true, functional: false, kind: 'no_op', reason: 'no_op' },
    { name: 'droid', installed: false, error: 'not found' },
  ]
  const out = renderRoster(probes)
  assert.match(out, /codex.*✓.*✓/)
  // WHY: a worker that installs but can't function must read as UNUSABLE so the operator never
  // wonders why it was skipped — this is the gemini case from the report.
  assert.match(out, /gemini.*✓.*✗.*UNUSABLE/)
  assert.match(out, /droid.*✗/)
})

test('renderRoster falls back to plain --version probes (healthy/version only)', () => {
  const out = renderRoster([{ name: 'codex', healthy: true, version: '1.0', capabilities: { strengths: ['backend'] } }])
  assert.match(out, /codex/)
  assert.match(out, /backend/)
})

test('renderPlanPreview shows the task→worker table, roster, and gates', () => {
  const tasks = [{ id: 't1', cli: 'codex', model_tier: 'simple', risk: 'low', dependencies: [] }]
  const probes = [{ name: 'codex', installed: true, functional: true, capabilities: { strengths: ['backend'] } }]
  const out = renderPlanPreview(tasks, [{ name: 'build' }], probes)
  assert.match(out, /PLAN PREVIEW/)
  assert.match(out, /t1.*codex.*simple/)
  assert.match(out, /WORKER ROSTER/)
  assert.match(out, /GATES: build/)
})

test('renderPlanPreview reports no gates clearly', () => {
  assert.match(renderPlanPreview([], []), /GATES: \(none detected\)/)
})

test('renderDoctor reports usable count against the policy minimum', () => {
  const probes = [
    { name: 'codex', installed: true, functional: true },
    { name: 'gemini', installed: true, functional: false, kind: 'no_op' },
  ]
  const out = renderDoctor({ minimumHealthyWorkers: 1, maxParallelWorkers: 4 }, [], probes)
  assert.match(out, /1\/2 workers usable · minimum required: 1/)
})

test('renderStatus lists runs and a single run with tasks + attempts', () => {
  assert.match(renderStatus([]), /No ultraswarm runs/)
  assert.match(renderStatus([{ id: 'r1', status: 'merged', updated_at: 't' }]), /r1.*merged/)
  const single = renderStatus({
    run: { id: 'r1', status: 'awaiting_merge' },
    tasks: [{ task_id: 't1', status: 'integrated', wave: 0 }],
    attempts: [{ task_id: 't1', number: 1, worker: 'codex', status: 'passed' }],
  })
  assert.match(single, /RUN r1/)
  assert.match(single, /t1.*integrated/)
  assert.match(single, /ATTEMPTS/)
  assert.match(single, /codex.*passed/)
})

test('renderStatus handles a missing run', () => {
  assert.match(renderStatus({ run: null }), /Run not found/)
})

test('renderMetrics is empty with no rows', () => {
  assert.equal(renderMetrics([]), '')
  assert.equal(renderMetrics(), '')
})

test('renderMetrics renders an aligned table with computed pass rate', () => {
  const out = renderMetrics([{ worker: 'codex', task_class: 'backend', runs: 12, passes: 11 }])
  assert.match(out, /WORKER TRACK RECORD/)
  assert.match(out, /codex\s+backend\s+12\s+92%/)
})

test('renderModels renders per-tier resolved models', () => {
  const out = renderModels([{ cli: 'codex', simple: 'gpt-5.4-mini', moderate: 'gpt-5.4', complex: 'gpt-5.5', expert: 'gpt-5.5' }])
  assert.match(out, /CLI\s+simple\s+moderate\s+complex\s+expert/)
  assert.match(out, /codex\s+gpt-5\.4-mini\s+gpt-5\.4\s+gpt-5\.5\s+gpt-5\.5/)
})
