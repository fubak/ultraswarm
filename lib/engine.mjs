import os from 'node:os'
import { c, colorizeLine } from './color.mjs'

export function makeLimiter(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next() })
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next() })
}

const MAX = Math.max(1, Math.min(16, os.cpus().length - 2))
// Two SEPARATE pools. pipeline() gates the top-level wave tasks; parallel() gates the nested
// orchestration a high-risk/complex task spawns (competition / judge / adversarial-QA). A single
// shared limiter re-entrant-deadlocks: an outer pipeline task holds its slot while awaiting an inner
// parallel() that can never acquire one from the same pool (#O1). Real worker-subprocess concurrency
// stays capped at the leaf by runner.mjs workerLimit, so a second orchestration pool is safe.
// NOTE: do not nest parallel() inside another parallel() thunk — the current call graph never does
// (competition/judge/QA parallels run sequentially within a task).
const pipelineLimit = makeLimiter(MAX)
const nestedLimit = makeLimiter(MAX)

export async function parallel(thunks) {
  // Map a rejected task to null (callers .filter(Boolean) and use a quorum), but LOG the error first
  // so a transport/auth failure in a lens/judge agent isn't invisible (#S5).
  return Promise.all(thunks.map((t) => nestedLimit(t).catch((e) => { log(`parallel task failed: ${e?.message ?? e}`); return null })))
}

export async function pipeline(items, ...stages) {
  return Promise.all(items.map((item, idx) => pipelineLimit(async () => {
    let v = item
    for (let i = 0; i < stages.length; i++) {
      try { v = await stages[i](v, item, idx) } catch { return null }
    }
    return v
  })))
}

export function phase(title) { process.stderr.write(`\n${c.bold(`=== ${title} ===`)}\n`) }
// Colorize the whole line by its leading glyph (see colorizeLine) — one chokepoint, so every emit
// site stays glyph-only. No-ops to plain text when not a TTY / NO_COLOR (piped output stays clean).
export function log(message) { process.stderr.write(`· ${colorizeLine(message)}\n`) }
