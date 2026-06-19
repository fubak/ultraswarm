import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { detectInstall, installWorktreeDeps } from './worktree-deps.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'us-deps-'))
const touch = (dir, name) => fs.writeFileSync(path.join(dir, name), '')

// WHY: a git worktree checks out tracked files only; node_modules is gitignored, so deps must be
// installed per-worktree before any gate runs (issue #36). The package manager is inferred from the
// committed lockfile so a non-Node repo (no lockfile) is never disturbed.
test('detectInstall returns null when no lockfile is present', () => {
  assert.equal(detectInstall(tmp()), null)
})

test('detectInstall maps each lockfile to its deterministic, offline-friendly install', () => {
  const pnpm = tmp(); touch(pnpm, 'pnpm-lock.yaml')
  assert.equal(detectInstall(pnpm).cmd, 'pnpm install --frozen-lockfile --prefer-offline')
  const yarn = tmp(); touch(yarn, 'yarn.lock')
  assert.equal(detectInstall(yarn).cmd, 'yarn install --immutable')
  const npm = tmp(); touch(npm, 'package-lock.json')
  assert.equal(detectInstall(npm).cmd, 'npm ci --prefer-offline --no-audit --no-fund')
})

// WHY: a pnpm/yarn lockfile pins the manager even if a stray package-lock.json also lingers; using
// `npm ci` against a pnpm workspace would fail. pnpm wins because it is the most specific signal.
test('detectInstall prefers pnpm over a co-present npm lockfile', () => {
  const dir = tmp(); touch(dir, 'pnpm-lock.yaml'); touch(dir, 'package-lock.json')
  assert.equal(detectInstall(dir).lockfile, 'pnpm-lock.yaml')
})

test('installWorktreeDeps is a no-op (and runs nothing) when no lockfile exists', () => {
  let called = false
  const run = () => { called = true }
  assert.equal(installWorktreeDeps(tmp(), run), null)
  assert.equal(called, false)
})

test('installWorktreeDeps runs the detected install in the worktree cwd', () => {
  const dir = tmp(); touch(dir, 'pnpm-lock.yaml')
  const calls = []
  const run = (cmd, cwd) => calls.push({ cmd, cwd })
  const result = installWorktreeDeps(dir, run)
  assert.equal(result.cmd, 'pnpm install --frozen-lockfile --prefer-offline')
  assert.deepEqual(calls, [{ cmd: 'pnpm install --frozen-lockfile --prefer-offline', cwd: dir }])
})

// WHY (Rule 12 — fail loud): an install failure must propagate, never be swallowed, so callers can
// surface it distinctly instead of mislabeling it as a gate regression.
test('installWorktreeDeps propagates an install failure loudly', () => {
  const dir = tmp(); touch(dir, 'package-lock.json')
  const run = () => { throw new Error('registry unreachable') }
  assert.throws(() => installWorktreeDeps(dir, run), /registry unreachable/)
})
