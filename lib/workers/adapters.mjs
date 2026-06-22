import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ProcessSupervisor } from './supervisor.mjs'
import { resolveRoute, buildRegistry } from '../router.mjs'
import { makeLimiter } from '../engine.mjs'
import { smokeTest } from './smoke.mjs'
import { allowedEnv } from '../orchestrator/implement.mjs'

const CAPABILITIES = {
  codex: { languages: ['*'], strengths: ['backend', 'logic', 'debugging', 'architecture'], structuredOutput: true, resume: true },
  gemini: { languages: ['*'], strengths: ['frontend', 'ui', 'design'], structuredOutput: false, resume: false },
  grok: { languages: ['*'], strengths: ['tests', 'refactors', 'general'], structuredOutput: false, resume: false },
  agy: { languages: ['*'], strengths: ['docs', 'boilerplate', 'automation'], structuredOutput: false, resume: false },
  droid: { languages: ['*'], strengths: ['full-stack', 'refactors', 'architecture'], structuredOutput: false, resume: false },
  opencode: { languages: ['*'], strengths: ['boilerplate', 'lint', 'tests', 'docs'], structuredOutput: false, resume: false },
  pi: { languages: ['*'], strengths: ['general', 'full-stack', 'refactors'], structuredOutput: false, resume: false },
  'pi-local': { languages: ['*'], strengths: ['general', 'boilerplate', 'docs', 'tests'], structuredOutput: false, resume: false },
  'small-harness': { languages: ['*'], strengths: ['tool-rich', 'mcp-integration', 'cost-tracking', 'multi-backend', 'local-models'], structuredOutput: false, resume: false },
  agent: { languages: ['*'], strengths: ['general', 'full-stack', 'refactors', 'debugging', 'tests'], structuredOutput: false, resume: true },
}

export class ShellWorkerAdapter {
  constructor(name, cfg, supervisor, limit = (fn) => fn()) {
    this.name = name
    const registry = buildRegistry(cfg)
    this.base = registry[name]?.extends   // built-in name this alias inherits from, if any
    this.binary = registry[name]?.binary ?? name
    this.cfg = cfg
    this.supervisor = supervisor
    this.limit = limit
  }
  probe() {
    try { return { healthy: true, version: execFileSync(this.binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), capabilities: this.capabilities() } }
    catch (error) { return { healthy: false, error: error.message, capabilities: this.capabilities() } }
  }
  capabilities() { return { name: this.name, ...(CAPABILITIES[this.name] ?? CAPABILITIES[this.base] ?? { languages: ['*'], strengths: ['general'] }) } }
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
    return { ...result, model: route.model ?? task.model_tier, usage: this.parseUsage() }
  }
  cancel(pid) { this.supervisor.cancel?.(pid) }
  recover() { return { recoverable: false } }
  // External coding CLIs don't emit their LLM token/cost usage in any reliable, structured form.
  // The old free-text scrape (/tokens?\s*used?[:\s]+(\d+)/) matched incidental numbers in the worker's
  // OWN output — reporting e.g. ~20 tokens for a multi-thousand-token implementation, a noisy
  // undercount that misrepresented the offload. Report nothing rather than a fabricated number
  // (Rule 12); this method is the single seam where a real structured-usage parser would slot in once
  // a worker exposes one (e.g. a `--json` usage envelope).
  parseUsage() {
    return { totalTokens: null, costUsd: null }
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
