import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { classifyWorkerError } from '../orchestrator/implement.mjs'

// A worker that passes `--version` is INSTALLED, not FUNCTIONAL. The report that motivated this
// module showed gemini passing `--version` while every real execution failed (dead auth) and
// opencode running but mutating shared node_modules. The smoke test runs each worker on a trivial
// file-creation task in an ISOLATED temp dir and verifies the artifact actually appears — the same
// "verify by artifact, not exit code" rule docs/notes/cli-verification.md established for the
// original manual Phase-0 write probe.

export const SMOKE_FILE = 'ULTRASWARM_OK.txt'
export const SMOKE_PROMPT =
  `Create a single file named ${SMOKE_FILE} containing exactly the text OK. Do not create, read, or modify any other file. Do not run any commands.`

// `simple` tier = the cheapest model for every worker; `effort: low` keeps reasoning minimal.
const SMOKE_TASK = Object.freeze({ id: 'smoke', model_tier: 'simple', complexity_score: 1, effort: 'low', files: [SMOKE_FILE], prompt: SMOKE_PROMPT })

const DEFAULT_SMOKE_TIMEOUT_MS = 120000

/**
 * Functionally smoke-test one worker adapter.
 *
 * @param {object} adapter - a ShellWorkerAdapter (or test fake) exposing `name`, `execute()`, and optionally `classifyFailure()`.
 * @param {object} [opts]
 * @param {object} [opts.env]        - environment passed to the worker (default: process.env).
 * @param {number} [opts.timeoutMs]  - hard cap for the probe run (default 120s).
 * @returns {Promise<{name, functional, kind, durationMs}>} - functional=true iff the artifact was written.
 */
export async function smokeTest(adapter, { env = process.env, timeoutMs = DEFAULT_SMOKE_TIMEOUT_MS } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'us-smoke-'))
  const started = Date.now()
  try {
    // A real git repo so workers that expect one (and to mirror the worktree they normally run in)
    // behave the same here. Best-effort: codex uses --skip-git-repo-check, others tolerate it.
    try { execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' }) } catch {}
    fs.writeFileSync(path.join(dir, '.ultraswarm-prompt.txt'), SMOKE_PROMPT)
    let result
    try {
      result = await adapter.execute({ task: SMOKE_TASK, cwd: dir, timeoutMs, env, label: `smoke-${adapter.name}` })
    } catch (error) {
      return { name: adapter.name, functional: false, kind: classifyWorkerError(error), durationMs: Date.now() - started }
    }
    const created = fs.existsSync(path.join(dir, SMOKE_FILE))
    if (created) return { name: adapter.name, functional: true, kind: null, durationMs: Date.now() - started }
    // No artifact. Classify WHY: a clean exit that wrote nothing is `no_op` (the gemini-style
    // "auth dead, narrates but never writes" failure); a non-zero exit is classified from output.
    const kind = result?.code === 0 ? 'no_op' : (adapter.classifyFailure?.(result) ?? 'error')
    return { name: adapter.name, functional: false, kind, durationMs: Date.now() - started }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
