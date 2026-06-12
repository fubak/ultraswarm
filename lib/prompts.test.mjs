import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IMPL_SCHEMA, enhancedImplPrompt, expertLensPrompt, EXPERT_LENSES } from './prompts.mjs'

test('IMPL_SCHEMA requires the fields the runner consumes', () => {
  for (const f of ['status', 'gate_results', 'cli_tokens', 'worktree', 'branch']) {
    assert.ok(IMPL_SCHEMA.required.includes(f), `missing ${f}`)
  }
})

test('enhancedImplPrompt embeds the resolved command and worktree path', () => {
  const cfg = { repo: '/r', baseBranch: 'HEAD', worktreeRoot: '/w', repoName: 'r',
    gates: [{ name: 'test', cmd: 'npm test' }] }
  const t = { id: 't1', description: 'd', files: ['a.js'], model_tier: 'simple', complexity_score: 10, prompt: 'go' }
  const s = enhancedImplPrompt(cfg, t, 'codex', 1, [], 'codex exec -m gpt-5.4-mini ...', 900000)
  assert.match(s, /codex exec -m gpt-5\.4-mini/)
  assert.match(s, /\/w\/r-us-t1-codex/)
})

test('EXPERT_LENSES are correctness/security/regression and the security lens prompt sets polarity', () => {
  assert.deepEqual(EXPERT_LENSES, ['correctness', 'security', 'regression'])
  const s = expertLensPrompt('security', { id: 't1', description: 'd', complexity_score: 60 },
    { worktree: '/w/x', branch: 'b', model_used: 'm' }, 'HEAD')
  assert.match(s, /refuted=true ONLY if/)
})
