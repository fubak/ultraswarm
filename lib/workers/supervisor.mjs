import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

// Keyword=value secrets (api_key/token/secret/password). Bearer/authorization are handled
// separately below so the whole credential is consumed, not just the first token.
const KV_SECRET_RE = /(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/ig
// authorization:/bearer <value> — consume the entire credential, including an optional "Bearer "
// scheme prefix, so "Authorization: Bearer sk-ant-..." masks the key, not just the scheme word.
const BEARER_RE = /(authorization|bearer)\b[:\s]+(?:bearer\s+)?\S+/ig
// Format-based secrets, masked independent of any keyword anchor (the leak path in B3).
const FORMAT_SECRET_RES = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,            // Anthropic keys
  /sk-[A-Za-z0-9]{20,}/g,                  // generic sk- keys
  /gh[pousr]_[A-Za-z0-9]{20,}/g,           // GitHub tokens
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWTs
]
export const redact = (text = '') => {
  let out = String(text)
  out = out.replace(BEARER_RE, '$1 [REDACTED]')
  out = out.replace(KV_SECRET_RE, (_m, key) => `${key}=[REDACTED]`)
  for (const re of FORMAT_SECRET_RES) out = out.replace(re, '[REDACTED]')
  return out
}

function descendants(pid) {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out ? out.split('\n').map(Number).flatMap((child) => [child, ...descendants(child)]) : []
  } catch { return [] }
}

export function terminateTree(pid, signal = 'SIGTERM') {
  if (!pid) return
  try { process.kill(-pid, signal); return } catch {}
  for (const child of descendants(pid).reverse()) try { process.kill(child, signal) } catch {}
  try { process.kill(pid, signal) } catch {}
}

export class ProcessSupervisor {
  constructor({ logDir, graceMs = 3000, maxOutputBytes = 10 * 1024 * 1024 } = {}) {
    this.logDir = logDir
    this.graceMs = graceMs
    this.maxOutputBytes = maxOutputBytes
    this.children = new Map()
    if (logDir) fs.mkdirSync(logDir, { recursive: true })
    this.exitHandler = () => { for (const pid of this.children.keys()) terminateTree(pid, 'SIGTERM') }
    process.once('exit', this.exitHandler)
  }

  async run({ command, args = [], cwd, env = process.env, timeoutMs = 600000, signal, label = 'worker', shell = false, onStart }) {
    const started = Date.now()
    const logPath = this.logDir ? path.join(this.logDir, `${label.replace(/[^A-Za-z0-9._-]/g, '_')}.log`) : null
    if (logPath && fs.existsSync(logPath) && fs.statSync(logPath).size >= this.maxOutputBytes) {
      fs.rmSync(`${logPath}.1`, { force: true })
      fs.renameSync(logPath, `${logPath}.1`)
    }
    const stream = logPath ? fs.createWriteStream(logPath, { flags: 'a' }) : null
    return await new Promise((resolve) => {
      const child = spawn(command, args, { cwd, env, shell, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      this.children.set(child.pid, child)
      onStart?.({ pid: child.pid, logPath })
      let stdout = '', stderr = '', timedOut = false, aborted = false, settled = false, killTimer = null
      const append = (kind, chunk) => {
        const clean = redact(chunk.toString())
        stream?.write(`[${new Date().toISOString()}] ${kind} ${clean}`)
        if (kind === 'stdout' && stdout.length < this.maxOutputBytes) stdout += clean.slice(0, this.maxOutputBytes - stdout.length)
        if (kind === 'stderr' && stderr.length < this.maxOutputBytes) stderr += clean.slice(0, this.maxOutputBytes - stderr.length)
      }
      child.stdout.on('data', (c) => append('stdout', c)); child.stderr.on('data', (c) => append('stderr', c))
      const stop = (reason) => {
        if (settled) return
        if (reason === 'timeout') timedOut = true; else aborted = true
        terminateTree(child.pid, 'SIGTERM')
        killTimer = setTimeout(() => terminateTree(child.pid, 'SIGKILL'), this.graceMs)
        killTimer.unref()
      }
      const timer = setTimeout(() => stop('timeout'), timeoutMs)
      const abort = () => stop('abort')
      signal?.addEventListener('abort', abort, { once: true })
      child.on('error', (error) => { stderr += redact(error.message) })
      child.on('close', (code, sig) => {
        // Clear BOTH timers: the watchdog and the pending SIGKILL. Leaving the kill timer armed
        // would fire SIGKILL after grace at a pid the OS may have reassigned to another process (MEDIUM).
        settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener('abort', abort); this.children.delete(child.pid); stream?.end()
        resolve({ code: code ?? (timedOut ? 124 : 1), signal: sig, stdout, stderr, timedOut, aborted, pid: child.pid, logPath, durationMs: Date.now() - started })
      })
    })
  }

  cancel(pid) { terminateTree(pid, 'SIGTERM') }
  close() { process.removeListener('exit', this.exitHandler); this.exitHandler() }
}
