import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const SECRET_RE = /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*([^\s]+)/ig
export const redact = (text = '') => String(text).replace(SECRET_RE, '$1=[REDACTED]')

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
      let stdout = '', stderr = '', timedOut = false, aborted = false, settled = false
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
        setTimeout(() => terminateTree(child.pid, 'SIGKILL'), this.graceMs).unref()
      }
      const timer = setTimeout(() => stop('timeout'), timeoutMs)
      const abort = () => stop('abort')
      signal?.addEventListener('abort', abort, { once: true })
      child.on('error', (error) => { stderr += redact(error.message) })
      child.on('close', (code, sig) => {
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.children.delete(child.pid); stream?.end()
        resolve({ code: code ?? (timedOut ? 124 : 1), signal: sig, stdout, stderr, timedOut, aborted, pid: child.pid, logPath, durationMs: Date.now() - started })
      })
    })
  }

  cancel(pid) { terminateTree(pid, 'SIGTERM') }
  close() { process.removeListener('exit', this.exitHandler); this.exitHandler() }
}
