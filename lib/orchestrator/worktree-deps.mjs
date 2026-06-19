import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

// Lockfile → deterministic, offline-friendly install for its package manager. Ordered by
// specificity: a pnpm or yarn lockfile pins that manager even if a package-lock.json also lingers,
// so `npm ci` is never run against a pnpm/yarn workspace.
const INSTALLERS = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile --prefer-offline'],
  ['yarn.lock', 'yarn install --immutable'],
  ['package-lock.json', 'npm ci --prefer-offline --no-audit --no-fund'],
]

// Infer the install command for a worktree from its committed lockfile, or null when there is none
// (a non-Node repo, or one without a lockfile, is left untouched).
export function detectInstall(wt) {
  for (const [lockfile, cmd] of INSTALLERS) {
    if (fs.existsSync(path.join(wt, lockfile))) return { lockfile, cmd }
  }
  return null
}

const defaultRun = (cmd, cwd) => execSync(cmd, { cwd, shell: '/bin/bash', encoding: 'utf8', stdio: 'pipe' })

// Install dependencies in a freshly-created git worktree BEFORE any gate runs.
//
// A git worktree checks out tracked files only; node_modules is gitignored, so a fresh worktree has
// none. npm/yarn *hoisted* layouts can resolve a sibling worktree's deps via Node's upward module
// lookup, but pnpm symlinks each package's deps from node_modules/.pnpm and upward lookup never
// reaches them — so gates that need a workspace binary (next/vitest/tsc) die with "<bin>: not found".
// Installing here makes per-task and integration gates run the SAME environment, instead of depending
// on a worker incidentally installing deps as a side effect (issue #36).
//
// No-op when no lockfile is present. Throws loudly on failure (Rule 12) so an install error is never
// silently mislabeled as a gate regression. `run` is injectable for tests; it defaults to a real
// shell exec that throws on a non-zero exit.
export function installWorktreeDeps(wt, run = defaultRun) {
  const install = detectInstall(wt)
  if (!install) return null
  run(install.cmd, wt)
  return install
}
