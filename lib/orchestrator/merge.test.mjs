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
  assert.deepEqual(r, [{ task: 't1', merged: true }])
  assert.ok(fs.existsSync(path.join(repo, 'new.txt')))
})

test('mergeWave rolls back when a post-merge gate regresses', async () => {
  const repo = repoWithBranch('new.txt', 'hello')
  const cfg = { repo, gates: [{ name: 'fail', cmd: 'test -f missing.txt' }] }
  const approved = [{ task: 't1', cli: 'codex', impl: { branch: 'ultraswarm/t1-codex' } }]
  const r = await mergeWave(cfg, null, approved)
  assert.equal(r[0].merged, false)
})
