import { execSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'; import path from 'node:path'
import { enhancedImplPrompt, buildWorkerTaskPrompt } from '../prompts.mjs'
import { resolveRoute } from '../../scripts/router.mjs'

const wtPath = (cfg, t, cli) => path.join(cfg.worktreeRoot, `${cfg.repoName}-us-${t.id}-${cli}`)
const branchName = (t, cli) => `ultraswarm/${t.id}-${cli}`
const sh = (cmd, cwd) => execSync(cmd, { cwd, shell: '/bin/bash', encoding: 'utf8' })

function resolveCommand(cfg, t, cli) {
  // Legacy registry (flat string or per-tier object) takes precedence.
  // This supports unit tests (that inject fake commands via registry) and any direct
  // "registry" usage in older configs. Modern path (overrides + DEFAULT) is used only
  // when no legacy entry is present for the cli.
  const entry = cfg.registry && cfg.registry[cli]
  if (entry) {
    return typeof entry === 'string' ? entry : (entry[t.model_tier] || entry.simple)
  }
  // Modern resolution (preferred for enabled/overrides configs from bin/runner)
  const route = resolveRoute({ ...t, cli }, cfg)
  return route.command
}
const parseTokens = (out) => { const m = (out || '').match(/tokens?\s*(?:used)?[:\s]+(\d+)/i); return m ? Number(m[1]) : 0 }

// Classify why a worker CLI invocation failed, so the report distinguishes "the CLI couldn't even
// launch" (auth/transport/not-installed — issue #8) from "it ran but produced bad code".
export function classifyWorkerError(e) {
  const text = `${e?.message || ''} ${e?.stderr || ''} ${e?.stdout || ''}`.toLowerCase()
  if (/\bauth|authorization|unauthorized|\blogin\b|credential|api[\s_-]?key/.test(text)) return 'auth'
  if (/transport|channel closed|\bmcp\b|\bdns\b|econnrefused|content-type|proxy/.test(text)) return 'transport'
  if (/command not found|not found|enoent|no such file/.test(text)) return 'not_installed'
  if (/timed? ?out|etimedout|\bkilled\b/.test(text)) return 'timeout'
  return 'error'
}
const workerErrorHint = (kind, cli) => ({
  auth: ` — ${cli} could not authenticate; run \`${cli} login\` (worker launch failure, issue #8)`,
  transport: ` — ${cli} transport/MCP failure (some CLIs fail this way from linked worktrees in TUI envs, issue #8)`,
  not_installed: ` — ${cli} not found on PATH`,
  timeout: ` — ${cli} exceeded its timeout`,
}[kind] || '')
const impl = (status, worktree, branch, files_changed, gate_results, summary, cli_tokens) =>
  ({ status, worktree, branch, files_changed, gate_results, summary, concerns: [], cli_tokens, model_used: 'external', complexity_achieved: 0 })

export async function runImplementation(cfg, t, cli, attempt, feedback) {
  const wt = wtPath(cfg, t, cli), br = branchName(t, cli)
  try {
    // resolveCommand can throw for an unknown cli/tier — keep it INSIDE the try so the task returns a
    // loud cli_failed result instead of propagating (which pipeline() would swallow → silent task loss).
    const command = resolveCommand(cfg, t, cli)
    const timeoutMs = cfg.timeouts?.[`${cli}-${t.model_tier}`] ?? cfg.timeouts?.[cli] ?? cfg.timeoutMs ?? 600000
    if (!fs.existsSync(wt)) execFileSync('git', ['worktree', 'add', wt, '-b', br, cfg.baseBranch], { cwd: cfg.repo })
    // Write ONLY the clean task for the external coding CLI (no wrapper meta-instructions).
    // The Node runner (this code) already handled worktree creation; the external CLI just implements.
    fs.writeFileSync(path.join(wt, '.ultraswarm-prompt.txt'), buildWorkerTaskPrompt(t, feedback))
    let out = ''
    // worker CLI runs via shell BY DESIGN; `command` is a registry invocation string (e.g. 'codex exec ...')
    try { out = execSync(command, { cwd: wt, shell: '/bin/bash', encoding: 'utf8', timeout: timeoutMs }) }
    catch (e) {
      const kind = classifyWorkerError(e)
      return impl('cli_failed', wt, br, [], [], `worker ${cli} failed (${kind})${workerErrorHint(kind, cli)}: ${e.message}`, parseTokens(e.stdout))
    }

    // Early "did anything change?" gate (right after worker, before gates)
    const preGateChanged = sh('git status --porcelain', wt).split('\n').filter(Boolean).map((l) => l.slice(3))
    if (preGateChanged.length === 0) {
      fs.rmSync(path.join(wt, '.ultraswarm-prompt.txt'), { force: true })
      return impl('no_changes', wt, br, [], [], `CLI produced no file changes on attempt ${attempt} on ${cli}`, parseTokens(out))
    }
    // gates run via shell BY DESIGN; cfg.gates must come from trusted operator config
    // (detectGates builds 'npm run <script>'), never from untrusted plan/repo input.
    const gate_results = cfg.gates.map((g) => {
      try { sh(g.cmd, wt); return { name: g.name, pass: true } }
      catch (e) { return { name: g.name, pass: false, detail: String(e.stderr || e.message).slice(0, 500) } }
    })
    fs.rmSync(path.join(wt, '.ultraswarm-prompt.txt'), { force: true })
    const changed = sh('git status --porcelain', wt).split('\n').filter(Boolean).map((l) => l.slice(3))
    execFileSync('git', ['add', '-A'], { cwd: wt })
    try { execFileSync('git', ['commit', '-q', '-m', `ultraswarm: ${t.id}/${t.model_tier} attempt ${attempt}`], { cwd: wt }) } catch {}
    const status = gate_results.every((g) => g.pass) ? 'ok' : 'gates_failed'
    return impl(status, wt, br, changed, gate_results, `attempt ${attempt} on ${cli}`, parseTokens(out))
  } catch (e) { return impl('cli_failed', wt, br, [], [], `wrapper error: ${e.message}`, 0) }
}
