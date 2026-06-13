#!/usr/bin/env node
// Thin entrypoint. Every command (run/merge/status/logs/cancel/resume/doctor/explain-routing/export)
// lives in cli.mjs; legacy `--plan-file ... --yes` is handled by commandMain's v2 compatibility shim.
import { commandMain, exitCode, requireNode22 } from './cli.mjs'

if (import.meta.url === `file://${process.argv[1]}`) {
  // ultraswarm depends on node:sqlite (stable in Node 22). Guard at startup so an old Node fails
  // with a clear message instead of a cryptic missing-module crash.
  const guard = requireNode22(process.versions.node)
  if (guard) { console.error(guard); process.exitCode = 2 }
  else commandMain().then((code) => { process.exitCode = code }).catch((e) => { console.error(`ultraswarm: ${e.message}`); process.exitCode = exitCode(e) })
}
