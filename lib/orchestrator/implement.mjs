import { execSync } from 'node:child_process'
import fs from 'node:fs'; import path from 'node:path'
import { enhancedImplPrompt } from '../prompts.mjs'

const wtPath = (cfg, t, cli) => path.join(cfg.worktreeRoot, `${cfg.repoName}-us-${t.id}-${cli}`)
const branchName = (t, cli) => `ultraswarm/${t.id}-${cli}`
const sh = (cmd, cwd) => execSync(cmd, { cwd, shell: '/bin/bash', encoding: 'utf8' })

function resolveCommand(cfg, t, cli) {
  const entry = cfg.registry[cli]
  return typeof entry === 'string' ? entry : (entry[t.model_tier] || entry.simple)
}
const parseTokens = (out) => { const m = (out || '').match(/tokens?\s*(?:used)?[:\s]+(\d+)/i); return m ? Number(m[1]) : 0 }
const impl = (status, worktree, branch, files_changed, gate_results, summary, cli_tokens) =>
  ({ status, worktree, branch, files_changed, gate_results, summary, concerns: [], cli_tokens, model_used: 'external', complexity_achieved: 0 })

export async function runImplementation(cfg, t, cli, attempt, feedback) {
  const wt = wtPath(cfg, t, cli), br = branchName(t, cli)
  const command = resolveCommand(cfg, t, cli)
  const timeoutMs = cfg.timeouts?.[`${cli}-${t.model_tier}`] ?? cfg.timeouts?.[cli] ?? cfg.timeoutMs ?? 600000
  try {
    if (!fs.existsSync(wt)) sh(`git worktree add ${wt} -b ${br} ${cfg.baseBranch}`, cfg.repo)
    fs.writeFileSync(path.join(wt, '.ultraswarm-prompt.txt'),
      enhancedImplPrompt(cfg, t, cli, attempt, feedback, command, timeoutMs))
    let out = ''
    try { out = execSync(command, { cwd: wt, shell: '/bin/bash', encoding: 'utf8', timeout: timeoutMs }) }
    catch (e) { return impl('cli_failed', wt, br, [], [], `CLI failed: ${e.message}`, parseTokens(e.stdout)) }
    const gate_results = cfg.gates.map((g) => {
      try { sh(g.cmd, wt); return { name: g.name, pass: true } }
      catch (e) { return { name: g.name, pass: false, detail: String(e.stderr || e.message).slice(0, 500) } }
    })
    fs.rmSync(path.join(wt, '.ultraswarm-prompt.txt'), { force: true })
    const changed = sh('git status --porcelain', wt).split('\n').filter(Boolean).map((l) => l.slice(3))
    sh(`git add -A && git commit -q -m "ultraswarm: ${t.id}/${t.model_tier} attempt ${attempt}" || true`, wt)
    const status = gate_results.every((g) => g.pass) ? 'ok' : 'gates_failed'
    return impl(status, wt, br, changed, gate_results, `attempt ${attempt} on ${cli}`, parseTokens(out))
  } catch (e) { return impl('cli_failed', wt, br, [], [], `wrapper error: ${e.message}`, 0) }
}
