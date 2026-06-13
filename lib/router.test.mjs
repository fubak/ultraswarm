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
          assert(err.message.includes('codex, gemini, grok, agy, droid, opencode, pi, pi-local'));
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
  });
});
