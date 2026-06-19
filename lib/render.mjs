// Human-readable renderers for the CLI. Pure (string in → string out, no I/O) so they are trivially
// testable and the machine-readable `--json` path stays a one-line branch in bin/cli.mjs.

// Minimal fixed-width table. Columns auto-size to the widest cell.
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length), 1))
  const fmt = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd()
  return [fmt(headers), fmt(widths.map((w) => '─'.repeat(w))), ...rows.map(fmt)].join('\n')
}

// Roster accepts either functionalProbes() output (installed/functional/kind/reason) or plain
// probes() output (healthy/version/capabilities), and renders a usable table for both.
export function renderRoster(probes = []) {
  const rows = probes.map((p) => {
    const installed = p.installed ?? p.healthy ?? false
    const functional = Object.hasOwn(p, 'functional') ? p.functional : undefined
    const strengths = (p.capabilities?.strengths ?? []).join(', ')
    const detail = !installed ? (p.error || p.reason || 'not installed')
      : functional === false ? `UNUSABLE — ${p.reason || p.kind || 'failed'}`
      : functional === true ? `${p.fromCache ? 'verified (cached)' : 'verified'}${strengths ? ` · ${strengths}` : ''}`
      : strengths
    return [p.name, installed ? '✓' : '✗', functional === undefined ? '–' : functional ? '✓' : '✗', detail]
  })
  return table(['WORKER', 'INSTALLED', 'FUNCTIONAL', 'DETAIL'], rows)
}

export function renderPlanPreview(tasks = [], gates = [], probes = null) {
  const taskRows = tasks.map((t) => [t.id, t.cli, t.model_tier, t.risk, (t.dependencies || []).join(', ') || '–'])
  const parts = ['PLAN PREVIEW', '', table(['TASK', 'WORKER', 'TIER', 'RISK', 'DEPENDS ON'], taskRows)]
  if (probes?.length) parts.push('', 'WORKER ROSTER', renderRoster(probes))
  parts.push('', `GATES: ${gates?.length ? gates.map((g) => g.name).join(', ') : '(none detected)'}`)
  return parts.join('\n')
}

export function renderDoctor(policy = {}, gates = [], probes = []) {
  const usable = probes.filter((p) => (Object.hasOwn(p, 'functional') ? p.functional : p.healthy)).length
  return [
    'WORKER ROSTER',
    renderRoster(probes),
    '',
    `${usable}/${probes.length} workers usable · minimum required: ${policy.minimumHealthyWorkers ?? '?'}`,
    `GATES: ${gates?.length ? gates.map((g) => g.name).join(', ') : '(none detected)'}`,
    `POLICY: isolation=${policy.isolation ?? 'none'} · maxParallelWorkers=${policy.maxParallelWorkers ?? '?'} · maxCostUsd=${policy.maxCostUsd ?? '∞'}`,
  ].join('\n')
}

export function renderStatus(data) {
  if (Array.isArray(data)) {
    if (!data.length) return 'No ultraswarm runs recorded yet.'
    return ['RUNS', table(['RUN', 'STATUS', 'UPDATED'], data.map((r) => [r.id, r.status, r.updated_at]))].join('\n')
  }
  const { run, tasks = [], attempts = [] } = data ?? {}
  if (!run) return 'Run not found.'
  const parts = [`RUN ${run.id}`, `status: ${run.status}`, '', 'TASKS', table(['TASK', 'STATUS', 'WAVE'], tasks.map((t) => [t.task_id ?? t.id, t.status, t.wave ?? '–']))]
  if (attempts.length) parts.push('', 'ATTEMPTS', table(['TASK', '#', 'WORKER', 'STATUS'], attempts.map((a) => [a.task_id, a.number, a.worker, a.status])))
  return parts.join('\n')
}
