import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { ProcessSupervisor, redact } from './supervisor.mjs'

test('redact removes common secret assignments', () => assert.equal(redact('token=abc password:xyz'), 'token=[REDACTED] password=[REDACTED]'))

test('redact masks format-based secrets even without a keyword anchor (B3)', () => {
  // WHY (Rule 9): these are the exact leak paths from B3. Each real secret substring must NOT survive
  // redaction. Negative controls — asserting absence is what proves the redactor, not its presence.
  const cases = [
    ['Authorization: Bearer sk-ant-api03-REALKEY12345', 'sk-ant-api03-REALKEY12345'],
    ['sk-ant-api03-leakedkey9999900000', 'sk-ant-api03-leakedkey9999900000'],
    ['ghp_16charsofgithubtokenhere0000', 'ghp_16charsofgithubtokenhere0000'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ]
  for (const [input, secret] of cases) {
    const out = redact(input)
    assert.ok(!out.includes(secret), `leaked secret in: ${out}`)
    assert.match(out, /\[REDACTED\]/)
  }
  // Multi-token authorization header must not be a bypass: the key after Bearer is consumed.
  assert.ok(!redact('Authorization: Bearer sk-ant-api03-REALKEY12345').includes('REALKEY12345'))
})
test('redact does NOT mangle ordinary prose containing "bearer"/"authorization" (no over-redaction)', () => {
  // WHY: the redactor protects log debuggability; masking plain words defeats that. These contain
  // no real credential (no ':' header, no token-shaped value), so they must pass through verbatim.
  assert.equal(redact('the bearer of bad news'), 'the bearer of bad news')
  assert.equal(redact('contact the authorization department today'), 'contact the authorization department today')
})
test('ProcessSupervisor captures output and times out process groups', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-logs-'))
  const supervisor = new ProcessSupervisor({ logDir, graceMs: 20 })
  const ok = await supervisor.run({ command: process.execPath, args: ['-e', 'console.log("ok")'], label: 'ok' })
  assert.equal(ok.code, 0); assert.match(ok.stdout, /ok/)
  const timed = await supervisor.run({ command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 10000)'], timeoutMs: 20, label: 'timeout' })
  assert.equal(timed.timedOut, true); assert.ok(fs.existsSync(path.join(logDir, 'timeout.log')))
  supervisor.close()
})

test('ProcessSupervisor: clean exit before grace does not throw (SIGKILL timer is cleared, MEDIUM)', async () => {
  // WHY: on a clean close the pending SIGKILL setTimeout must be cleared so it never fires at a reused
  // pid. We can't deterministically test the reused-pid race, so we assert a fast clean close settles
  // without error and reports code 0. graceMs is long enough that an uncleared timer would still be armed.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-logs-'))
  const supervisor = new ProcessSupervisor({ logDir, graceMs: 5000 })
  const r = await supervisor.run({ command: process.execPath, args: ['-e', 'process.exit(0)'], label: 'fast' })
  assert.equal(r.code, 0)
  assert.equal(r.timedOut, false)
  supervisor.close()
})
