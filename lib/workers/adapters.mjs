import { execFileSync } from 'node:child_process'
import { ProcessSupervisor } from './supervisor.mjs'
import { resolveRoute, DEFAULT_REGISTRY } from '../../scripts/router.mjs'
import { makeLimiter } from '../engine.mjs'

const CAPABILITIES = {
  codex: { languages: ['*'], strengths: ['backend', 'logic', 'debugging', 'architecture'], structuredOutput: true, resume: true },
  gemini: { languages: ['*'], strengths: ['frontend', 'ui', 'design'], structuredOutput: false, resume: false },
  grok: { languages: ['*'], strengths: ['tests', 'refactors', 'general'], structuredOutput: false, resume: false },
  agy: { languages: ['*'], strengths: ['docs', 'boilerplate', 'automation'], structuredOutput: false, resume: false },
  droid: { languages: ['*'], strengths: ['full-stack', 'refactors', 'architecture'], structuredOutput: false, resume: false },
  opencode: { languages: ['*'], strengths: ['boilerplate', 'lint', 'tests', 'docs'], structuredOutput: false, resume: false },
}

export class ShellWorkerAdapter {
  constructor(name, cfg, supervisor, limit = (fn) => fn()) { this.name = name; this.cfg = cfg; this.supervisor = supervisor; this.limit = limit }
  probe() {
    try { return { healthy: true, version: execFileSync(this.name, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), capabilities: this.capabilities() } }
    catch (error) { return { healthy: false, error: error.message, capabilities: this.capabilities() } }
  }
  capabilities() { return { name: this.name, ...(CAPABILITIES[this.name] ?? { languages: ['*'], strengths: ['general'] }) } }
  validateModel(task) { resolveRoute({ ...task, cli: this.name }, this.cfg); return true }
  execute(options) { return this.limit(() => this.executeNow(options)) }
  async executeNow({ task, cwd, timeoutMs, signal, label, env, onStart }) {
    const route = this.cfg.registry?.[this.name]
      ? { command: typeof this.cfg.registry[this.name] === 'string' ? this.cfg.registry[this.name] : (this.cfg.registry[this.name][task.model_tier] ?? this.cfg.registry[this.name].simple) }
      : resolveRoute({ ...task, cli: this.name }, this.cfg)
    const container = this.cfg.policy?.isolation === 'container'
    const command = container ? 'docker' : '/bin/bash'
    const args = container
      ? ['run', '--rm', '--init', ...(this.cfg.policy.network === 'deny' ? ['--network', 'none'] : []), '-v', `${cwd}:/workspace`, '-w', '/workspace', this.cfg.policy.containerImage, '/bin/bash', '-lc', route.command]
      : ['-lc', route.command]
    const result = await this.supervisor.run({ command, args, cwd, timeoutMs, signal, label, env, onStart })
    return { ...result, model: route.model ?? task.model_tier, usage: this.parseUsage(`${result.stdout}\n${result.stderr}`) }
  }
  cancel(pid) { this.supervisor.cancel?.(pid) }
  recover() { return { recoverable: false } }
  parseUsage(text) {
    const tokens = text.match(/tokens?\s*(?:used)?[:\s]+(\d+)/i), cost = text.match(/cost\s*[:=]\s*\$?([\d.]+)/i)
    return { totalTokens: tokens ? Number(tokens[1]) : 0, costUsd: cost ? Number(cost[1]) : 0 }
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
    this.adapters = new Map(Object.keys(DEFAULT_REGISTRY).map((name) => [name, new ShellWorkerAdapter(name, cfg, this.supervisor)]))
  }
  get(name) { const a = this.adapters.get(name); if (!a) throw new Error(`unknown worker ${name}`); return a }
  probes(enabled = Object.keys(DEFAULT_REGISTRY)) { return enabled.map((name) => ({ name, ...this.get(name).probe() })) }
  close() { this.supervisor.close() }
}
