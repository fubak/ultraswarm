import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { runSwarm } from './runner.mjs'
import { MockLlmClient } from '../llm/client.mjs'

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-run-'))
  execSync('git init -q && git config user.email t@t && git config user.name t && echo x > s.txt && git add -A && git commit -q -m seed',
    { cwd: dir, shell: '/bin/bash' })
  return dir
}
const fakeCli = path.resolve('fixtures/fake-cli.mjs')

test('runSwarm: one routine task implements, passes review, MERGES to branch', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: { codex: `node ${fakeCli}` }, alternates: { codex: 'codex' },
    tasks: [{ id: 't1', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient((label) => label.startsWith('review')
    ? { object: { approve: true, issues: [], quality_score: 90, complexity_assessment: 10 }, usage: {} }
    : { object: {}, usage: {} })
  const result = await runSwarm(cfg, brain)
  assert.equal(result.merged.filter((m) => m.merged).length, 1)
  assert.ok(fs.existsSync(path.join(repo, 'generated.js')), 'approved file landed on the working branch')
})

test('runSwarm: review brain call uses resolved model id, not tier label', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: { codex: `node ${fakeCli}` }, alternates: { codex: 'codex' },
    tasks: [{ id: 't3', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient((label) => label.startsWith('review')
    ? { object: { approve: true, issues: [], quality_score: 90, complexity_assessment: 10 }, usage: {} }
    : { object: {}, usage: {} })
  await runSwarm(cfg, brain)
  const calls = brain.calls.filter(c => c.label?.startsWith('review'))
  assert.ok(calls.length > 0, 'at least one review call must be made')
  assert.equal(calls[0].model, 'claude-haiku-4-5', 'tier label must be resolved to a real model id before hitting the brain')
  assert.notEqual(calls[0].model, 'haiku', 'raw tier label must NOT reach the brain')
})

test('runSwarm: review rejection 3x → task tombstones, nothing merges', async () => {
  const repo = makeRepo(), worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-wt-'))
  const cfg = { repo, repoName: 'r', baseBranch: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
    worktreeRoot, gates: [{ name: 'present', cmd: 'test -f generated.js' }],
    registry: { codex: `node ${fakeCli}` }, alternates: { codex: 'codex' },
    tasks: [{ id: 't2', description: 'd', files: ['generated.js'], cli: 'codex', model_tier: 'simple',
      complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'go' }] }
  const brain = new MockLlmClient(() => ({ object: { approve: false, issues: ['bad'], quality_score: 10, complexity_assessment: 0 }, usage: {} }))
  const result = await runSwarm(cfg, brain)
  assert.deepEqual(result.failed, ['t2'])
  assert.equal(result.merged.length, 0)
})
