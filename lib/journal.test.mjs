import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { Journal } from './journal.mjs'

test('Journal replays a cached key and runs a new one; different prompt = different key', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'us-j-')), 'run.jsonl')
  let ran = 0
  const j1 = new Journal(file)
  assert.deepEqual(await j1.step('review:t1', 'PROMPT-A', async () => { ran++; return { v: 1 } }), { v: 1 })

  const j2 = new Journal(file)   // resume
  assert.deepEqual(await j2.step('review:t1', 'PROMPT-A', async () => { ran++; return { v: 999 } }), { v: 1 }, 'cached replayed')
  assert.equal(ran, 1)
  assert.deepEqual(await j2.step('review:t1', 'PROMPT-B', async () => { ran++; return { v: 2 } }), { v: 2 }, 'new prompt -> new key')
  assert.equal(ran, 2)
})
