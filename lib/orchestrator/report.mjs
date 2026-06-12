import { execSync } from 'node:child_process'

export function buildReport({ merged, failed, externalTokens }) {
  const lines = ['# ultraswarm run report', '', '| task | status |', '|---|---|']
  for (const m of merged) lines.push(`| ${m.task} | ${m.merged ? 'merged ✓' : `NOT merged — ${m.reason}`} |`)
  for (const id of failed) lines.push(`| ${id} | FAILED (exhausted) |`)
  lines.push('', `External CLI tokens (best-effort): ~${externalTokens}`)
  return lines.join('\n')
}

// Remove ultraswarm worktrees + branches after the report.
export function cleanup(cfg) {
  try {
    const list = execSync('git worktree list --porcelain', { cwd: cfg.repo, encoding: 'utf8' })
    for (const line of list.split('\n')) {
      if (line.startsWith('worktree ') && line.includes(`${cfg.repoName}-us-`)) {
        const p = line.slice('worktree '.length)
        try { execSync(`git worktree remove --force ${p}`, { cwd: cfg.repo }) } catch { /* best-effort */ }
      }
    }
    execSync(`git branch --list 'ultraswarm/*' | xargs -r git branch -D`, { cwd: cfg.repo, shell: '/bin/bash' })
  } catch { /* cleanup is best-effort; never fail the run on it */ }
}
