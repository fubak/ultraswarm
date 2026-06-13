import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { ProcessSupervisor, redact } from './supervisor.mjs'

test('redact removes common secret assignments', () => assert.equal(redact('token=abc password:xyz'), 'token=[REDACTED] password=[REDACTED]'))
test('ProcessSupervisor captures output and times out process groups', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-logs-'))
  const supervisor = new ProcessSupervisor({ logDir, graceMs: 20 })
  const ok = await supervisor.run({ command: process.execPath, args: ['-e', 'console.log("ok")'], label: 'ok' })
  assert.equal(ok.code, 0); assert.match(ok.stdout, /ok/)
  const timed = await supervisor.run({ command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 10000)'], timeoutMs: 20, label: 'timeout' })
  assert.equal(timed.timedOut, true); assert.ok(fs.existsSync(path.join(logDir, 'timeout.log')))
  supervisor.close()
})
