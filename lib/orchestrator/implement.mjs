import { execSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'; import path from 'node:path'
import { log } from '../engine.mjs'
import { buildWorkerTaskPrompt } from '../prompts.mjs'
import { resolveRoute } from '../router.mjs'
import { forbiddenViolations } from '../policy.mjs'
import { installWorktreeDeps } from './worktree-deps.mjs'

// Reset a worktree to a clean state (no leftover partial files) for the next attempt. argv form
// only — never a shell string. Best-effort: a failed reset must not mask the original failure.
const resetWorktree = (wt) => {
  try { execFileSync('git', ['reset', '--hard'], { cwd: wt, stdio: 'ignore' }) } catch {}
  try { execFileSync('git', ['clean', '-fd'], { cwd: wt, stdio: 'ignore' }) } catch {}
}

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
// Worker subprocess env allowlist. Exported so the functional smoke probe (lib/workers/smoke.mjs)
// reproduces the EXACT environment a real worker run sees — otherwise a probe could pass with creds
// the real run lacks (or vice-versa).
export const allowedEnv = (cfg = {}) => {
  const names = new Set(['HOME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', ...(cfg.workerEnvAllowlist ?? [])])
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => names.has(key) || key.startsWith('XDG_')))
}

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
    if (cfg.policy?.maxCostUsd != null && cfg.store?.totalCost() >= cfg.policy.maxCostUsd) {
      return impl('policy_blocked', wt, br, [], [], `cost budget $${cfg.policy.maxCostUsd} exhausted`, 0)
    }
    // resolveCommand can throw for an unknown cli/tier — keep it INSIDE the try so the task returns a
    // loud cli_failed result instead of propagating (which pipeline() would swallow → silent task loss).
    const command = resolveCommand(cfg, t, cli)
    const timeoutMs = cfg.timeouts?.[`${cli}-${t.model_tier}`] ?? cfg.timeouts?.[cli] ?? cfg.timeoutMs ?? 600000
    if (!fs.existsSync(wt)) {
      // A prior attempt's worktree may have been removed while its branch lingers — prune stale
      // worktree refs and drop the leftover branch so the add doesn't die with
      // "a branch named '<br>' already exists" on retry (issue #13).
      try { execFileSync('git', ['worktree', 'prune'], { cwd: cfg.repo, stdio: 'ignore' }) } catch {}
      try { execFileSync('git', ['branch', '-D', br], { cwd: cfg.repo, stdio: 'ignore' }) } catch {}
      execFileSync('git', ['worktree', 'add', wt, '-b', br, cfg.baseBranch], { cwd: cfg.repo })
      // Install deps in the fresh worktree (no node_modules until we do) so gates run the same env the
      // integration gate will — not one that depends on the worker incidentally installing (#36). Only
      // on first creation; a reused worktree already has them. Surface a failure as a DISTINCT deps_failed
      // so it is never mislabeled as bad model output (Rule 12).
      try { installWorktreeDeps(wt) }
      catch (e) { return impl('deps_failed', wt, br, [], [], `dependency install failed in worktree (#36): ${String(e.stderr || e.message).slice(0, 500)}`, 0) }
    }
    // Write ONLY the clean task for the external coding CLI (no wrapper meta-instructions).
    // The Node runner (this code) already handled worktree creation; the external CLI just implements.
    fs.writeFileSync(path.join(wt, '.ultraswarm-prompt.txt'), buildWorkerTaskPrompt(t, feedback))
    let out = '', supervised = null, attemptId = null
    // Gate the actual worker subprocess on the per-run limiter so concurrent workers never exceed
    // policy.maxParallelWorkers. Gating the leaf (not the caller) keeps high-risk competition — which
    // spawns several runImplementation calls in parallel() — deadlock-free: a slot is held only for
    // the duration of one worker run, never across nested worker spawns.
    const gate = cfg.workerLimit ?? ((fn) => fn())
    // worker CLI runs via shell BY DESIGN; `command` is a registry invocation string (e.g. 'codex exec ...')
    try {
      await gate(async () => {
        if (cfg.workerManager) {
          supervised = await cfg.workerManager.get(cli).execute({ task: t, cwd: wt, timeoutMs, env: allowedEnv(cfg), label: `${cfg.runId ?? 'run'}-${t.id}-${attempt}`,
            onStart: ({ pid, logPath }) => {
              // Per-agent dispatch line — makes every worker visible the moment it starts.
              log(`▶ ${t.id} → ${cli}@${t.model_tier || 'simple'} attempt ${attempt}${pid ? ` [pid ${pid}]` : ''}`)
              if (cfg.store && cfg.runId) attemptId = cfg.store.startAttempt({ runId: cfg.runId, taskId: t.id, number: attempt, worker: cli, model: t.model_tier, pid, logPath })
            } })
          out = `${supervised.stdout}\n${supervised.stderr}`
          if (supervised.code !== 0) throw Object.assign(new Error(`worker exited ${supervised.code}`), { stdout: supervised.stdout, stderr: supervised.stderr, supervised })
        } else out = execSync(command, { cwd: wt, shell: '/bin/bash', encoding: 'utf8', timeout: timeoutMs })
      })
    }
    catch (e) {
      const kind = e.supervised ? cfg.workerManager.get(cli).classifyFailure(e.supervised) : classifyWorkerError(e)
      if (attemptId) cfg.store.finishAttempt(attemptId, { status: 'failed', exitCode: e.supervised?.code, durationMs: e.supervised?.durationMs, errorKind: kind })
      // A crashed/timed-out attempt can leave a dirty worktree that a later attempt reuses (the wt is
      // reused at the top when it already exists). Drop the prompt file and reset to a clean base so the
      // next attempt starts clean (HIGH).
      fs.rmSync(path.join(wt, '.ultraswarm-prompt.txt'), { force: true })
      resetWorktree(wt)
      return impl('cli_failed', wt, br, [], [], `worker ${cli} failed (${kind})${workerErrorHint(kind, cli)}: ${e.message}`, parseTokens(e.stdout))
    }

    // Early "did anything change?" gate (right after worker, before gates).
    // -uall lists untracked files individually; without it git collapses a brand-new directory
    // to "dir/", which would hide the real paths from the forbiddenPaths check + files_changed.
    const preGateChanged = sh('git status --porcelain -uall', wt).split('\n').filter(Boolean).map((l) => l.slice(3))
    if (preGateChanged.length === 0) {
      fs.rmSync(path.join(wt, '.ultraswarm-prompt.txt'), { force: true })
      if (attemptId) cfg.store.finishAttempt(attemptId, { status: 'failed', errorKind: 'no_changes' })
      return impl('no_changes', wt, br, [], [], `CLI produced no file changes on attempt ${attempt} on ${cli}`, parseTokens(out))
    }
    // gates run via shell BY DESIGN; cfg.gates must come from trusted operator config
    // (detectGates builds 'npm run <script>'), never from untrusted plan/repo input.
    const gate_results = [...cfg.gates, ...(t.contract?.commands || []).map((cmd, index) => ({ name: `contract-${index + 1}`, cmd }))].map((g) => {
      try { sh(g.cmd, wt); return { name: g.name, pass: true } }
      catch (e) { return { name: g.name, pass: false, detail: String(e.stderr || e.message).slice(0, 500) } }
    })
    fs.rmSync(path.join(wt, '.ultraswarm-prompt.txt'), { force: true })
    const changed = sh('git status --porcelain -uall', wt).split('\n').filter(Boolean).map((l) => l.slice(3))
    // Enforce forbiddenPaths against what the worker ACTUALLY wrote (not just declared task.files).
    // Block BEFORE the success commit, mirroring the maxCostUsd block above (B1).
    const forbidden = forbiddenViolations(changed, cfg.policy)
    if (forbidden.length) {
      resetWorktree(wt)
      if (attemptId) cfg.store.finishAttempt(attemptId, { status: 'failed', errorKind: 'policy_blocked' })
      return impl('policy_blocked', wt, br, [], [], `forbidden path written: ${forbidden.join('; ')}`, parseTokens(out))
    }
    const allowed = t.contract?.allowed_paths
    if (allowed?.length) {
      const outside = changed.filter((file) => !allowed.some((prefix) => file === prefix || file.startsWith(`${prefix.replace(/\/$/, '')}/`)))
      if (outside.length) gate_results.push({ name: 'allowed-paths', pass: false, detail: `changed outside contract: ${outside.join(', ')}` })
    }
    execFileSync('git', ['add', '-A'], { cwd: wt })
    // Fail LOUD if the success commit fails (hooks, identity, index). Swallowing it left an empty
    // branch that merges nothing while the task was reported 'ok' and "integrated" (#S3).
    try { execFileSync('git', ['commit', '-q', '-m', `ultraswarm: ${t.id}/${t.model_tier} attempt ${attempt}`], { cwd: wt }) }
    catch (e) {
      if (attemptId) cfg.store.finishAttempt(attemptId, { status: 'failed', errorKind: 'commit_failed' })
      return impl('cli_failed', wt, br, changed, gate_results, `success commit failed for ${t.id} (#S3): ${String(e.stderr || e.message).slice(0, 300)}`, parseTokens(out))
    }
    const status = gate_results.every((g) => g.pass) ? 'ok' : 'gates_failed'
    if (gate_results.length) log(`${status === 'ok' ? '✓' : '✗'} ${t.id} gates: ${gate_results.map((g) => `${g.pass ? '✓' : '✗'}${g.name}`).join(' ')}`)
    if (attemptId) cfg.store.finishAttempt(attemptId, { status: status === 'ok' ? 'passed' : 'failed', exitCode: supervised?.code ?? 0,
      durationMs: supervised?.durationMs, outputTokens: supervised?.usage?.totalTokens ?? parseTokens(out), costUsd: supervised?.usage?.costUsd })
    if (cfg.store && supervised) cfg.store.recordMetric(cli, cfg.taskClasses?.[t.id] ?? 'general',
      { passed: status === 'ok', durationMs: supervised.durationMs, costUsd: supervised.usage?.costUsd ?? 0 })
    return impl(status, wt, br, changed, gate_results, `attempt ${attempt} on ${cli}`, parseTokens(out))
  } catch (e) { return impl('cli_failed', wt, br, [], [], `wrapper error: ${e.message}`, 0) }
}
