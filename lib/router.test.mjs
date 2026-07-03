import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_REGISTRY,
  loadConfig,
  validateConfig,
  resolveRoute,
  buildRegistry,
} from './router.mjs';

describe('router', () => {
  describe('loadConfig', () => {
    let tmpDir;
    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
    });
    after(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns {} when both globalPath and projectPath configs are absent', () => {
      const cfg = loadConfig({
        globalPath: path.join(tmpDir, 'absent-global.json'),
        projectPath: path.join(tmpDir, 'absent-project.json'),
      });
      assert.deepStrictEqual(cfg, {});
    });

    it('returns only-global content when only globalPath exists (project absent)', () => {
      const gPath = path.join(tmpDir, 'only-g.json');
      const globalData = {
        enabled: ['codex', 'grok'],
        intelligence: { promptAnalysis: { complexityThresholds: { simple: 5 } } },
      };
      fs.writeFileSync(gPath, JSON.stringify(globalData));
      const cfg = loadConfig({
        globalPath: gPath,
        projectPath: path.join(tmpDir, 'absent-p.json'),
      });
      assert.deepStrictEqual(cfg, globalData);
    });

    it("project 'enabled' replaces global 'enabled' exactly (global ['codex','grok'], project ['gemini'] -> ['gemini'])", () => {
      const gPath = path.join(tmpDir, 'g-en.json');
      const pPath = path.join(tmpDir, 'p-en.json');
      fs.writeFileSync(gPath, JSON.stringify({ enabled: ['codex', 'grok'] }));
      fs.writeFileSync(pPath, JSON.stringify({ enabled: ['gemini'] }));
      const cfg = loadConfig({ globalPath: gPath, projectPath: pPath });
      assert.deepStrictEqual(cfg.enabled, ['gemini']);
    });

    it("'overrides' deep-merge keeps global timeoutMs + project models.simple; project wins on colliding keys", () => {
      const gPath = path.join(tmpDir, 'g-ov.json');
      const pPath = path.join(tmpDir, 'p-ov.json');
      fs.writeFileSync(gPath, JSON.stringify({
        overrides: {
          codex: {
            timeoutMs: 123456,
            models: {
              simple: { model: 'g-model', invocation: 'global-inv $(cat .ultraswarm-prompt.txt)' },
            },
          },
        },
      }));
      fs.writeFileSync(pPath, JSON.stringify({
        overrides: {
          codex: {
            models: {
              simple: { model: 'p-model', invocation: 'project-inv $(cat .ultraswarm-prompt.txt)' },
            },
          },
        },
      }));
      const cfg = loadConfig({ globalPath: gPath, projectPath: pPath });
      assert.strictEqual(cfg.overrides.codex.timeoutMs, 123456);
      assert.strictEqual(cfg.overrides.codex.models.simple.model, 'p-model');
      assert.strictEqual(cfg.overrides.codex.models.simple.invocation, 'project-inv $(cat .ultraswarm-prompt.txt)');
    });

    it('throws Error whose message names the file path when invalid JSON present in a file', () => {
      const badPath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(badPath, '{ "broken": true, '); // invalid
      assert.throws(
        () => loadConfig({ globalPath: badPath, projectPath: path.join(tmpDir, 'no.json') }),
        (err) => {
          assert(err instanceof Error);
          assert.ok(err.message.includes('Invalid JSON in '));
          assert.ok(err.message.includes(badPath));
          return true;
        }
      );
    });
  });

  describe('validateConfig', () => {
    it('empty enabled array -> valid:false plus error (must be non-empty or omitted)', () => {
      const res = validateConfig({ enabled: [] });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('non-empty array')));
    });

    it('unknown CLI name in enabled produces warning (not error), valid remains true', () => {
      const res = validateConfig({ enabled: ['codex', 'no-such-cli'] });
      assert.strictEqual(res.valid, true);
      assert.ok(res.warnings.some((w) => w.includes('unknown CLI "no-such-cli"')));
      assert.strictEqual(res.errors.length, 0);
    });

    it('overrides.<cli>.models missing required "simple" tier -> error', () => {
      const res = validateConfig({
        overrides: {
          codex: {
            models: {
              moderate: { model: 'm', invocation: 'foo $(cat .ultraswarm-prompt.txt)' },
            },
          },
        },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('missing required tier "simple"')));
    });

    it('invocation missing ".ultraswarm-prompt.txt" substring -> error (covers flat form)', () => {
      const res = validateConfig({
        overrides: {
          gemini: { invocation: 'gemini --yolo "some prompt without marker"' },
        },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('.ultraswarm-prompt.txt') && e.includes('overrides.gemini.invocation')));
    });

    it('non-monotonic intelligence.promptAnalysis.complexityThresholds -> error', () => {
      const res = validateConfig({
        intelligence: {
          promptAnalysis: {
            complexityThresholds: { simple: 50, moderate: 20, complex: 100, expert: 200 },
          },
        },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('simple < moderate < complex < expert')));
    });

    it('claudeModels value outside haiku|sonnet|opus -> error', () => {
      const res = validateConfig({
        intelligence: {
          modelRouting: { claudeModels: { promptAnalysis: 'claude-3' } },
        },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('must be one of haiku, sonnet, opus')));
    });

    it('claudeModels accepts fable as the opt-in ceiling model', () => {
      const res = validateConfig({
        intelligence: {
          modelRouting: { claudeModels: { highRiskQA: 'fable' } },
        },
      });
      assert.strictEqual(res.valid, true);
      assert.deepStrictEqual(res.errors, []);
    });

    it('overrides.<cli>.usage rejects a non-array value', () => {
      const res = validateConfig({ overrides: { codex: { usage: 'nope' } } });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('overrides.codex.usage must be an array')));
    });

    it('overrides.<cli>.usage rejects a descriptor missing input/output', () => {
      const res = validateConfig({ overrides: { codex: { usage: [{ input: 'a' }] } } });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('overrides.codex.usage[0].output must be a non-empty string')));
    });

    it('overrides.<cli>.usage rejects a non-string cost when present', () => {
      const res = validateConfig({ overrides: { codex: { usage: [{ input: 'a', output: 'b', cost: 5 }] } } });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('overrides.codex.usage[0].cost must be a string')));
    });

    it('overrides.<cli>.usage accepts a well-formed descriptor array', () => {
      const res = validateConfig({ overrides: { codex: { usage: [{ input: 'a', output: 'b', cost: 'c' }] } } });
      assert.strictEqual(res.valid, true);
      assert.deepStrictEqual(res.errors, []);
    });

    it('aliases.<name>.usage is validated under the "aliases." scope', () => {
      const res = validateConfig({
        aliases: {
          'a-x': {
            extends: 'pi',
            usage: [{ input: 'a' }],
            models: { simple: { model: 'm', invocation: 'pi "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('aliases.a-x.usage[0].output must be a non-empty string')));
    });
  });

  describe('resolveRoute', () => {
    it('tier boundaries (default thresholds): complexity_score 20->simple, 21->moderate, 50->moderate, 51->complex, 101->expert', () => {
      const cases = [
        [20, 'simple'],
        [21, 'moderate'],
        [50, 'moderate'],
        [51, 'complex'],
        [101, 'expert'],
      ];
      for (const [score, expectedTier] of cases) {
        const r = resolveRoute({ cli: 'grok', complexity_score: score });
        assert.strictEqual(r.tier, expectedTier);
      }
    });

    it('explicit valid model_tier wins over complexity_score; invalid model_tier string throws with allowed list', () => {
      const r = resolveRoute({ cli: 'droid', complexity_score: 80, model_tier: 'expert' });
      assert.strictEqual(r.tier, 'expert');

      assert.throws(
        () => resolveRoute({ cli: 'droid', model_tier: 'turbo' }),
        (err) => {
          assert(err.message.includes('Invalid model_tier "turbo"'));
          assert(err.message.includes('simple, moderate, complex, expert'));
          return true;
        }
      );
    });

    it('unknown cli throws Error listing the allowed CLI names', () => {
      assert.throws(
        () => resolveRoute({ cli: 'claude' }),
        (err) => {
          assert(err.message.includes('Unknown cli "claude"'));
          assert(err.message.includes('codex'));
          assert(err.message.includes('small-harness'));
          return true;
        }
      );
    });

    it('nested overrides.<cli>.models.<tier>.invocation used when present; falls back to overrides simple when tier absent in models; falls to DEFAULT_REGISTRY when no overrides for cli', () => {
      const ovConfig = {
        overrides: {
          codex: {
            models: {
              simple: { model: 'x', invocation: 'CODEX-OV-SIMPLE "$(cat .ultraswarm-prompt.txt)"' },
              complex: { model: 'y', invocation: 'CODEX-OV-COMPLEX "$(cat .ultraswarm-prompt.txt)"' },
            },
          },
        },
      };
      // exact tier
      let r = resolveRoute({ cli: 'codex', model_tier: 'complex' }, ovConfig);
      assert.strictEqual(r.command, 'CODEX-OV-COMPLEX "$(cat .ultraswarm-prompt.txt)"');
      // absent tier falls to ov's simple
      r = resolveRoute({ cli: 'codex', model_tier: 'moderate' }, ovConfig);
      assert.strictEqual(r.command, 'CODEX-OV-SIMPLE "$(cat .ultraswarm-prompt.txt)"');
      // no overrides at all -> registry default
      r = resolveRoute({ cli: 'opencode', complexity_score: 5 });
      assert.strictEqual(r.command, DEFAULT_REGISTRY.opencode.models.simple.invocation);
    });

    it('flat overrides.<cli>.invocation is honored (when models block absent)', () => {
      const flatCfg = {
        overrides: {
          agy: {
            invocation: 'AGY-FLAT-OVERRIDE "$(cat .ultraswarm-prompt.txt)"',
          },
        },
      };
      const r = resolveRoute({ cli: 'agy', model_tier: 'expert' }, flatCfg);
      assert.strictEqual(r.command, 'AGY-FLAT-OVERRIDE "$(cat .ultraswarm-prompt.txt)"');
    });

    it('timeoutMs from overrides.<cli>.timeoutMs when set, otherwise DEFAULT_REGISTRY.<cli>.timeoutMs', () => {
      const tCfg = { overrides: { gemini: { timeoutMs: 424242 } } };
      let r = resolveRoute({ cli: 'gemini', model_tier: 'simple' }, tCfg);
      assert.strictEqual(r.timeoutMs, 424242);

      r = resolveRoute({ cli: 'gemini', model_tier: 'simple' });
      assert.strictEqual(r.timeoutMs, DEFAULT_REGISTRY.gemini.timeoutMs);
    });

    it('injects the per-CLI effort flag, defaulting to low', () => {
      assert.match(resolveRoute({ cli: 'codex', model_tier: 'simple' }).command, /-c model_reasoning_effort=low /);
      assert.match(resolveRoute({ cli: 'codex', model_tier: 'simple', effort: 'high' }).command, /-c model_reasoning_effort=high /);
      assert.match(resolveRoute({ cli: 'pi', model_tier: 'simple' }).command, /--thinking low /);
      assert.match(resolveRoute({ cli: 'droid', model_tier: 'complex', effort: 'medium' }).command, /-r medium /);
      assert.strictEqual(resolveRoute({ cli: 'codex', model_tier: 'simple' }).effort, 'low');
    });

    it('leaves invocations without an {{EFFORT}} placeholder byte-identical', () => {
      assert.strictEqual(
        resolveRoute({ cli: 'opencode', complexity_score: 5 }).command,
        DEFAULT_REGISTRY.opencode.models.simple.invocation
      );
    });

    it('throws on an invalid effort value, listing the allowed set', () => {
      assert.throws(
        () => resolveRoute({ cli: 'codex', model_tier: 'simple', effort: 'turbo' }),
        (err) => {
          assert(err.message.includes('Invalid effort "turbo"'));
          assert(err.message.includes('off, low, medium, high, xhigh'));
          return true;
        }
      );
    });

    it('pi routes the Anthropic spread by tier; expert adds --thinking high', () => {
      assert.match(
        resolveRoute({ cli: 'pi', model_tier: 'simple' }).command,
        /^pi -p --provider anthropic --model claude-haiku-4-5 --thinking low "\$\(cat \.ultraswarm-prompt\.txt\)"$/
      );
      assert.match(
        resolveRoute({ cli: 'pi', model_tier: 'moderate' }).command,
        /--model claude-sonnet-4-6 --thinking low/
      );
      const expert = resolveRoute({ cli: 'pi', complexity_score: 200, effort: 'high' });
      assert.strictEqual(expert.tier, 'expert');
      assert.match(expert.command, /--model claude-opus-4-8 --thinking high/);
    });

    it('pi-local routes Ollama models by tier and aliases its binary to pi', () => {
      assert.match(
        resolveRoute({ cli: 'pi-local', model_tier: 'simple' }).command,
        /^pi -p --provider ollama --model qwen3-coder:7b "\$\(cat \.ultraswarm-prompt\.txt\)"$/
      );
      assert.doesNotMatch(resolveRoute({ cli: 'pi-local', model_tier: 'simple' }).command, /--thinking/);
      assert.strictEqual(DEFAULT_REGISTRY['pi-local'].binary, 'pi');
    });

    it('small-harness simple tier routes to gpt-4o-mini via BACKEND env var with --allow-tools', () => {
      const r = resolveRoute({ cli: 'small-harness', model_tier: 'simple' });
      assert.strictEqual(r.tier, 'simple');
      assert.strictEqual(r.model, 'gpt-4o-mini');
      assert.match(r.command, /^BACKEND=openai AGENT_MODEL=gpt-4o-mini small-harness --allow-tools --print/);
    });

    it('small-harness moderate/complex/expert tiers route to claude models via BACKEND env var', () => {
      const moderate = resolveRoute({ cli: 'small-harness', model_tier: 'moderate' });
      assert.match(moderate.command, /^BACKEND=openrouter AGENT_MODEL=anthropic\/claude-sonnet-4-6 small-harness --allow-tools/);

      const complex = resolveRoute({ cli: 'small-harness', model_tier: 'complex' });
      assert.match(complex.command, /^BACKEND=openrouter AGENT_MODEL=anthropic\/claude-opus-4-8 small-harness --allow-tools/);

      const expert = resolveRoute({ cli: 'small-harness', model_tier: 'expert' });
      assert.match(expert.command, /^BACKEND=openrouter AGENT_MODEL=anthropic\/claude-opus-4-8 small-harness --allow-tools/);
    });

    it('small-harness has its own binary and correct timeoutMs', () => {
      assert.strictEqual(DEFAULT_REGISTRY['small-harness'].binary, 'small-harness');
      assert.strictEqual(DEFAULT_REGISTRY['small-harness'].timeoutMs, 900000);
    });

    it('small-harness invocations do not inject effort flags (no effortFlags defined)', () => {
      // small-harness does not expose a reasoning-effort dial, so {{EFFORT}} is absent
      // and the invocation is passed through byte-identical
      const r = resolveRoute({ cli: 'small-harness', model_tier: 'simple', effort: 'high' });
      assert.strictEqual(r.command, DEFAULT_REGISTRY['small-harness'].models.simple.invocation);
    });

    it('agent simple tier routes with -p --force and composer-2.5-fast', () => {
      const r = resolveRoute({ cli: 'agent', model_tier: 'simple' });
      assert.strictEqual(r.tier, 'simple');
      assert.strictEqual(r.model, 'composer-2.5-fast');
      assert.match(r.command, /^agent -p --force --output-format text --model composer-2.5-fast "\$\(cat \.ultraswarm-prompt\.txt\)"$/);
    });

    it('agent moderate/complex/expert tiers route to expected models', () => {
      const moderate = resolveRoute({ cli: 'agent', model_tier: 'moderate' });
      assert.match(moderate.command, /^agent -p --force --output-format text --model gpt-5.4/);

      const complex = resolveRoute({ cli: 'agent', model_tier: 'complex' });
      assert.match(complex.command, /^agent -p --force --output-format text --model claude-sonnet-4-6/);

      const expert = resolveRoute({ cli: 'agent', model_tier: 'expert' });
      assert.match(expert.command, /^agent -p --force --output-format text --model claude-opus-4-8/);
    });

    it('agent has its own binary and correct timeoutMs', () => {
      assert.strictEqual(DEFAULT_REGISTRY.agent.binary, 'agent');
      assert.strictEqual(DEFAULT_REGISTRY.agent.timeoutMs, 900000);
    });

    it('agent invocations do not inject effort flags (no effortFlags defined)', () => {
      const r = resolveRoute({ cli: 'agent', model_tier: 'simple', effort: 'high' });
      assert.strictEqual(r.command, DEFAULT_REGISTRY.agent.models.simple.invocation);
    });
  });

  describe('validateConfig aliases', () => {
    const goodAlias = {
      'pi-qwen-coder': {
        extends: 'pi',
        specialty: 'local coding',
        maxTier: 'moderate',
        models: { simple: { model: 'qwen3-coder:7b', invocation: 'pi --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"' } },
      },
    };

    it('accepts a well-formed alias and allows it in enabled without warnings', () => {
      const res = validateConfig({ aliases: goodAlias, enabled: ['codex', 'pi-qwen-coder'] });
      assert.equal(res.valid, true);
      assert.deepStrictEqual(res.errors, []);
      assert.equal(res.warnings.some((w) => w.includes('pi-qwen-coder')), false);
    });

    it('does not warn "will be ignored" when overrides target an alias name (overrides apply to aliases)', () => {
      const res = validateConfig({
        aliases: goodAlias,
        overrides: { 'pi-qwen-coder': { timeoutMs: 123000 } },
      });
      assert.equal(res.valid, true);
      assert.equal(res.warnings.some((w) => w.includes('pi-qwen-coder') && w.includes('ignored')), false);
    });

    it('reports alias model errors under the "aliases." scope, not "overrides."', () => {
      const res = validateConfig({ aliases: { 'a-x': { extends: 'pi', models: { moderate: { model: 'm', invocation: 'pi "$(cat .ultraswarm-prompt.txt)"' } } } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('aliases.a-x.models')));
      assert.equal(res.errors.some((e) => e.includes('overrides.a-x.models')), false);
    });

    it('rejects an alias name that collides with a built-in', () => {
      const res = validateConfig({ aliases: { codex: { extends: 'pi', models: goodAlias['pi-qwen-coder'].models } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('codex') && e.includes('built-in')));
    });

    it('rejects extends that targets a non-built-in (and no binary given)', () => {
      const res = validateConfig({ aliases: { 'a-x': { extends: 'nope', models: goodAlias['pi-qwen-coder'].models } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('extends')));
    });

    it('rejects extends that targets another alias (no alias chains)', () => {
      const res = validateConfig({ aliases: {
        'a-1': { extends: 'pi', models: goodAlias['pi-qwen-coder'].models },
        'a-2': { extends: 'a-1', models: goodAlias['pi-qwen-coder'].models },
      } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('a-2') && e.includes('extends')));
    });

    it('rejects models missing the simple anchor', () => {
      const res = validateConfig({ aliases: { 'a-x': { extends: 'pi', models: { moderate: { model: 'm', invocation: 'pi "$(cat .ultraswarm-prompt.txt)"' } } } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('simple')));
    });

    it('rejects an invalid maxTier', () => {
      const res = validateConfig({ aliases: { 'a-x': { extends: 'pi', maxTier: 'huge', models: goodAlias['pi-qwen-coder'].models } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('maxTier')));
    });

    it('rejects an invocation missing the prompt file', () => {
      const res = validateConfig({ aliases: { 'a-x': { extends: 'pi', models: { simple: { model: 'm', invocation: 'pi --model m "hi"' } } } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('.ultraswarm-prompt.txt')));
    });

    it('rejects a non-object aliases value', () => {
      const res = validateConfig({ aliases: ['nope'] });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('aliases must be an object')));
    });

    it('rejects an alias entry that is not an object', () => {
      const res = validateConfig({ aliases: { 'a-x': 42 } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('aliases.a-x') && e.includes('must be an object')));
    });

    it('rejects an alias that sets neither extends nor binary', () => {
      const res = validateConfig({ aliases: { 'a-x': { specialty: 'x', models: goodAlias['pi-qwen-coder'].models } } });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('a-x') && e.includes('extends') && e.includes('binary')));
    });

    it('accepts a self-contained alias defined by its own binary (no extends)', () => {
      const res = validateConfig({ aliases: { 'my-tool': { binary: 'mytool', specialty: 'standalone', models: { simple: { model: 'm', invocation: 'mytool "$(cat .ultraswarm-prompt.txt)"' } } } } });
      assert.equal(res.valid, true);
      assert.deepStrictEqual(res.errors, []);
    });
  });

  describe('DEFAULT_REGISTRY usage descriptors + capability fields', () => {
    it('codex declares its usage descriptor', () => {
      assert.deepStrictEqual(DEFAULT_REGISTRY.codex.usage, [{ input: 'usage.input_tokens', output: 'usage.output_tokens' }]);
    });

    it('opencode declares two usage descriptors (part-nested and top-level)', () => {
      assert.deepStrictEqual(DEFAULT_REGISTRY.opencode.usage, [
        { input: 'part.tokens.input', output: 'part.tokens.output', cost: 'part.cost' },
        { input: 'tokens.input', output: 'tokens.output', cost: 'cost' },
      ]);
    });

    it('gemini declares a wildcard usage descriptor over stats.models', () => {
      assert.deepStrictEqual(DEFAULT_REGISTRY.gemini.usage, [
        { input: 'stats.models.*.tokens.prompt', output: 'stats.models.*.tokens.candidates' },
      ]);
    });

    it('all four gemini invocations pass --output-format json right after --yolo', () => {
      for (const tier of ['simple', 'moderate', 'complex', 'expert']) {
        assert.match(DEFAULT_REGISTRY.gemini.models[tier].invocation, /--yolo --output-format json /);
      }
    });

    it('every built-in carries strengths/structuredOutput/resume matching the old CAPABILITIES map', () => {
      const expected = {
        codex: { strengths: ['backend', 'logic', 'debugging', 'architecture'], structuredOutput: true, resume: true },
        gemini: { strengths: ['frontend', 'ui', 'design'], structuredOutput: false, resume: false },
        grok: { strengths: ['tests', 'refactors', 'general'], structuredOutput: false, resume: false },
        agy: { strengths: ['docs', 'boilerplate', 'automation'], structuredOutput: false, resume: false },
        droid: { strengths: ['full-stack', 'refactors', 'architecture'], structuredOutput: false, resume: false },
        opencode: { strengths: ['boilerplate', 'lint', 'tests', 'docs'], structuredOutput: false, resume: false },
        pi: { strengths: ['general', 'full-stack', 'refactors'], structuredOutput: false, resume: false },
        'pi-local': { strengths: ['general', 'boilerplate', 'docs', 'tests'], structuredOutput: false, resume: false },
        'small-harness': { strengths: ['tool-rich', 'mcp-integration', 'cost-tracking', 'multi-backend', 'local-models'], structuredOutput: false, resume: false },
        agent: { strengths: ['general', 'full-stack', 'refactors', 'debugging', 'tests'], structuredOutput: false, resume: true },
      };
      for (const [cli, fields] of Object.entries(expected)) {
        assert.deepStrictEqual(DEFAULT_REGISTRY[cli].strengths, fields.strengths, `${cli}.strengths`);
        assert.strictEqual(DEFAULT_REGISTRY[cli].structuredOutput, fields.structuredOutput, `${cli}.structuredOutput`);
        assert.strictEqual(DEFAULT_REGISTRY[cli].resume, fields.resume, `${cli}.resume`);
      }
    });
  });

  describe('buildRegistry', () => {
    it('returns DEFAULT_REGISTRY unchanged when no aliases are configured', () => {
      assert.strictEqual(buildRegistry({}), DEFAULT_REGISTRY);
      assert.strictEqual(buildRegistry({ enabled: ['codex'] }), DEFAULT_REGISTRY);
    });

    it('resolves an alias, inheriting binary/timeoutMs/effortFlags from the extends base', () => {
      const reg = buildRegistry({
        aliases: {
          'pi-qwen-coder': {
            extends: 'pi',
            specialty: 'local coding',
            models: { simple: { model: 'qwen3-coder:7b', invocation: 'pi -p --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      });
      const alias = reg['pi-qwen-coder'];
      assert.equal(alias.binary, 'pi');                       // inherited
      assert.equal(alias.timeoutMs, DEFAULT_REGISTRY.pi.timeoutMs); // inherited
      assert.deepStrictEqual(alias.effortFlags, DEFAULT_REGISTRY.pi.effortFlags); // inherited
      assert.equal(alias.specialty, 'local coding');          // overridden
      assert.equal(alias.models.simple.model, 'qwen3-coder:7b'); // owned
    });

    it('does NOT merge model tiers from the base — only the alias-declared tiers exist', () => {
      const reg = buildRegistry({
        aliases: {
          'pi-qwen-coder': {
            extends: 'pi',
            models: { simple: { model: 'qwen3-coder:7b', invocation: 'pi --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      });
      assert.deepStrictEqual(Object.keys(reg['pi-qwen-coder'].models), ['simple']);
      assert.equal(reg['pi-qwen-coder'].models.complex, undefined);
    });

    it('inherits the base specialty when the alias omits one, and carries maxTier through', () => {
      const reg = buildRegistry({
        aliases: {
          'pi-fast': {
            extends: 'pi',
            maxTier: 'moderate',
            models: { simple: { model: 'x', invocation: 'pi --model x "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      });
      assert.equal(reg['pi-fast'].specialty, DEFAULT_REGISTRY.pi.specialty);
      assert.equal(reg['pi-fast'].maxTier, 'moderate');
    });

    it('resolves a self-contained alias (own binary, no extends) and routes it', () => {
      const cfg = { aliases: { 'my-tool': { binary: 'mytool', specialty: 'standalone', models: { simple: { model: 'm', invocation: 'mytool "$(cat .ultraswarm-prompt.txt)"' } } } } };
      const reg = buildRegistry(cfg);
      assert.equal(reg['my-tool'].binary, 'mytool');       // own binary preserved
      assert.equal(reg['my-tool'].specialty, 'standalone');
      assert.equal(reg['my-tool'].extends, undefined);     // no base
      const r = resolveRoute({ cli: 'my-tool', model_tier: 'simple' }, cfg);
      assert.equal(r.model, 'm');
      assert.match(r.command, /mytool/);
    });

    it('inherits usage/strengths/structuredOutput/resume/modelListCmd from the extends base', () => {
      const reg = buildRegistry({
        aliases: {
          'codex-fast': {
            extends: 'codex',
            models: { simple: { model: 'x', invocation: 'codex "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      });
      const alias = reg['codex-fast'];
      assert.deepStrictEqual(alias.usage, DEFAULT_REGISTRY.codex.usage);
      assert.deepStrictEqual(alias.strengths, DEFAULT_REGISTRY.codex.strengths);
      assert.strictEqual(alias.structuredOutput, DEFAULT_REGISTRY.codex.structuredOutput);
      assert.strictEqual(alias.resume, DEFAULT_REGISTRY.codex.resume);
      assert.strictEqual(alias.modelListCmd, undefined);
    });

    it('an alias overrides usage/strengths/structuredOutput/resume/modelListCmd when it sets its own', () => {
      const reg = buildRegistry({
        aliases: {
          'codex-custom': {
            extends: 'codex',
            usage: [{ input: 'my.in', output: 'my.out' }],
            strengths: ['custom'],
            structuredOutput: false,
            resume: false,
            modelListCmd: 'codex models list',
            models: { simple: { model: 'x', invocation: 'codex "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      });
      const alias = reg['codex-custom'];
      assert.deepStrictEqual(alias.usage, [{ input: 'my.in', output: 'my.out' }]);
      assert.deepStrictEqual(alias.strengths, ['custom']);
      assert.strictEqual(alias.structuredOutput, false);
      assert.strictEqual(alias.resume, false);
      assert.strictEqual(alias.modelListCmd, 'codex models list');
    });

    it('returns a frozen registry and leaves DEFAULT_REGISTRY untouched', () => {
      const reg = buildRegistry({
        aliases: { 'pi-x': { extends: 'pi', models: { simple: { model: 'x', invocation: 'pi "$(cat .ultraswarm-prompt.txt)"' } } } },
      });
      assert.ok(Object.isFrozen(reg));
      assert.equal(DEFAULT_REGISTRY['pi-x'], undefined);
    });
  });

  describe('coverage-lift: uncovered branches', () => {
    // getTier — non-finite score falls back to 'simple' (lines 68-70)
    it('resolveRoute: non-numeric complexity_score (NaN) with no model_tier routes to simple tier', () => {
      const r = resolveRoute({ cli: 'grok', complexity_score: NaN });
      assert.strictEqual(r.tier, 'simple');
    });

    it('resolveRoute: undefined complexity_score with no model_tier routes to simple tier', () => {
      const r = resolveRoute({ cli: 'grok', complexity_score: undefined });
      assert.strictEqual(r.tier, 'simple');
    });

    it('resolveRoute: Infinity complexity_score with no model_tier routes to simple tier', () => {
      const r = resolveRoute({ cli: 'grok', complexity_score: Infinity });
      assert.strictEqual(r.tier, 'simple');
    });

    // validateInvocation — non-string value (line 82)
    it('validateConfig: overrides.<cli>.invocation as a number -> error mentioning non-empty string', () => {
      const res = validateConfig({
        overrides: { codex: { invocation: 42 } },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('non-empty string') && e.includes('overrides.codex.invocation')));
    });

    // validateModels — non-object models (lines 90-92)
    it('validateConfig: overrides.<cli>.models as a string -> error mentioning must be an object', () => {
      const res = validateConfig({
        overrides: { codex: { models: 'bad-value' } },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('overrides.codex.models must be an object')));
    });

    it('validateConfig: overrides.<cli>.models as an array -> error mentioning must be an object', () => {
      const res = validateConfig({
        overrides: { codex: { models: ['simple'] } },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('overrides.codex.models must be an object')));
    });

    // validateModels — invalid tier key (lines 98-100)
    it('validateConfig: overrides.<cli>.models with invalid tier key "huge" -> error naming the bad tier', () => {
      const res = validateConfig({
        overrides: {
          codex: {
            models: {
              simple: { model: 'gpt-5.4-mini', invocation: 'codex exec "$(cat .ultraswarm-prompt.txt)"' },
              huge: { model: 'gpt-5.4-ultra', invocation: 'codex exec "$(cat .ultraswarm-prompt.txt)"' },
            },
          },
        },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('invalid tier "huge"')));
    });

    // validateModels — non-string model in a tier entry (lines 102-103)
    it('validateConfig: overrides.<cli>.models.simple.model as a number -> error mentioning non-empty string', () => {
      const res = validateConfig({
        overrides: {
          codex: {
            models: {
              simple: { model: 99, invocation: 'codex exec "$(cat .ultraswarm-prompt.txt)"' },
            },
          },
        },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('overrides.codex.models.simple.model') && e.includes('non-empty string')));
    });

    // validateOverride — unknown CLI warning (lines 110-111)
    it('validateConfig: overrides targeting a truly unknown CLI -> warning "will be ignored"', () => {
      const res = validateConfig({
        overrides: {
          'not-a-real-cli': {
            invocation: 'fake-cmd "$(cat .ultraswarm-prompt.txt)"',
          },
        },
      });
      // The warning is always pushed regardless of the override structure, but here invocation
      // is valid so we get warning only, valid stays true.
      assert.ok(res.warnings.some((w) => w.includes('unknown CLI "not-a-real-cli"') && w.includes('will be ignored')));
    });

    it('validateConfig: unknown CLI override warning is a warning (not an error), config may still be valid', () => {
      const res = validateConfig({
        overrides: {
          'phantom-cli': {
            invocation: 'phantom "$(cat .ultraswarm-prompt.txt)"',
          },
        },
      });
      assert.ok(res.warnings.some((w) => w.includes('phantom-cli') && w.includes('ignored')));
      // Errors only come from structural issues, not unknown CLI name alone
      assert.ok(!res.errors.some((e) => e.includes('phantom-cli')));
    });

    // validateOverride — non-object override (lines 113-115)
    it('validateConfig: overrides.<cli> as a string -> error mentioning must be an object', () => {
      const res = validateConfig({
        overrides: { codex: 'bad-override' },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('overrides.codex must be an object')));
    });

    it('validateConfig: overrides.<cli> as null -> error mentioning must be an object', () => {
      const res = validateConfig({
        overrides: { gemini: null },
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('overrides.gemini must be an object')));
    });

    // mergeCliOverride — false branch: neither global nor project declares models
    it('validateConfig: overrides.<cli> with only timeoutMs (no models block) does not error on models merge', () => {
      const res = validateConfig({
        overrides: { codex: { timeoutMs: 30000 } },
      });
      // No models block means validateModels is not called -> no model errors
      assert.strictEqual(res.valid, true);
      assert.deepStrictEqual(res.errors, []);
    });

    // loadConfig — project config with keys other than 'enabled'/'overrides' are merged (lines 385-387)
    it('loadConfig: project config keys beyond "enabled" and "overrides" (e.g. intelligence) are forwarded to merged config', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cov-'));
      try {
        const gPath = path.join(tmpDir, 'g.json');
        const pPath = path.join(tmpDir, 'p.json');
        fs.writeFileSync(gPath, JSON.stringify({ enabled: ['codex'] }));
        fs.writeFileSync(pPath, JSON.stringify({
          intelligence: { promptAnalysis: { complexityThresholds: { simple: 10, moderate: 30, complex: 60, expert: 90 } } },
          aliases: { 'my-alias': { extends: 'grok', models: { simple: { model: 'g', invocation: 'grok "$(cat .ultraswarm-prompt.txt)"' } } } },
        }));
        const cfg = loadConfig({ globalPath: gPath, projectPath: pPath });
        assert.ok(cfg.intelligence !== undefined, 'intelligence key must be forwarded from project config');
        assert.ok(cfg.aliases !== undefined, 'aliases key must be forwarded from project config');
        assert.strictEqual(cfg.intelligence.promptAnalysis.complexityThresholds.simple, 10);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('resolveRoute with aliases', () => {
    const cfg = {
      aliases: {
        'pi-qwen-coder': {
          extends: 'pi',
          specialty: 'local coding',
          maxTier: 'moderate',
          models: {
            simple: { model: 'qwen3-coder:7b', invocation: 'pi --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"' },
            moderate: { model: 'qwen3-coder:30b', invocation: 'pi --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"' },
          },
        },
      },
    };

    it('routes an explicit alias task to the alias invocation/model', () => {
      const r = resolveRoute({ cli: 'pi-qwen-coder', model_tier: 'simple' }, cfg);
      assert.equal(r.model, 'qwen3-coder:7b');
      assert.match(r.command, /qwen3-coder:7b/);
    });

    it('clamps a tier above maxTier down to maxTier', () => {
      const r = resolveRoute({ cli: 'pi-qwen-coder', model_tier: 'expert' }, cfg);
      assert.equal(r.tier, 'moderate');
      assert.equal(r.model, 'qwen3-coder:30b');
    });

    it('does not clamp a tier at or below maxTier', () => {
      const r = resolveRoute({ cli: 'pi-qwen-coder', model_tier: 'simple' }, cfg);
      assert.equal(r.tier, 'simple');
    });

    it('inherits the base effortFlags for {{EFFORT}} substitution', () => {
      const reg = buildRegistry(cfg);
      assert.deepStrictEqual(reg['pi-qwen-coder'].effortFlags, DEFAULT_REGISTRY.pi.effortFlags);
    });

    it('substitutes the inherited effort flag into an alias invocation {{EFFORT}} slot', () => {
      const effortCfg = {
        aliases: {
          'pi-effort': {
            extends: 'pi',
            models: { simple: { model: 'q', invocation: 'pi {{EFFORT}}--model q "$(cat .ultraswarm-prompt.txt)"' } },
          },
        },
      };
      // default effort is low; pi's effortFlags.low === '--thinking low'
      assert.match(resolveRoute({ cli: 'pi-effort', model_tier: 'simple' }, effortCfg).command, /pi --thinking low --model q /);
      // explicit effort flows through too
      assert.match(resolveRoute({ cli: 'pi-effort', model_tier: 'simple', effort: 'high' }, effortCfg).command, /pi --thinking high --model q /);
    });
  });
});
