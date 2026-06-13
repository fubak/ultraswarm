import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { loadConfig, validateConfig } from '../scripts/router.mjs'
import { validatePlan } from '../lib/plan-schema.mjs'
import { resolvePolicy, validatePolicy, enforceTaskPolicy, requireApproval } from '../lib/policy.mjs'
import { openRepoStore } from '../lib/state/store.mjs'
import { WorkerManager } from '../lib/workers/adapters.mjs'
import { terminateTree } from '../lib/workers/supervisor.mjs'
import { routeTask } from '../lib/routing.mjs'
import { computeWaves } from '../lib/orchestrator/waves.mjs'
import { createIntegrationWorktree, mergeApprovedRun, removeIntegrationWorktree } from '../lib/orchestrator/integration.mjs'
import { runSwarm } from '../lib/orchestrator/runner.mjs'
import { buildReport, cleanup } from '../lib/orchestrator/report.mjs'
import { decompose } from '../lib/orchestrator/decompose.mjs'
import { AnthropicClient } from '../lib/llm/anthropic.mjs'
import { ClaudeCliClient } from '../lib/llm/claude-cli.mjs'
import { resolveBrainModel } from '../lib/llm/brain-router.mjs'

export const EXIT = { OK: 0, RUNTIME: 1, USAGE: 2, APPROVAL: 3, BLOCKED: 4 }

const value = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const has = (args, flag) => args.includes(flag)
const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

export function detectGates(repo) {
  const file = path.join(repo, 'package.json')
  if (!fs.existsSync(file)) return []
  const scripts = JSON.parse(fs.readFileSync(file, 'utf8')).scripts || {}
  return ['build', 'test', 'lint'].filter((name) => scripts[name]).map((name) => ({ name, cmd: `npm run ${name}` }))
}

function brain() {
  if (process.env.ULTRASWARM_BRAIN === 'anthropic-api') return new AnthropicClient()
  if (process.env.ULTRASWARM_BRAIN === 'claude-cli') return new ClaudeCliClient()
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return new ClaudeCliClient() } catch { return new AnthropicClient() }
}

function loadContext(repo) {
  const config = loadConfig()
  const configCheck = validateConfig(config)
  if (!configCheck.valid) throw new Error(`invalid config: ${configCheck.errors.join('; ')}`)
  const policy = resolvePolicy(config)
  const policyCheck = validatePolicy(policy)
  if (!policyCheck.valid) throw new Error(`invalid policy: ${policyCheck.errors.join('; ')}`)
  return { repo, config, policy, baseSha: git(repo, ['rev-parse', 'HEAD']), gates: detectGates(repo) }
}

async function loadPlan(args, context) {
  const planFile = value(args, '--plan-file')
  const task = value(args, '--decompose')
  if (planFile) return JSON.parse(fs.readFileSync(path.resolve(planFile), 'utf8'))
  if (task) {
    const result = await decompose(brain(), task, context.repo, resolveBrainModel('opus', context.config).model)
    if (!result) throw new Error('decomposition failed')
    return result
  }
  throw Object.assign(new Error('run requires --plan-file <json> or --decompose "<task>"'), { code: 'USAGE' })
}

export function routePlan(plan, context, manager, store = null) {
  const check = validatePlan(plan)
  if (!check.valid) throw new Error(`invalid plan: ${check.errors.join('; ')}`)
  const enabled = context.config.enabled
  const probes = manager.probes(enabled)
  const healthy = probes.filter((probe) => probe.healthy)
  if (healthy.length < context.policy.minimumHealthyWorkers) {
    throw Object.assign(new Error(`need ${context.policy.minimumHealthyWorkers} healthy workers; found ${healthy.length}`), { code: 'BLOCKED' })
  }
  const tasks = plan.tasks.map((task) => {
    const violations = enforceTaskPolicy(task, context.policy)
    if (violations.length) throw Object.assign(new Error(`${task.id}: ${violations.join('; ')}`), { code: 'BLOCKED' })
    const route = routeTask(task, { manager, store, enabled, probes })
    return { ...task, cli: route.worker, model_tier: task.model_tier ?? (task.complexity_score <= 20 ? 'simple' : task.complexity_score <= 50 ? 'moderate' : task.complexity_score <= 100 ? 'complex' : 'expert'), routing: route }
  })
  const healthyNames = healthy.map((probe) => probe.name)
  const alternates = Object.fromEntries(healthyNames.map((name, index) => [name, healthyNames[(index + 1) % healthyNames.length]]))
  return { tasks, probes, alternates, taskClasses: Object.fromEntries(tasks.map((task) => [task.id, task.routing.taskClass.primary])) }
}

function printPlan(tasks, gates) {
  console.log(JSON.stringify({
    tasks: tasks.map((task) => ({ id: task.id, worker: task.cli, tier: task.model_tier, risk: task.risk, wave_dependencies: task.dependencies, routing: task.routing.scores })),
    gates,
  }, null, 2))
}

// Remove per-task ultraswarm/* worktrees + branches, leaving the integration worktree/branch
// (ultraswarm/run-<id>) intact. Used when a run is left awaiting_merge so the merge command can
// still reach its integration worktree. Best-effort — never throws.
export function cleanupPerTaskWorktrees(repo, runId) {
  const integrationBranch = `ultraswarm/run-${runId}`
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    for (const entry of list.split('\n\n')) {
      const row = Object.fromEntries(entry.split('\n').filter(Boolean).map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)]))
      if (!row.worktree || row.branch === `refs/heads/${integrationBranch}`) continue
      if (path.basename(row.worktree).includes(`${path.basename(repo)}-us-`)) {
        try { execFileSync('git', ['worktree', 'remove', '--force', '--', row.worktree], { cwd: repo, stdio: 'ignore' }) } catch {}
      }
    }
  } catch {}
  try { execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore' }) } catch {}
  try {
    const branchOut = execFileSync('git', ['branch', '--list', 'ultraswarm/*'], { cwd: repo, encoding: 'utf8' })
    for (const raw of branchOut.split('\n')) {
      const name = raw.replace(/^\*?\s+/, '').trim()
      if (name && name !== integrationBranch) try { execFileSync('git', ['branch', '-D', name], { cwd: repo, stdio: 'ignore' }) } catch {}
    }
  } catch {}
}

async function runCommand(args, repo) {
  const context = loadContext(repo)
  const manager = new WorkerManager({ ...context.config, repo })
  let store, cfg, integration, runId
  try {
    const plan = await loadPlan(args, context)
    const routed = routePlan(plan, context, manager)
    printPlan(routed.tasks, context.gates)
    if (!has(args, '--approve-plan')) {
      console.error('Plan approval required. Re-run with --approve-plan.')
      return EXIT.APPROVAL
    }
    store = openRepoStore(repo)
    runId = value(args, '--run-id') ?? randomUUID()
    const routedPlan = { ...plan, tasks: routed.tasks.map(({ routing, ...task }) => task) }
    const waves = computeWaves(routedPlan.tasks)
    store.createRun({ id: runId, repo, baseSha: context.baseSha, plan: routedPlan, policy: context.policy, waves })
    store.approve(runId, 'plan')
    requireApproval(store, runId, 'plan', context.policy)
    integration = createIntegrationWorktree({ repo, runId, baseSha: context.baseSha, worktreeRoot: value(args, '--worktree-root') ?? path.join(process.env.HOME, 'worktrees') })
    store.db.prepare('UPDATE runs SET integration_branch=?,status=?,updated_at=? WHERE id=?').run(integration.branch, 'running', new Date().toISOString(), runId)
    cfg = {
      ...context.config, repo, repoName: path.basename(repo), baseBranch: context.baseSha,
      integrationRepo: integration.worktree, worktreeRoot: value(args, '--worktree-root') ?? path.join(process.env.HOME, 'worktrees'),
      gates: context.gates, tasks: routedPlan.tasks, workerManager: manager, store, runId,
      registry: context.config.registry || {}, alternates: { ...routed.alternates, ...(context.config.alternates || {}) }, taskClasses: routed.taskClasses, policy: context.policy,
    }
    const result = await runSwarm(cfg, brain())
    for (const task of result.merged) store.updateTask(runId, task.task, task.merged ? 'integrated' : 'failed', { result: task })
    for (const id of result.failed) store.updateTask(runId, id, 'failed')
    for (const item of result.blocked) store.updateTask(runId, item.task, 'blocked', { lastError: item.reason })
    const integrated = result.merged.some((item) => item.merged)
    store.setRunStatus(runId, integrated ? 'awaiting_merge' : 'completed_with_findings', { report: result })
    console.log(`\nRun: ${runId}\n${buildReport(result)}`)
    if (integrated) console.log(`\nApprove merge with: ultraswarm merge ${runId} --approve`)
    return result.failed.length || result.blocked.length ? EXIT.BLOCKED : EXIT.OK
  } finally {
    // Worktree/branch leak fix (B2). Per-task worktrees are always disposable. The integration
    // worktree+branch are only kept when the run is awaiting_merge (merge needs them); otherwise
    // they are removed too. Guard on cfg so a throw before setup doesn't crash teardown.
    if (cfg) {
      const awaitingMerge = (() => { try { return store?.getRun(runId)?.status === 'awaiting_merge' } catch { return false } })()
      if (awaitingMerge) cleanupPerTaskWorktrees(repo, runId)
      else { cleanup(cfg); try { removeIntegrationWorktree({ repo, runId, integrationBranch: integration?.branch }) } catch {} }
    }
    store?.close()
    manager.close()
  }
}

function mergeCommand(args, repo) {
  const runId = args[0]
  if (!runId) throw Object.assign(new Error('merge requires a run id'), { code: 'USAGE' })
  if (!has(args, '--approve')) throw Object.assign(new Error('merge approval required: add --approve'), { code: 'APPROVAL_REQUIRED' })
  const context = loadContext(repo), store = openRepoStore(repo)
  try {
    store.approve(runId, 'merge')
    const result = mergeApprovedRun({ repo, runId, store, policy: context.policy, gates: context.gates })
    console.log(JSON.stringify(result, null, 2))
    return EXIT.OK
  } finally { store.close() }
}

function statusCommand(args, repo) {
  const store = openRepoStore(repo)
  try {
    const runId = args[0]
    const output = runId ? { run: store.getRun(runId), tasks: store.getTasks(runId), attempts: store.getAttempts(runId) } : store.listRuns()
    console.log(JSON.stringify(output, null, 2)); return EXIT.OK
  } finally { store.close() }
}

function logsCommand(args, repo) {
  const runId = args[0], store = openRepoStore(repo)
  try {
    if (!runId) throw Object.assign(new Error('logs requires a run id'), { code: 'USAGE' })
    const events = store.getEvents(runId, Number(value(args, '--after') ?? 0))
    console.log(has(args, '--json') ? JSON.stringify(events, null, 2) : events.map((event) => `${event.seq} ${event.created_at} ${event.type} ${event.task_id ?? ''} ${JSON.stringify(event.payload)}`).join('\n'))
    return EXIT.OK
  } finally { store.close() }
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function cancelCommand(args, repo) {
  const runId = args[0], store = openRepoStore(repo)
  try {
    if (!runId) throw Object.assign(new Error('cancel requires a run id'), { code: 'USAGE' })
    const running = store.getAttempts(runId).filter((item) => item.status === 'running')
    // SIGTERM first for a graceful stop, then escalate to SIGKILL for any pid still alive after a
    // short grace so cancel can't leave orphaned worker trees behind.
    for (const attempt of running) if (attempt.pid) terminateTree(attempt.pid, 'SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 500))
    for (const attempt of running) if (attempt.pid && isAlive(attempt.pid)) terminateTree(attempt.pid, 'SIGKILL')
    // Mark attempts finished so rows don't stay 'running' forever (a later cancel would otherwise
    // re-target dead/reassigned pids).
    for (const attempt of running) store.finishAttempt(attempt.id, { status: 'cancelled' })
    store.setRunStatus(runId, 'cancelled')
    console.log(`cancelled ${runId}`); return EXIT.OK
  } finally { store.close() }
}

const revokeMergeApproval = (store, runId) => store.db.prepare('DELETE FROM approvals WHERE run_id=? AND gate=?').run(runId, 'merge')

function resumeCommand(args, repo) {
  const runId = args[0], store = openRepoStore(repo)
  try {
    const run = store.getRun(runId)
    if (!run) throw new Error(`run not found: ${runId}`)
    const current = git(repo, ['rev-parse', 'HEAD'])
    // (c) A run stuck in 'running' means the orchestrator process died mid-flight. Don't silently
    // resume a half-run: fail orphaned attempts (running with a dead/absent pid) cleanly and move
    // the run to a recoverable terminal status with accounting so it can't dead-end.
    if (run.status === 'running') {
      const orphaned = store.getAttempts(runId).filter((item) => item.status === 'running' && (!item.pid || !isAlive(item.pid)))
      for (const attempt of orphaned) store.finishAttempt(attempt.id, { status: 'failed', errorKind: 'orphaned' })
      const alive = store.getAttempts(runId).filter((item) => item.status === 'running')
      if (alive.length) throw Object.assign(new Error(`run ${runId} still has ${alive.length} live attempt(s); cancel it first`), { code: 'BLOCKED' })
      store.setRunStatus(runId, 'completed_with_findings', { recovered: true, failedAttempts: orphaned.length })
      throw Object.assign(new Error(`run ${runId} was stuck in 'running' (process died); marked ${orphaned.length} orphaned attempt(s) failed and the run completed_with_findings`), { code: 'BLOCKED' })
    }
    // (a) stale_base can also be discovered at resume time: if the run is awaiting_merge but the
    // target branch has since moved, transition to stale_base and rebase rather than declaring it
    // ready for merge.
    if (run.status === 'awaiting_merge') {
      if (current === run.base_sha) { console.log(`run ${runId} is ready for merge approval`); return EXIT.OK }
      revokeMergeApproval(store, runId)
      store.setRunStatus(runId, 'stale_base', { targetSha: current })
      run.status = 'stale_base'
    }
    if (run.status !== 'stale_base') throw Object.assign(new Error(`run ${runId} cannot resume from ${run.status}`), { code: 'BLOCKED' })
    const worktree = git(repo, ['worktree', 'list', '--porcelain']).split('\n\n').find((entry) => entry.includes(`branch refs/heads/${run.integration_branch}`))?.split('\n')[0]?.slice(9)
    if (!worktree) throw new Error('integration worktree is missing')
    // (b) A rebase conflict would otherwise leave the worktree mid-rebase and permanently
    // un-resumable. Abort on failure, keep the run recoverable (stale_base), and surface a clear
    // BLOCKED error so the operator knows manual conflict resolution is required.
    try {
      execFileSync('git', ['rebase', '--onto', current, run.base_sha, run.integration_branch], { cwd: worktree, stdio: 'inherit' })
    } catch {
      try { execFileSync('git', ['rebase', '--abort'], { cwd: worktree, stdio: 'ignore' }) } catch {}
      throw Object.assign(new Error(`rebase of run ${runId} hit conflicts; manual conflict resolution required (run left in stale_base)`), { code: 'BLOCKED' })
    }
    // (d) DB-enforced re-approval: drop the merge approval row so requireApproval is meaningful
    // after the integration branch was rebuilt.
    revokeMergeApproval(store, runId)
    store.db.prepare('UPDATE runs SET base_sha=?,status=?,updated_at=? WHERE id=?').run(current, 'awaiting_merge', new Date().toISOString(), runId)
    store.appendEvent(runId, 'run.rebased', { baseSha: current })
    console.log(`rebased ${runId}; merge approval is required again`); return EXIT.OK
  } finally { store.close() }
}

function doctorCommand(repo, explain = false, task = {}) {
  const context = loadContext(repo), manager = new WorkerManager({ ...context.config, repo }), store = openRepoStore(repo)
  try {
    const probes = manager.probes(context.config.enabled)
    const output = explain ? routeTask(task, { manager, store, enabled: context.config.enabled, probes }) : { policy: context.policy, gates: context.gates, workers: probes }
    console.log(JSON.stringify(output, null, 2))
    return probes.filter((probe) => probe.healthy).length >= context.policy.minimumHealthyWorkers ? EXIT.OK : EXIT.BLOCKED
  } finally { store.close(); manager.close() }
}

function exportCommand(args, repo) {
  const runId = args[0], store = openRepoStore(repo)
  try {
    if (!runId) throw Object.assign(new Error('export requires a run id'), { code: 'USAGE' })
    const run = store.getRun(runId)
    if (!run) throw Object.assign(new Error(`run not found: ${runId}`), { code: 'USAGE' })
    const approvals = store.db.prepare('SELECT * FROM approvals WHERE run_id=? ORDER BY gate').all(runId)
    console.log(JSON.stringify({ run, tasks: store.getTasks(runId), attempts: store.getAttempts(runId), events: store.getEvents(runId), approvals, worker_metrics: store.getMetrics() }, null, 2))
    return EXIT.OK
  } finally { store.close() }
}

export async function commandMain(argv = process.argv.slice(2), repo = process.cwd()) {
  let args = [...argv], command = args.shift()
  if (!command || command.startsWith('--')) {
    console.error('Deprecated v2 flags detected; use `ultraswarm run ... --approve-plan`.')
    args = [...argv]
    if (has(args, '--yes')) args = args.filter((arg) => arg !== '--yes').concat('--approve-plan')
    command = 'run'
  }
  if (command === 'run') return runCommand(args, repo)
  if (command === 'merge') return mergeCommand(args, repo)
  if (command === 'status') return statusCommand(args, repo)
  if (command === 'logs') return logsCommand(args, repo)
  if (command === 'cancel') return cancelCommand(args, repo)
  if (command === 'resume') return resumeCommand(args, repo)
  if (command === 'doctor' || command === 'workers') return doctorCommand(repo)
  if (command === 'explain-routing') return doctorCommand(repo, true, { description: args.join(' '), prompt: args.join(' '), files: [] })
  if (command === 'export') return exportCommand(args, repo)
  throw Object.assign(new Error(`unknown command: ${command}`), { code: 'USAGE' })
}

// Returns an error message if the running Node is too old for node:sqlite (< 22), else null.
// Pure (takes the version string) so it can be unit-tested without spawning a process.
export function requireNode22(version = process.versions.node) {
  const major = Number(String(version).split('.')[0])
  if (!Number.isFinite(major) || major < 22) return `ultraswarm requires Node >= 22 (node:sqlite); you have v${version}`
  return null
}

export function exitCode(error) {
  if (error.code === 'USAGE') return EXIT.USAGE
  if (error.code === 'APPROVAL_REQUIRED') return EXIT.APPROVAL
  if (error.code === 'BLOCKED' || error.code === 'STALE_BASE') return EXIT.BLOCKED
  return EXIT.RUNTIME
}
