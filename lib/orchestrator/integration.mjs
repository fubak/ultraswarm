import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { requireApproval } from '../policy.mjs'

const git = (repo, args, options = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', ...options })

export function createIntegrationWorktree({ repo, runId, baseSha, worktreeRoot }) {
  const branch = `ultraswarm/run-${runId}`
  const worktree = path.join(worktreeRoot, `${path.basename(repo)}-us-integration-${runId}`)
  if (fs.existsSync(worktree)) return { branch, worktree }
  try { git(repo, ['worktree', 'prune'], { stdio: 'ignore' }) } catch {}
  try { git(repo, ['branch', '-D', branch], { stdio: 'ignore' }) } catch {}
  git(repo, ['worktree', 'add', worktree, '-b', branch, baseSha])
  return { branch, worktree }
}

export function integrationHead(worktree) { return git(worktree, ['rev-parse', 'HEAD']).trim() }

export function mergeApprovedRun({ repo, runId, store, policy, gates = [] }) {
  requireApproval(store, runId, 'merge', policy)
  const run = store.getRun(runId)
  if (!run) throw new Error(`run not found: ${runId}`)
  if (run.status !== 'awaiting_merge') throw new Error(`run ${runId} is ${run.status}, not awaiting_merge`)
  const current = git(repo, ['rev-parse', 'HEAD']).trim()
  if (current !== run.base_sha) {
    store.setRunStatus(runId, 'stale_base', { targetSha: current })
    const error = new Error(`target branch moved from ${run.base_sha} to ${current}; resume the run to rebuild integration`)
    error.code = 'STALE_BASE'
    throw error
  }
  if (git(repo, ['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('target worktree has tracked changes; refusing to merge')
  const integrationRepo = git(repo, ['worktree', 'list', '--porcelain']).split('\n\n')
    .map((entry) => Object.fromEntries(entry.split('\n').filter(Boolean).map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)])))
    .find((entry) => entry.branch === `refs/heads/${run.integration_branch}`)?.worktree
  if (!integrationRepo) throw new Error(`integration worktree not found for ${run.integration_branch}`)
  for (const gate of gates) execSync(gate.cmd, { cwd: integrationRepo, shell: '/bin/bash', stdio: 'inherit' })
  git(repo, ['merge', '--ff-only', run.integration_branch])
  const targetSha = git(repo, ['rev-parse', 'HEAD']).trim()
  store.setRunStatus(runId, 'merged', { targetSha })
  return { runId, targetSha }
}
