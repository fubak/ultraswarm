import { execSync } from 'node:child_process'
const sh = (cmd, cwd) => execSync(cmd, { cwd, shell: '/bin/bash', encoding: 'utf8' })
const tryGate = (cmd, cwd) => { try { sh(cmd, cwd); return true } catch { return false } }

// approved: [{ task, cli, impl: { branch } }]. Sequential, gate after each, never blend.
export async function mergeWave(cfg, agent, approved) {
  const results = []
  for (const r of approved) {
    try {
      sh(`git merge --squash ${r.impl.branch}`, cfg.repo)
    } catch {
      sh('git merge --abort || git reset --hard HEAD', cfg.repo)
      results.push({ task: r.task, merged: false, reason: 'conflict (needs resolution)' })
      continue
    }
    const ok = cfg.gates.every((g) => tryGate(g.cmd, cfg.repo))
    if (!ok) { sh('git reset --hard HEAD', cfg.repo); results.push({ task: r.task, merged: false, reason: 'post-merge gate regression' }); continue }
    sh(`git add -A && git commit -q -m "feat: ${r.task} (ultraswarm: ${r.cli})"`, cfg.repo)
    results.push({ task: r.task, merged: true })
  }
  return results
}
