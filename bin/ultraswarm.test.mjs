import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRunConfig } from './ultraswarm.mjs'

test('buildRunConfig merges repo context with a validated plan', () => {
  const base = { repo: '/r', repoName: 'r', baseBranch: 'HEAD', worktreeRoot: '/w',
    gates: [{ name: 'test', cmd: 'npm test' }], registry: { codex: 'c' }, alternates: { codex: 'codex' } }
  const plan = { tasks: [{ id: 't1', description: 'd', files: ['a.js'], cli: 'codex', model_tier: 'simple',
    complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'p' }] }
  const cfg = buildRunConfig(base, plan)
  assert.equal(cfg.tasks.length, 1)
  assert.equal(cfg.repo, '/r')
})

test('buildRunConfig throws on an invalid plan (unknown cli)', () => {
  const base = { repo: '/r', repoName: 'r', baseBranch: 'HEAD', worktreeRoot: '/w', gates: [], registry: {}, alternates: {} }
  const plan = { tasks: [{ id: 't1', description: 'd', files: [], cli: 'evil', model_tier: 'simple',
    complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'p' }] }
  assert.throws(() => buildRunConfig(base, plan), /unknown cli/)
})
