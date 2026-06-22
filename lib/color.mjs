// Minimal ANSI color for human output. Auto-DISABLED unless a TTY is attached, so piped/redirected
// output (CI logs, `> file`, `| less`) stays clean. Honors the de-facto NO_COLOR convention
// (https://no-color.org) and FORCE_COLOR=1 to force it on (tests / explicit opt-in). `ultraswarm
// --no-color` sets NO_COLOR before any output. Decision is evaluated per-call so flags set at startup
// take effect and tests can toggle it.
function enabled() {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR === '1') return true
  return !!(process.stdout && process.stdout.isTTY) || !!(process.stderr && process.stderr.isTTY)
}

const wrap = (code) => (s) => (enabled() ? `\x1b[${code}m${s}\x1b[0m` : String(s))

export const c = {
  green: wrap(32), red: wrap(31), yellow: wrap(33), cyan: wrap(36), dim: wrap(2), bold: wrap(1),
}

// Colorize a whole live-stream line by its leading glyph, so the dozens of emit sites
// (runner/implement/core) stay glyph-only and coloring lives in ONE place (engine.log).
//   ✔/✓ approved/passed → green   ✗ rejected/failed/missing → red
//   ↑ escalating / ⊘ blocked → yellow   ⏱ heartbeat → dim
export function colorizeLine(message) {
  const g = String(message).trimStart()[0]
  if (g === '✔' || g === '✓') return c.green(message)
  if (g === '✗') return c.red(message)
  if (g === '↑' || g === '⊘') return c.yellow(message)
  if (g === '⏱') return c.dim(message)
  return message
}
