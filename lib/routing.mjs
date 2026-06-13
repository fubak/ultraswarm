import path from 'node:path'
import { DEFAULT_REGISTRY } from './router.mjs'

const FIT = {
  frontend: ['frontend', 'ui', 'css', 'component', 'react', 'vue', 'svelte'],
  tests: ['test', 'spec', 'coverage', 'fixture'],
  docs: ['readme', 'documentation', 'docs', 'markdown'],
  debugging: ['bug', 'debug', 'fix', 'failure', 'regression'],
  architecture: ['architecture', 'refactor', 'migration', 'design'],
  backend: ['api', 'database', 'server', 'backend', 'algorithm'],
}

export function classifyTask(task) {
  const text = `${task.description ?? ''} ${task.prompt ?? ''} ${(task.files ?? []).join(' ')}`.toLowerCase()
  const classes = Object.entries(FIT).filter(([, words]) => words.some((word) => text.includes(word))).map(([name]) => name)
  const extensions = [...new Set((task.files ?? []).map((file) => path.extname(file).slice(1)).filter(Boolean))]
  return { primary: classes[0] ?? 'general', classes: classes.length ? classes : ['general'], extensions }
}

function metricFor(metrics, worker, taskClass) {
  return metrics.find((row) => row.worker === worker && row.task_class === taskClass)
}

export function routeTask(task, { manager, store, enabled, probes } = {}) {
  const names = enabled?.length ? enabled : Object.keys(DEFAULT_REGISTRY)
  const health = probes ?? manager?.probes(names) ?? names.map((name) => ({ name, healthy: true }))
  const healthy = new Map(health.map((probe) => [probe.name, probe]))
  const taskClass = classifyTask(task)
  const metrics = store?.getMetrics() ?? []

  if (task.cli) {
    if (!names.includes(task.cli)) throw new Error(`explicit worker ${task.cli} is not enabled`)
    if (healthy.get(task.cli)?.healthy === false) throw new Error(`explicit worker ${task.cli} is unhealthy`)
    return { worker: task.cli, taskClass, explicit: true, scores: [{ worker: task.cli, score: 100, reasons: ['explicit task selection'] }] }
  }

  const scores = names.filter((name) => healthy.get(name)?.healthy !== false).map((name) => {
    const capabilities = manager?.get(name).capabilities() ?? { strengths: ['general'] }
    const matched = taskClass.classes.filter((kind) => capabilities.strengths?.includes(kind))
    const metric = metricFor(metrics, name, taskClass.primary)
    const passRate = metric?.runs ? metric.passes / metric.runs : 0.5
    const avgMs = metric?.runs ? metric.total_duration_ms / metric.runs : 300000
    const avgCost = metric?.runs ? metric.total_cost_usd / metric.runs : 0
    const score = 40 + matched.length * 20 + passRate * 30 - Math.min(avgMs / 60000, 10) - Math.min(avgCost * 10, 10)
    return { worker: name, score: Math.round(score * 100) / 100, reasons: [`fit: ${matched.join(', ') || 'general'}`, `pass rate: ${Math.round(passRate * 100)}%`, `average latency: ${Math.round(avgMs)}ms`, `average cost: $${avgCost.toFixed(4)}`] }
  }).sort((a, b) => b.score - a.score || a.worker.localeCompare(b.worker))

  if (!scores.length) throw new Error('no healthy enabled workers are available')
  return { worker: scores[0].worker, taskClass, explicit: false, scores }
}
