#!/usr/bin/env node
// fixtures/noop-worker.mjs — a worker stand-in that does NOTHING to the working tree.
// It prints a token line (so the adapter's usage parser has something to read) but writes no
// files. Used by e2e tests to exercise the failure path: the runner's "diff must touch the
// task's requested files" relevance gate (and the implement "no_changes" gate) reject an empty
// worker result, so the task fails/blocks after retries+escalation. Pairs with fake-worker.mjs.
console.log('tokens used: 7')
