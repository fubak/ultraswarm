import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { mergeWave } from './merge.mjs'

function repoWithBranch(file, content) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-merge-'))
  const run = (c) => execSync(c, { cwd: repo, shell: '/bin/bash' })
  run('git init -q && git config user.email t@t && git config user.name t && echo base > base.txt && git add -A && git commit -q -m seed')
  run(`git checkout -q -b ultraswarm/t1-codex && echo "${content}" > ${file} && git add -A && git commit -q -m work && git checkout -q -`)
  return repo
}

test('mergeWave squash-merges an approved branch and gates pass → merged', async () => {
  const repo = repoWithBranch('new.txt', 'hello')
  const cfg = { repo, gates: [{ name: 'present', cmd: 'test -f new.txt' }] }
  const approved = [{ task: 't1', cli: 'codex', impl: { branch: 'ultraswarm/t1-codex' } }]
  const r = await mergeWave(cfg, null, approved)
  // cli is threaded through so the run report can attribute the merged task to the worker that did it.
  assert.deepEqual(r, [{ task: 't1', cli: 'codex', merged: true }])
  assert.ok(fs.existsSync(path.join(repo, 'new.txt')))
})

test('mergeWave rolls back when a post-merge gate regresses', async () => {
  const repo = repoWithBranch('new.txt', 'hello')
  const cfg = { repo, gates: [{ name: 'fail', cmd: 'test -f missing.txt' }] }
  const approved = [{ task: 't1', cli: 'codex', impl: { branch: 'ultraswarm/t1-codex' } }]
  const r = await mergeWave(cfg, null, approved)
  assert.equal(r[0].merged, false)
})

test('mergeWave does NOT sweep untracked host scaffolding into the feature commit (#12)', async () => {
  const repo = repoWithBranch('new.txt', 'hello')
  // host scaffolding sitting untracked in the repo root before the merge
  fs.writeFileSync(path.join(repo, '.ultraswarm-plan.json'), '{"tasks":[]}')
  fs.writeFileSync(path.join(repo, 'ultraswarm.config.json'), '{}')
  fs.mkdirSync(path.join(repo, '.grok'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.grok', 'session'), 'x')
  const cfg = { repo, gates: [{ name: 'present', cmd: 'test -f new.txt' }] }
  await mergeWave(cfg, null, [{ task: 't1', cli: 'codex', impl: { branch: 'ultraswarm/t1-codex' } }])
  const committed = execSync('git show --name-only --format= HEAD', { cwd: repo, encoding: 'utf8' })
  assert.match(committed, /new\.txt/, 'the feature file IS committed')
  assert.doesNotMatch(committed, /\.ultraswarm-plan\.json|ultraswarm\.config\.json|\.grok/, 'scaffolding is NOT committed')
})

test('mergeWave records a no-op (no net change) instead of throwing and blocking the wave (#O2)', async () => {
  // The approved branch sets dup.txt=same; land that identical content on the target first, so the
  // squash stages nothing and `git commit` would fail. Old code threw, blocking the whole wave.
  const repo = repoWithBranch('dup.txt', 'same')
  execSync('echo "same" > dup.txt && git add -A && git commit -q -m pre', { cwd: repo, shell: '/bin/bash' })
  const cfg = { repo, gates: [] }
  const r = await mergeWave(cfg, null, [{ task: 't1', cli: 'codex', impl: { branch: 'ultraswarm/t1-codex' } }])
  assert.equal(r.length, 1)
  assert.equal(r[0].merged, false)
  assert.match(r[0].reason, /no net change/i)
})
