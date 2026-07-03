import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ProcessSupervisor } from './supervisor.mjs'
import { resolveRoute, buildRegistry } from '../router.mjs'
import { makeLimiter } from '../engine.mjs'
import { smokeTest } from './smoke.mjs'
import { allowedEnv } from '../orchestrator/implement.mjs'

// Resolve a dot-path usage descriptor against a parsed JSON object. A '*' segment sums the
// resolved remainder across every value of the current object (gemini keys `stats.models` by
// model name). Returns a number when the path resolves to one, else undefined — never NaN or 0,
// so callers can tell "not found" apart from "found and zero".
function resolvePath(obj, segments) {
  if (segments.length === 0) return typeof obj === 'number' ? obj : undefined
  const [segment, ...rest] = segments
  if (segment === '*') {
    if (!obj || typeof obj !== 'object') return undefined
    let sum = 0, any = false
    for (const value of Object.values(obj)) {
      const resolved = resolvePath(value, rest)
      if (typeof resolved === 'number') { sum += resolved; any = true }
    }
    return any ? sum : undefined
  }
  if (!obj || typeof obj !== 'object' || !(segment in obj)) return undefined
  return resolvePath(obj[segment], rest)
}

export class ShellWorkerAdapter {
  constructor(name, cfg, supervisor, limit = (fn) => fn()) {
    this.name = name
    const registry = buildRegistry(cfg)
    this.base = registry[name]?.extends   // built-in name this alias inherits from, if any
    this.binary = registry[name]?.binary ?? name
    this.entry = registry[name] ?? {}
    this.cfg = cfg
    this.supervisor = supervisor
    this.limit = limit
  }
  probe() {
    try { return { healthy: true, version: execFileSync(this.binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), capabilities: this.capabilities() } }
    catch (error) { return { healthy: false, error: error.message, capabilities: this.capabilities() } }
  }
  capabilities() {
    const entry = this.entry
    return {
      name: this.name,
      languages: ['*'],
      strengths: entry.strengths ?? ['general'],
      structuredOutput: entry.structuredOutput ?? false,
      resume: entry.resume ?? false,
    }
  }
  validateModel(task) { resolveRoute({ ...task, cli: this.name }, this.cfg); return true }
  execute(options) { return this.limit(() => this.executeNow(options)) }
  async executeNow({ task, cwd, timeoutMs, signal, label, env, onStart }) {
    const route = this.cfg.registry?.[this.name]
      ? { command: typeof this.cfg.registry[this.name] === 'string' ? this.cfg.registry[this.name] : (this.cfg.registry[this.name][task.model_tier] ?? this.cfg.registry[this.name].simple) }
      : resolveRoute({ ...task, cli: this.name }, this.cfg)
    const container = this.cfg.policy?.isolation === 'container'
    // A ':' in cwd corrupts `-v <cwd>:/workspace` (docker reads it as host:container:opts), silently
    // mounting the wrong path — reject it loudly (#SE3).
    if (container && cwd.includes(':')) throw new Error(`container mount path must not contain ':' (would corrupt the -v volume spec): ${cwd}`)
    const command = container ? 'docker' : '/bin/bash'
    // NOTE: container network isolation is OPT-IN via policy.network==='deny'. `isolation:'container'`
    // alone isolates the filesystem (only cwd is bind-mounted) but leaves host network reachable, since
    // most workers need network (deps, APIs). Set network:'deny' for full isolation (#SE3).
    const args = container
      ? ['run', '--rm', '--init', ...(this.cfg.policy.network === 'deny' ? ['--network', 'none'] : []), '-v', `${cwd}:/workspace`, '-w', '/workspace', this.cfg.policy.containerImage, '/bin/bash', '-lc', route.command]
      : ['-lc', route.command]
    const result = await this.supervisor.run({ command, args, cwd, timeoutMs, signal, label, env, onStart })
    const descriptors = this.cfg.overrides?.[this.name]?.usage ?? this.entry.usage ?? []
    return { ...result, model: route.model ?? task.model_tier, usage: this.parseUsage(`${result.stdout}\n${result.stderr}`, descriptors) }
  }
  cancel(pid) { this.supervisor.cancel?.(pid) }
  recover() { return { recoverable: false } }
  // Real token/cost usage from a worker's STRUCTURED JSON output — never a free-text scrape (the old
  // /tokens?\s*used?[:\s]+(\d+)/ matched incidental numbers in a worker's own content and undercounted
  // by orders of magnitude). `descriptors` are the CLI's registry (or override) `usage` entries — each
  // `{ input, output, cost? }` a set of dot-paths evaluated against every candidate JSON object found in
  // the worker's stdout+stderr. Candidates are every JSONL line that parses as JSON (codex/opencode emit
  // one usage event per turn/step; we parse and SUM them — total tokens the worker actually processed,
  // what the provider bills) PLUS the whole text parsed as a single JSON object (gemini emits one
  // object, not JSONL, possibly pretty-printed across lines — guarded against double-counting when that
  // single object is also the sole JSONL line). A `*` path segment sums across every value of a keyed
  // map (gemini's `stats.models.<model>`). A worker whose output matches no descriptor (text-mode CLI,
  // fake test worker, unverified shape) yields nulls → the report says "not reported" instead of
  // inventing a figure (Rule 12).
  parseUsage(text, descriptors = []) {
    const lines = (text || '').split('\n')
    const candidates = []
    for (const raw of lines) {
      const line = raw.trim()
      if (line.length < 2 || line[0] !== '{') continue
      try { candidates.push(JSON.parse(line)) } catch { continue }
    }
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0).length
    if (nonEmptyLines > 1 || candidates.length === 0) {
      const whole = (text || '').trim()
      if (whole.length > 1 && whole[0] === '{') {
        try { candidates.push(JSON.parse(whole)) } catch { /* not a single JSON object */ }
      }
    }
    let input = 0, output = 0, cost = 0, found = false
    for (const candidate of candidates) {
      for (const descriptor of descriptors) {
        const inputVal = resolvePath(candidate, descriptor.input.split('.'))
        const outputVal = resolvePath(candidate, descriptor.output.split('.'))
        if (typeof inputVal !== 'number' && typeof outputVal !== 'number') continue
        input += inputVal || 0; output += outputVal || 0; found = true
        if (descriptor.cost) {
          const costVal = resolvePath(candidate, descriptor.cost.split('.'))
          if (typeof costVal === 'number') cost += costVal
        }
      }
    }
    if (!found) return { input_tokens: null, output_tokens: null, totalTokens: null, costUsd: null }
    return { input_tokens: input, output_tokens: output, totalTokens: input + output, costUsd: cost || null }
  }
  classifyFailure(result) {
    const text = `${result.stderr} ${result.stdout}`.toLowerCase()
    if (result.timedOut) return 'timeout'
    if (result.aborted) return 'cancelled'
    if (/auth|unauthorized|login|credential|api[_ -]?key/.test(text)) return 'auth'
    if (/command not found|enoent|no such file/.test(text)) return 'not_installed'
    if (/transport|channel closed|econnrefused|dns|proxy/.test(text)) return 'transport'
    return 'error'
  }
}

export class WorkerManager {
  constructor(cfg, { supervisor } = {}) {
    this.cfg = cfg
    this.supervisor = supervisor ?? new ProcessSupervisor({ logDir: `${cfg.repo}/.ultraswarm/logs` })
    this._names = Object.keys(buildRegistry(cfg))
    this.adapters = new Map(this._names.map((name) => [name, new ShellWorkerAdapter(name, cfg, this.supervisor)]))
  }
  names() { return [...this._names] }
  get(name) { const a = this.adapters.get(name); if (!a) throw new Error(`unknown worker ${name}`); return a }
  probes(enabled = this._names) { return enabled.map((name) => ({ name, ...this.get(name).probe() })) }

  // Where the functional-probe cache lives (per-repo, alongside the durable store + logs).
  _functionalCachePath() { return path.join(this.cfg.repo ?? '.', '.ultraswarm', 'functional-probe.json') }
  _readFunctionalCache() { try { return JSON.parse(fs.readFileSync(this._functionalCachePath(), 'utf8')) } catch { return {} } }
  _writeFunctionalCache(cache) {
    try { fs.mkdirSync(path.dirname(this._functionalCachePath()), { recursive: true }); fs.writeFileSync(this._functionalCachePath(), `${JSON.stringify(cache, null, 2)}\n`) } catch { /* cache is best-effort */ }
  }

  /**
   * Like `probes()` but each worker is FUNCTIONALLY verified: a worker that fails `--version` is
   * `installed:false`; one that passes `--version` is smoke-tested (cached by name@version, default
   * 24h TTL) and marked `functional:false` if it can't actually write a file (dead auth, no-op, etc).
   * `healthy` is set to the functional verdict so routing (`routeTask`) and the
   * `minimumHealthyWorkers` gate exclude non-functional workers WITHOUT any routing change.
   * Async because the smoke test spawns the real worker. Probes run sequentially: cheap workers
   * finish fast and a destructive worker can't race a healthy one.
   */
  async functionalProbes(enabled = this._names, { ttlMs = 86400000, force = false, now = Date.now(), env, timeoutMs } = {}) {
    const base = this.probes(enabled)
    const cache = this._readFunctionalCache()
    const probeEnv = env ?? allowedEnv(this.cfg)
    const out = []
    let dirty = false
    for (const probe of base) {
      if (!probe.healthy) { out.push({ ...probe, installed: false, functional: false, kind: 'not_installed', reason: probe.error }); continue }
      const key = `${probe.name}@${probe.version ?? ''}`
      const cached = cache[key]
      if (!force && cached && Number.isFinite(Date.parse(cached.checkedAt)) && now - Date.parse(cached.checkedAt) < ttlMs) {
        out.push({ ...probe, installed: true, functional: cached.functional, kind: cached.kind, reason: cached.reason, healthy: cached.functional, fromCache: true })
        continue
      }
      const r = await smokeTest(this.get(probe.name), { env: probeEnv, timeoutMs })
      cache[key] = { functional: r.functional, kind: r.kind, reason: r.reason ?? null, checkedAt: new Date(now).toISOString(), durationMs: r.durationMs }
      dirty = true
      out.push({ ...probe, installed: true, functional: r.functional, kind: r.kind, reason: r.reason ?? null, healthy: r.functional, fromCache: false })
    }
    if (dirty) this._writeFunctionalCache(cache)
    return out
  }
  close() { this.supervisor.close() }
}
