// LlmClient.complete({ system?, prompt, schema?, model, effort?, label? }) -> { object, usage }
export class MockLlmClient {
  constructor(behavior) { this.behavior = behavior; this.calls = [] }
  async complete(opts) {
    this.calls.push({ label: opts.label || '', model: opts.model, prompt: opts.prompt })
    return this.behavior(opts.label || '', opts)
  }
}
