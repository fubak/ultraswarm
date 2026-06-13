#!/usr/bin/env node
// Thin entrypoint. Every command (run/merge/status/logs/cancel/resume/doctor/explain-routing/export)
// lives in cli.mjs; legacy `--plan-file ... --yes` is handled by commandMain's v2 compatibility shim.
import { commandMain, exitCode } from './cli.mjs'

if (import.meta.url === `file://${process.argv[1]}`) {
  commandMain().then((code) => { process.exitCode = code }).catch((e) => { console.error(`ultraswarm: ${e.message}`); process.exitCode = exitCode(e) })
}
