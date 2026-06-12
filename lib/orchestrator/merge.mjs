import { execSync, execFileSync } from 'node:child_process'
const sh = (cmd, cwd) => execSync(cmd, { cwd, shell: '/bin/bash', encoding: 'utf8' })
const tryGate = (cmd, cwd) => { try { sh(cmd, cwd); return true } catch { return false } }

// approved: [{ task, cli, impl: { branch } }]. Sequential, gate after each, never blend.
export async function mergeWave(cfg, agent, approved) {
  const results = []
  for (const r of approved) {
    try {
      execFileSync('git', ['merge', '--squash', '--', r.impl.branch], { cwd: cfg.repo })
    } catch {
      try { execFileSync('git', ['merge', '--abort'], { cwd: cfg.repo }) }
      catch { execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: cfg.repo }) }
      results.push({ task: r.task, merged: false, reason: 'conflict (needs resolution)' })
      continue
    }
    // gates run via shell BY DESIGN; cfg.gates must come from trusted operator config
    // (detectGates builds 'npm run <script>'), never from untrusted plan/repo input.
    const ok = cfg.gates.every((g) => tryGate(g.cmd, cfg.repo))
    if (!ok) {
      execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: cfg.repo })
      results.push({ task: r.task, merged: false, reason: 'post-merge gate regression' })
      continue
    }
    // `git merge --squash` already stages exactly the merged diff in the index.
    // Do NOT `git add -A` here — that would sweep untracked host scaffolding
    // (.ultraswarm-plan.json, local config, .ultraswarm/ journal, .grok/) into the
    // feature commit (issue #12). Commit only what the squash staged.
    execFileSync('git', ['commit', '-q', '-m', `feat: ${r.task} (ultraswarm: ${r.cli})`], { cwd: cfg.repo })
    results.push({ task: r.task, merged: true })
  }
  return results
}
