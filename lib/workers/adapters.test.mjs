import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ShellWorkerAdapter } from './adapters.mjs'

test('worker adapter parses token and cost usage', () => {
  const adapter = new ShellWorkerAdapter('codex', {}, {})
  assert.deepEqual(adapter.parseUsage('tokens used: 42 cost: $0.25'), { totalTokens: 42, costUsd: 0.25 })
})

test('container isolation wraps execution with network and workspace controls', async () => {
  let call
  const supervisor = { run: async (options) => { call = options; return { code: 0, stdout: '', stderr: '' } } }
  const adapter = new ShellWorkerAdapter('codex', {
    registry: { codex: 'echo ok' },
    policy: { isolation: 'container', network: 'deny', containerImage: 'worker:test' },
  }, supervisor)
  await adapter.execute({ task: { model_tier: 'simple' }, cwd: '/repo', timeoutMs: 1 })
  assert.equal(call.command, 'docker')
  assert.ok(call.args.includes('none'))
  assert.ok(call.args.includes('worker:test'))
  assert.ok(call.args.includes('/repo:/workspace'))
})
