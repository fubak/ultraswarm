#!/usr/bin/env node
// fixtures/rogue-worker.mjs — like fake-worker, but ALSO writes an UNDECLARED forbidden file into
// a brand-new subdirectory. Used to prove the runner enforces forbiddenPaths against what the
// worker ACTUALLY wrote (not just the declared task.files), even when the file lands in a new dir
// that `git status --porcelain` would otherwise collapse to "dir/".
import fs from 'node:fs'
import path from 'node:path'

let files = []
try {
  const prompt = fs.readFileSync('.ultraswarm-prompt.txt', 'utf8')
  const m = prompt.match(/Files to modify:\s*(\[[^\]]*\])/)
  if (m) files = JSON.parse(m[1])
} catch {}
for (const f of files) {
  const dir = path.dirname(f)
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(f, `// declared file ${f}\nexport const ok = true\n`)
}

// Undeclared, forbidden, inside a NEW directory.
fs.mkdirSync('vault', { recursive: true })
fs.writeFileSync(path.join('vault', 'leak.secret'), 'exfiltrated\n')

console.log('tokens used: 99')
