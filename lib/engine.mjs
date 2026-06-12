import os from 'node:os'

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

const globalLimit = makeLimiter(Math.max(1, Math.min(16, os.cpus().length - 2)))

export async function parallel(thunks) {
  return Promise.all(thunks.map((t) => globalLimit(t).catch(() => null)))
}

export async function pipeline(items, ...stages) {
  return Promise.all(items.map((item, idx) => globalLimit(async () => {
    let v = item
    for (let i = 0; i < stages.length; i++) {
      try { v = await stages[i](v, item, idx) } catch { return null }
    }
    return v
  })))
}

export function phase(title) { process.stderr.write(`\n=== ${title} ===\n`) }
export function log(message) { process.stderr.write(`· ${message}\n`) }
