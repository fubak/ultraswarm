#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { loadConfig } from '../scripts/router.mjs'
import { validatePlan } from '../lib/plan-schema.mjs'
import { AnthropicClient } from '../lib/llm/anthropic.mjs'
import { ClaudeCliClient } from '../lib/llm/claude-cli.mjs'
import { resolveBrainModel } from '../lib/llm/brain-router.mjs'
import { decompose } from '../lib/orchestrator/decompose.mjs'
import { runSwarm } from '../lib/orchestrator/runner.mjs'
import { buildReport, cleanup } from '../lib/orchestrator/report.mjs'
import { Journal } from '../lib/journal.mjs'
import { commandMain, exitCode } from './cli.mjs'

export function buildRunConfig(base, plan) {
  const { valid, errors } = validatePlan(plan)
  if (!valid) throw new Error(`invalid plan: ${errors.join('; ')}`)
  return { ...base, tasks: plan.tasks }
}

function detectGates(repo) {
  const pkg = path.join(repo, 'package.json')
  if (!fs.existsSync(pkg)) return []
  const s = JSON.parse(fs.readFileSync(pkg, 'utf8')).scripts || {}
  return ['build', 'test', 'lint'].filter((g) => s[g]).map((g) => ({ name: g, cmd: `npm run ${g}` }))
}

function arg(flag) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }

// Pick the brain. Default: the local authenticated `claude` CLI (no ANTHROPIC_API_KEY, reuses your
// Claude Code auth). Fall back to the raw Anthropic API if `claude` isn't on PATH.
// Override with ULTRASWARM_BRAIN=claude-cli | anthropic-api.
function hasClaudeCli() {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}
function makeBrain() {
  const pref = process.env.ULTRASWARM_BRAIN
  if (pref === 'anthropic-api') return new AnthropicClient()
  if (pref === 'claude-cli') return new ClaudeCliClient()
  return hasClaudeCli() ? new ClaudeCliClient() : new AnthropicClient()
}

async function main() {
  const planFile = arg('--plan-file')
  const decomposeTask = arg('--decompose')
  const yes = process.argv.includes('--yes')
  const repo = process.cwd(), repoName = path.basename(repo)
  const userConfig = loadConfig()
  const base = {
    repo, repoName, baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot: path.join(process.env.HOME, 'worktrees'), gates: detectGates(repo),
    registry: userConfig.registry || {}, // legacy direct map (still supported via fallback)
    overrides: userConfig.overrides || {},
    intelligence: userConfig.intelligence || {},
    alternates: userConfig.alternates || {},
    enabled: userConfig.enabled,
  }

  let plan
  if (planFile) plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  else if (decomposeTask) {
    const brain = makeBrain()
    plan = await decompose(brain, decomposeTask, repo, resolveBrainModel('opus', userConfig).model)
    if (!plan) { console.error('decomposition failed'); process.exit(1) }
  } else { console.error('usage: ultraswarm --plan-file <json> | --decompose "<task>" [--yes]'); process.exit(2) }

  console.log(JSON.stringify(plan.tasks.map((t) => ({ id: t.id, cli: t.cli, tier: t.model_tier, risk: t.risk })), null, 2))
  if (!yes) { console.error('re-run with --yes to execute'); process.exit(0) }

  const cfg = buildRunConfig(base, plan)
  const brain = makeBrain()
  const resumeId = arg('--resume')
  const runId = resumeId || `${base.baseBranch.slice(0, 8)}-${arg('--run') || '1'}`
  const journalDir = path.join(base.repo, '.ultraswarm')
  if (!fs.existsSync(journalDir)) fs.mkdirSync(journalDir, { recursive: true })
  const journal = new Journal(path.join(journalDir, `run-${runId}.jsonl`))
  const result = await runSwarm(cfg, brain, journal)
  console.log('\n' + buildReport(result))
  cleanup(cfg)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  commandMain().then((code) => { process.exitCode = code }).catch((e) => { console.error(`ultraswarm: ${e.message}`); process.exitCode = exitCode(e) })
}
