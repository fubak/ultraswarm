import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { ProcessSupervisor, redact, terminateTree } from './supervisor.mjs'

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

// ── terminateTree() fallback paths (lines 41-42) ─────────────────────────────
// WHY: when a process has no process group (or the group-kill ESRCH-s), terminateTree
// must still attempt to kill individual descendants and the pid itself without throwing.
// Using a nonexistent pid forces both the group-kill AND the individual kill to fail
// (caught internally), exercising the descendants() query path and both catch blocks.

test('terminateTree() is a no-op for pid 0 (guard clause)', () => {
  // WHY: pid 0 is the guard at the top of terminateTree (line 39). Calling it must not throw.
  assert.doesNotThrow(() => terminateTree(0))
})

test('terminateTree() does not throw when pid has no process group (covers fallback descendants path)', () => {
  // WHY: process.kill(-99999, ...) will throw ESRCH for a nonexistent pid, so terminateTree falls
  // through to the descendants() lookup (lines 31-36) and individual kill (line 41-42), all caught.
  // The pgrep call returns empty for a nonexistent pid, so descendants() returns [].
  // This exercises all three catch blocks without needing a real process to kill.
  assert.doesNotThrow(() => terminateTree(99999, 'SIGTERM'))
})

// ── ProcessSupervisor: onStart callback ──────────────────────────────────────
// WHY: callers use onStart to capture the pid and logPath for cancel() and UI display.
// The callback must fire with a valid pid before the process finishes.

test('ProcessSupervisor run() calls onStart with pid and logPath', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-logs-'))
  const supervisor = new ProcessSupervisor({ logDir, graceMs: 100 })
  let startInfo
  const r = await supervisor.run({
    command: process.execPath,
    args: ['-e', 'console.log("started")'],
    label: 'onstart-test',
    onStart: (info) => { startInfo = info },
  })
  assert.ok(startInfo, 'onStart must have been called')
  assert.ok(typeof startInfo.pid === 'number' && startInfo.pid > 0, 'pid must be a positive number')
  assert.ok(startInfo.logPath.endsWith('onstart-test.log'), 'logPath must reference the label-derived log file')
  assert.equal(r.code, 0)
  supervisor.close()
})

// ── ProcessSupervisor: cancel() kills a running process ──────────────────────
// WHY: cancel() is the orchestrator's kill switch. It must stop a running process
// so that it does not consume resources indefinitely. We verify by running a long
// sleep, calling cancel(), and confirming the result is marked aborted.

test('ProcessSupervisor cancel() terminates a running process via AbortSignal', async () => {
  // WHY: We use an AbortController signal rather than calling cancel() directly,
  // because the signal path exercises the abort branch (aborted=true) in run().
  // cancel(pid) calls terminateTree which is already covered above separately.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-logs-'))
  const supervisor = new ProcessSupervisor({ logDir, graceMs: 50 })
  const controller = new AbortController()
  // Start a process that would run for a long time.
  const runPromise = supervisor.run({
    command: process.execPath,
    args: ['-e', 'setTimeout(()=>{}, 30000)'],
    label: 'cancel-test',
    signal: controller.signal,
    timeoutMs: 10000,
  })
  // Abort after a brief moment to let the process start.
  await new Promise((r) => setTimeout(r, 30))
  controller.abort()
  const result = await runPromise
  assert.equal(result.aborted, true, 'aborted must be true after signal abort')
  supervisor.close()
})

// ── ProcessSupervisor: log rotation when log file exceeds maxOutputBytes ──────
// WHY (lines 59-62): when a log file already exists and its size is >= maxOutputBytes,
// the supervisor must rotate it (rename → .1, remove old .1) before appending.
// Without this test those three lines were never executed.

test('ProcessSupervisor rotates the log file when it exceeds maxOutputBytes', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-logs-'))
  // maxOutputBytes of 1 byte ensures any existing log file triggers rotation.
  const supervisor = new ProcessSupervisor({ logDir, graceMs: 100, maxOutputBytes: 1 })
  const label = 'rotate-test'
  const logPath = path.join(logDir, `${label}.log`)

  // Pre-seed the log file with content that exceeds maxOutputBytes (1 byte).
  fs.writeFileSync(logPath, 'existing log content that is longer than 1 byte')

  // Running any command now must trigger the rotation branch (lines 59-62).
  const r = await supervisor.run({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    label,
  })

  // After rotation the old log must have been renamed to .1
  assert.ok(fs.existsSync(`${logPath}.1`), 'old log must be rotated to .log.1')
  // A fresh .log file must exist for the new run (created by createWriteStream)
  assert.ok(fs.existsSync(logPath), 'a new log file must be created after rotation')
  assert.equal(r.code, 0)
  supervisor.close()
})

// ── ProcessSupervisor: no-logDir path does not break output capture ───────────
// WHY: without a logDir, stream is null and output is still captured in memory.
// This also covers the branch where logPath is null (no rotation check, no stream).

test('ProcessSupervisor works without a logDir (in-memory output only)', async () => {
  const supervisor = new ProcessSupervisor({ graceMs: 100 })
  const r = await supervisor.run({
    command: process.execPath,
    args: ['-e', 'console.log("no-log"); console.error("err-line")'],
  })
  assert.match(r.stdout, /no-log/)
  assert.match(r.stderr, /err-line/)
  assert.equal(r.logPath, null)
  supervisor.close()
})
