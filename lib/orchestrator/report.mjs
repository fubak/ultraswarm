import { execSync, execFileSync } from 'node:child_process'

// Compact token count for the headline only (847200 → "847K", 1.2e6 → "1.2M"). The exact figure
// stays in the "Tokens saved" detail line below; this is purely the at-a-glance top number.
function compactTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(n)
}

const taskWord = (n) => (n === 1 ? 'task' : 'tasks')

// This is the RUN-END report, printed while the run is still awaiting_merge — the work lives on the
// run's integration branch, not the operator's checked-out branch (cli.mjs prints the
// `ultraswarm merge … --approve` line right after). So the accurate verb here is "integrated", which
// also matches what `status` shows; "merged" is reserved for after that approval.
export function buildReport({ merged = [], failed = [], blocked = [], externalTokens = 0, attempts = {}, taskCount, tokenCoverage } = {}) {
  const att = (id) => (attempts[id] != null ? String(attempts[id]) : '—')

  const mergedOk = merged.filter((m) => m.merged).length
  const total = taskCount ?? (merged.length + failed.length + blocked.length)
  const pct = total > 0 ? Math.round((mergedOk / total) * 100) : 0

  // Headline FIRST — the verdict (where ultraswarm succeeded) and the offload, on bold lines above
  // the per-task table. A large swarm's table can run to dozens of rows; leading with the outcome
  // means the result and the savings are readable no matter how many agents ran.
  // A task in `merged` with merged:false passed review but regressed at the integration gate — a
  // third drop category beyond failed (exhausted attempts) and blocked (dependency didn't land). It
  // must appear in the headline too, or the counts silently don't add up to the total (Rule 12).
  const notIntegrated = merged.filter((m) => !m.merged).length
  const failBits = [
    failed.length && `${failed.length} failed`,
    blocked.length && `${blocked.length} blocked`,
    notIntegrated && `${notIntegrated} not integrated`,
  ].filter(Boolean).join(' · ')
  const verdict =
    total === 0 ? 'No tasks in this run.'
    : mergedOk === 0 ? `✗ 0 of ${total} ${taskWord(total)} integrated — nothing landed${failBits ? ` (${failBits})` : ''}`
    : mergedOk === total ? `✓ All ${total} ${taskWord(total)} integrated (100%)`
    : `✓ ${mergedOk} of ${total} ${taskWord(total)} integrated (${pct}%)${failBits ? ` · ${failBits}` : ''}`

  // Offload headline — only as precise as the data honestly allows (Rule 12). externalTokens is a
  // floor summed from the few CLIs that report usage, so a bare "≈ N tokens" badly understates the
  // work when coverage is partial, and "≈ 0 tokens" is actively misleading when NO worker reported.
  // Three framings: full coverage → the figure; partial → an explicit floor with the ratio; none →
  // state that the offload happened but isn't measurable, never a fake number.
  const partialCoverage = tokenCoverage && tokenCoverage.captured > 0 && tokenCoverage.captured < tokenCoverage.total
  const offloadLine =
    total === 0 ? null
    : externalTokens > 0
      ? (partialCoverage
        ? `**≈ ${compactTokens(externalTokens)}+ tokens** offloaded to external CLIs — a floor: only ${tokenCoverage.captured} of ${tokenCoverage.total} tasks reported usage, so the real total is higher.`
        : `**≈ ${compactTokens(externalTokens)} tokens** offloaded to external CLIs — Claude ran orchestration + QA only.`)
      : `**Implementation ran on external CLIs**, off your Claude context — these workers don't report token usage, so the offload isn't measurable here.`

  const lines = ['# ultraswarm run report', '', `**${verdict}**`]
  if (offloadLine) lines.push(offloadLine)
  lines.push('')
  // Make the staging reality unmissable so "integrated" is never mistaken for "landed on my branch".
  if (mergedOk > 0) lines.push(`_Staged on this run's integration branch — nothing lands on your checked-out branch until you approve the merge below._`, '')
  lines.push('| task | worker | status | attempts |', '|---|---|---|---|')
  for (const m of merged) lines.push(`| ${m.task} | ${m.cli ?? '—'} | ${m.merged ? 'integrated ✓' : `NOT integrated — ${m.reason}`} | ${att(m.task)} |`)
  for (const id of failed) lines.push(`| ${id} | — | FAILED (exhausted) | ${att(id)} |`)
  for (const b of blocked) lines.push(`| ${b.task} | — | blocked — ${b.reason} | — |`)

  // Per-worker contribution — which CLI actually landed which integrated tasks.
  const byWorker = {}
  for (const m of merged) if (m.merged && m.cli) byWorker[m.cli] = (byWorker[m.cli] ?? 0) + 1
  const workers = Object.entries(byWorker).sort((a, b) => b[1] - a[1])

  lines.push('', `## Summary`, `${mergedOk}/${total} integrated · ${failed.length} failed · ${blocked.length} blocked (${pct}% success).`)
  if (workers.length) lines.push('', `Workers that integrated: ${workers.map(([w, n]) => `${w} (${n})`).join(', ')}.`)
  // Surface retries so a >1 attempt count isn't a silent mystery — a task only re-ran because an
  // earlier attempt failed its gates or was rejected by review. Scope to tasks that DID integrate;
  // a failed task's retries are already implied by its "FAILED (exhausted)" row.
  const integratedIds = new Set(merged.filter((m) => m.merged).map((m) => m.task))
  const retried = Object.entries(attempts).filter(([id, n]) => n > 1 && integratedIds.has(id)).map(([id, n]) => `${id} (${n} attempts)`)
  if (retried.length) lines.push('', `Retried before passing: ${retried.join(', ')} — an earlier attempt failed gates or review.`)

  // Tokens saved: the implementation work ran on external CLIs, OFF Claude's context window. We can
  // only count tokens the CLIs actually report (most don't — see docs/notes/cli-verification.md), so
  // this is an honest UNDERCOUNT (a floor), not a billing figure.
  const cov = tokenCoverage ? ` across ${tokenCoverage.captured}/${tokenCoverage.total} tasks that reported usage` : ''
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
