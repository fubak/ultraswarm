import { execSync, execFileSync } from 'node:child_process'
import { table } from '../render.mjs'
import { c, colorizeLine } from '../color.mjs'

const taskWord = (n) => (n === 1 ? 'task' : 'tasks')

// Human-readable wall-clock for the offload section (229_000ms → "3m 49s", 47_000 → "47s").
function formatDuration(ms) {
  const s = Math.round((ms || 0) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), rem = s % 60
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// This is the RUN-END report, printed while the run is still awaiting_merge — the work lives on the
// run's integration branch, not the operator's checked-out branch (cli.mjs prints the
// `ultraswarm merge … --approve` line right after). So the accurate verb here is "integrated", which
// also matches what `status` shows; "merged" is reserved for after that approval.
export function buildReport({ merged = [], failed = [], blocked = [], externalTokens = 0, attempts = {}, taskCount, tokenCoverage, workerAttempts = 0, externalWallMs = 0, cliUsage = [], runWallMs = 0, markdown = false } = {}) {
  const att = (id) => (attempts[id] != null ? String(attempts[id]) : '—')
  // Default rendering targets a raw terminal (matching PLAN PREVIEW / WORKER ROSTER): plain UPPERCASE
  // section headers, ANSI emphasis/colour that auto-disables off a TTY. `markdown:true` (CLI
  // `--markdown`) restores GitHub-markdown headers/bold for pasting into a PR or issue.
  const h1 = (s) => (markdown ? `# ${s}` : s.toUpperCase())
  const h2 = (s) => (markdown ? `## ${s}` : s.toUpperCase())
  const em = (s) => (markdown ? `**${s}**` : c.bold(s))

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

  // Offload headline — a QUALITATIVE value statement, never a fabricated token count. The detail
  // ("Claude ran orchestration + QA only", attempts, wall-clock) lives in the "Work offloaded"
  // section below, so the headline stays a single short line (no duplicated value-prop sentence).
  const offloadLine = total === 0 ? null : em('Implementation ran on external CLIs — off your Claude context.')

  // Verdict leads, colour-coded by outcome (green pass / red fail) in plain mode; bold in markdown.
  const lines = [h1('ultraswarm run report'), '', markdown ? `**${verdict}**` : colorizeLine(verdict)]
  if (offloadLine) lines.push(offloadLine)
  lines.push('')
  // Make the staging reality unmissable so "integrated" is never mistaken for "landed on my branch".
  if (mergedOk > 0) {
    const note = "Staged on this run's integration branch — nothing lands on your checked-out branch until you approve the merge below."
    lines.push(markdown ? `_${note}_` : c.dim(note), '')
  }
  // Per-task table — fixed-width aligned (same `table()` as the per-CLI/roster tables), NOT markdown,
  // so it reads cleanly in a raw terminal. status is left-aligned (variable-length text), attempts
  // right-aligned.
  const taskRows = [
    ...merged.map((m) => [m.task, m.cli ?? '—', m.merged ? 'integrated ✓' : `NOT integrated — ${m.reason}`, att(m.task)]),
    ...failed.map((id) => [id, '—', 'FAILED (exhausted)', att(id)]),
    ...blocked.map((b) => [b.task, '—', `blocked — ${b.reason}`, '—']),
  ]
  lines.push(table(['task', 'worker', 'status', 'attempts'], taskRows, ['left', 'left', 'left', 'right']))

  // Per-worker contribution — which CLI actually landed which integrated tasks.
  const byWorker = {}
  for (const m of merged) if (m.merged && m.cli) byWorker[m.cli] = (byWorker[m.cli] ?? 0) + 1
  const workers = Object.entries(byWorker).sort((a, b) => b[1] - a[1])

  lines.push('', h2('Summary'), `${mergedOk}/${total} integrated · ${failed.length} failed · ${blocked.length} blocked (${pct}% success).`)
  // Total wall-clock the whole run actually took (less than summed external compute, thanks to
  // parallelism) — the "how long did it take" number. Only when the caller measured it.
  if (runWallMs > 0) lines.push(`Wall-clock: ${formatDuration(runWallMs)}.`)
  if (workers.length) lines.push('', `Workers that integrated: ${workers.map(([w, n]) => `${w} (${n})`).join(', ')}.`)
  // Surface retries so a >1 attempt count isn't a silent mystery — a task only re-ran because an
  // earlier attempt failed its gates or was rejected by review. Scope to tasks that DID integrate;
  // a failed task's retries are already implied by its "FAILED (exhausted)" row.
  const integratedIds = new Set(merged.filter((m) => m.merged).map((m) => m.task))
  const retried = Object.entries(attempts).filter(([id, n]) => n > 1 && integratedIds.has(id)).map(([id, n]) => `${id} (${n} attempts)`)
  if (retried.length) lines.push('', `Retried before passing: ${retried.join(', ')} — an earlier attempt failed gates or review.`)

  // Work offloaded: report what is actually MEASURED — how many tasks/worker-attempts ran on external
  // CLIs and their total wall-clock — not a scraped token guess. A token/cost figure appears ONLY when
  // a worker reported it through structured usage (externalTokens > 0); otherwise we say so plainly
  // instead of inventing a misleading "≈ N tokens" (Rule 12). The value prop is the offload itself:
  // the implementation compute ran off Claude's context; Claude only orchestrated and QA'd.
  lines.push('', h2('Work offloaded'))
  const attemptsBit = workerAttempts > 0 ? ` (${workerAttempts} worker attempt${workerAttempts === 1 ? '' : 's'})` : ''
  lines.push(`${total} ${taskWord(total)}${attemptsBit} implemented by external CLIs, off your Claude context — Claude ran orchestration + QA review only.`)
  if (externalWallMs > 0) lines.push(`≈ ${formatDuration(externalWallMs)} of external CLI compute ran off your context.`)
  // Token usage: prefer the per-CLI breakdown (real, structured capture) when present. "spent" is ALL
  // tokens a CLI used (incl. rejected retries + competition losers); "landed" is the subset that
  // produced the integrated result; overhead = spent − landed is what the retry/competition cost.
  const num = (n) => n.toLocaleString()
  const spentTotal = cliUsage.reduce((s, u) => s + u.spent, 0)
  if (cliUsage.length && spentTotal > 0) {
    const landedTotal = cliUsage.reduce((s, u) => s + u.landed, 0)
    const overheadTotal = spentTotal - landedTotal
    lines.push(overheadTotal > 0
      ? `Workers used ≈ ${num(spentTotal)} tokens — ≈ ${num(landedTotal)} on work that landed, ≈ ${num(overheadTotal)} on retries + competition:`
      : `Workers used ≈ ${num(spentTotal)} tokens of usage:`)
    // Fixed-width aligned table (matches the PLAN PREVIEW / WORKER ROSTER style), NOT a markdown
    // table — the report is read raw in a terminal, where `| … |` pipes don't align and `|---|`
    // separators are noise. Numeric columns are right-aligned so digits line up.
    const oh = (n) => `${n > 0 ? '+' : ''}${num(n)}`
    const rows = cliUsage.map((u) => [u.cli, u.attempts, num(u.landed), num(u.spent), oh(u.spent - u.landed)])
    if (cliUsage.length > 1) rows.push(['Total', cliUsage.reduce((s, u) => s + u.attempts, 0), num(landedTotal), num(spentTotal), oh(overheadTotal)])
    lines.push('', table(['CLI', 'attempts', 'landed', 'spent', 'overhead'], rows, ['left', 'right', 'right', 'right', 'right']))
  } else if (externalTokens > 0) {
    const cov = tokenCoverage && tokenCoverage.captured < tokenCoverage.total
      ? ` (only ${tokenCoverage.captured} of ${tokenCoverage.total} attempts reported usage — a floor)` : ''
    lines.push(`Workers reported ≈ ${num(externalTokens)} tokens of usage${cov}.`)
  } else {
    lines.push(`Token/cost usage: not reported by these CLIs (most external coding CLIs don't emit per-run counts).`)
  }
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
