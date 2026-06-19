import { execSync, execFileSync } from 'node:child_process'

export function buildReport({ merged = [], failed = [], blocked = [], externalTokens = 0, attempts = {}, taskCount, tokenCoverage } = {}) {
  const att = (id) => (attempts[id] != null ? String(attempts[id]) : '—')
  const lines = ['# ultraswarm run report', '', '| task | worker | status | attempts |', '|---|---|---|---|']
  for (const m of merged) lines.push(`| ${m.task} | ${m.cli ?? '—'} | ${m.merged ? 'merged ✓' : `NOT merged — ${m.reason}`} | ${att(m.task)} |`)
  for (const id of failed) lines.push(`| ${id} | — | FAILED (exhausted) | ${att(id)} |`)
  for (const b of blocked) lines.push(`| ${b.task} | — | blocked — ${b.reason} | — |`)

  const mergedOk = merged.filter((m) => m.merged).length
  const total = taskCount ?? (merged.length + failed.length + blocked.length)
  const pct = total > 0 ? Math.round((mergedOk / total) * 100) : 0

  // Per-worker contribution — which CLI actually landed which merged tasks.
  const byWorker = {}
  for (const m of merged) if (m.merged && m.cli) byWorker[m.cli] = (byWorker[m.cli] ?? 0) + 1
  const workers = Object.entries(byWorker).sort((a, b) => b[1] - a[1])

  lines.push('', `## Summary`, `${mergedOk}/${total} merged · ${failed.length} failed · ${blocked.length} blocked (${pct}% success).`)
  if (workers.length) lines.push('', `Workers that merged: ${workers.map(([w, n]) => `${w} (${n})`).join(', ')}.`)

  // Tokens saved: the implementation work ran on external CLIs, OFF Claude's context window. We can
  // only count tokens the CLIs actually report (most don't — see docs/notes/cli-verification.md), so
  // this is an honest UNDERCOUNT (a floor), not a billing figure.
  const cov = tokenCoverage ? ` across ${tokenCoverage.captured}/${tokenCoverage.total} runs that report usage` : ''
  lines.push('', `## Tokens saved (estimate)`)
  lines.push(`≈ ${externalTokens.toLocaleString()} external CLI tokens did the implementation work off your Claude context${cov}.`)
  lines.push(`This is a floor: most worker CLIs don't emit token counts, so the real offloaded total is higher. Claude's role here was orchestration + QA review only.`)
  return lines.join('\n')
}

// Remove ultraswarm worktrees + branches after the report.
export function cleanup(cfg) {
  try {
    const list = execSync('git worktree list --porcelain', { cwd: cfg.repo, encoding: 'utf8' })
    for (const line of list.split('\n')) {
      if (line.startsWith('worktree ') && line.includes(`${cfg.repoName}-us-`)) {
        const p = line.slice('worktree '.length)
        try { execFileSync('git', ['worktree', 'remove', '--force', '--', p], { cwd: cfg.repo }) } catch { /* best-effort */ }
      }
    }
    // Scope branch deletion to THIS run's branches only — never force-delete another run's
    // ultraswarm/* branches and lose its unmerged work (#SE2). Per-task branches are
    // `ultraswarm/<taskId>-<cli>` (cli may be an alternate, and may itself contain dashes), so match
    // by task-id prefix; the integration branch is `ultraswarm/run-<runId>`.
    const taskIds = (cfg.tasks || []).map((t) => t.id)
    const integrationBranch = `ultraswarm/run-${cfg.runId}`
    const branchOut = execFileSync('git', ['branch', '--list', 'ultraswarm/*'], { cwd: cfg.repo, encoding: 'utf8' })
    for (const raw of branchOut.split('\n')) {
      const name = raw.replace(/^\*?\s+/, '').trim()
      if (!name) continue
      const isMine = name === integrationBranch || taskIds.some((id) => name.startsWith(`ultraswarm/${id}-`))
      if (isMine) {
        try { execFileSync('git', ['branch', '-D', name], { cwd: cfg.repo }) } catch { /* best-effort */ }
      }
    }
  } catch { /* cleanup is best-effort; never fail the run on it */ }
}
