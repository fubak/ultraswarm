import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VALID_TIERS = ['simple', 'moderate', 'complex', 'expert'];
const VALID_TIER_SET = new Set(VALID_TIERS);
const VALID_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'];
const VALID_EFFORT_SET = new Set(VALID_EFFORTS);
const DEFAULT_EFFORT = 'low';
const VALID_CLAUDE_MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable']);
const DEFAULT_THRESHOLDS = Object.freeze({ simple: 20, moderate: 50, complex: 100 });

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeDeep(nested);
  }
  return Object.freeze(value);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}`);
  }
}

function mergeCliOverride(globalCli = {}, projectCli = {}) {
  const merged = { ...globalCli, ...projectCli };
  if (globalCli.models || projectCli.models) {
    const tiers = new Set([
      ...Object.keys(globalCli.models ?? {}),
      ...Object.keys(projectCli.models ?? {})
    ]);
    merged.models = Object.fromEntries(
      [...tiers].map((tier) => [
        tier,
        { ...(globalCli.models?.[tier] ?? {}), ...(projectCli.models?.[tier] ?? {}) }
      ])
    );
  }
  return merged;
}

function mergeOverrides(globalOverrides = {}, projectOverrides = {}) {
  const merged = { ...globalOverrides };
  for (const cli of Object.keys(projectOverrides)) {
    merged[cli] = mergeCliOverride(globalOverrides[cli], projectOverrides[cli]);
  }
  return merged;
}

// Only simple/moderate/complex bound a tier; "expert" is the unbounded top tier (anything
// above `complex`). So `complexityThresholds.expert` never affects routing — it exists only
// as the ordering anchor validateIntelligence checks (simple < moderate < complex < expert).
function getTier(score, thresholds) {
  if (!Number.isFinite(score)) {
    return 'simple';
  }
  if (score <= thresholds.simple) {
    return 'simple';
  }
  if (score <= thresholds.moderate) {
    return 'moderate';
  }
  return score <= thresholds.complex ? 'complex' : 'expert';
}

function validateInvocation(value, location, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${location} must be a non-empty string; got ${JSON.stringify(value)}.`);
  } else if (!value.includes('.ultraswarm-prompt.txt')) {
    errors.push(`${location} must include ".ultraswarm-prompt.txt"; got ${JSON.stringify(value)}.`);
  }
}

function validateModels(cli, models, errors) {
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    errors.push(`overrides.${cli}.models must be an object; got ${JSON.stringify(models)}.`);
    return;
  }
  if (!Object.hasOwn(models, 'simple')) {
    errors.push(`overrides.${cli}.models is missing required tier "simple" as the fallback anchor.`);
  }
  for (const [tier, entry] of Object.entries(models)) {
    if (!VALID_TIER_SET.has(tier)) {
      errors.push(`overrides.${cli}.models has invalid tier "${tier}".`);
      continue;
    }
    if (typeof entry?.model !== 'string' || entry.model.trim() === '') {
      errors.push(`overrides.${cli}.models.${tier}.model must be a non-empty string; got ${JSON.stringify(entry?.model)}.`);
    }
    validateInvocation(entry?.invocation, `overrides.${cli}.models.${tier}.invocation`, errors);
  }
}

function validateOverride(cli, override, errors, warnings) {
  if (!Object.hasOwn(DEFAULT_REGISTRY, cli)) {
    warnings.push(`overrides contains unknown CLI "${cli}"; it will be ignored.`);
  }
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    errors.push(`overrides.${cli} must be an object; got ${JSON.stringify(override)}.`);
    return;
  }
  if (Object.hasOwn(override, 'invocation')) {
    validateInvocation(override.invocation, `overrides.${cli}.invocation`, errors);
  }
  if (Object.hasOwn(override, 'models')) {
    validateModels(cli, override.models, errors);
  }
}

function validateIntelligence(config, errors) {
  const thresholds = config.intelligence?.promptAnalysis?.complexityThresholds;
  if (thresholds !== undefined) {
    const values = ['simple', 'moderate', 'complex', 'expert'].map((key) => thresholds?.[key]);
    if (values.some((value) => typeof value !== 'number') || !(values[0] < values[1] && values[1] < values[2] && values[2] < values[3])) {
      errors.push(`intelligence.promptAnalysis.complexityThresholds must satisfy simple < moderate < complex < expert with numeric values; got ${JSON.stringify(thresholds)}.`);
    }
  }
  for (const [key, value] of Object.entries(config.intelligence?.modelRouting?.claudeModels ?? {})) {
    if (!VALID_CLAUDE_MODELS.has(value)) {
      errors.push(`intelligence.modelRouting.claudeModels.${key} must be one of haiku, sonnet, opus, fable; got ${JSON.stringify(value)}.`);
    }
  }
}

/**
 * Deeply frozen registry of supported CLIs and their model tiers.
 */
export const DEFAULT_REGISTRY = freezeDeep({
  codex: {
    specialty: 'backend, logic, algorithms, debugging',
    timeoutMs: 900000,
    effortFlags: { off: '-c model_reasoning_effort=minimal', low: '-c model_reasoning_effort=low', medium: '-c model_reasoning_effort=medium', high: '-c model_reasoning_effort=high', xhigh: '-c model_reasoning_effort=high' },
    models: {
      simple: {
        model: 'gpt-5.4-mini',
        invocation: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.4-mini {{EFFORT}}"$(cat .ultraswarm-prompt.txt)" </dev/null'
      },
      moderate: {
        model: 'gpt-5.4',
        invocation: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.4 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)" </dev/null'
      },
      complex: {
        model: 'gpt-5.5',
        invocation: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.5 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)" </dev/null'
      },
      expert: {
        model: 'gpt-5.5',
        invocation: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.5 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)" </dev/null'
      }
    }
  },
  gemini: {
    specialty: 'frontend, UI, CSS, components',
    timeoutMs: 600000,
    models: {
      simple: {
        model: 'gemini-2.5-flash',
        invocation: 'gemini --yolo -m gemini-2.5-flash -p "$(cat .ultraswarm-prompt.txt)"'
      },
      moderate: {
        model: 'gemini-2.5-pro',
        invocation: 'gemini --yolo -m gemini-2.5-pro -p "$(cat .ultraswarm-prompt.txt)"'
      },
      complex: {
        model: 'gemini-2.5-pro',
        invocation: 'gemini --yolo -m gemini-2.5-pro -p "$(cat .ultraswarm-prompt.txt)"'
      },
      expert: {
        model: 'gemini-2.5-pro',
        invocation: 'gemini --yolo -m gemini-2.5-pro -p "$(cat .ultraswarm-prompt.txt)"'
      }
    }
  },
  grok: {
    specialty: 'tests, refactors, general',
    timeoutMs: 600000,
    models: {
      simple: {
        model: 'grok-build',
        invocation: 'grok --always-approve -m grok-build -p "$(cat .ultraswarm-prompt.txt)"'
      },
      moderate: {
        model: 'grok-build',
        invocation: 'grok --always-approve -m grok-build -p "$(cat .ultraswarm-prompt.txt)"'
      },
      complex: {
        model: 'grok-composer-2.5-fast',
        invocation: 'grok --always-approve -m grok-composer-2.5-fast -p "$(cat .ultraswarm-prompt.txt)"'
      },
      expert: {
        model: 'grok-composer-2.5-fast',
        invocation: 'grok --always-approve -m grok-composer-2.5-fast -p "$(cat .ultraswarm-prompt.txt)"'
      }
    }
  },
  agy: {
    specialty: 'docs, boilerplate, general',
    timeoutMs: 600000,
    models: {
      simple: {
        model: 'gemini-2.5-flash',
        invocation: 'agy --print-timeout 15m --model gemini-2.5-flash --prompt "$(cat .ultraswarm-prompt.txt)"'
      },
      moderate: {
        model: 'gemini-2.5-pro',
        invocation: 'agy --print-timeout 15m --model gemini-2.5-pro --prompt "$(cat .ultraswarm-prompt.txt)"'
      },
      complex: {
        model: 'gemini-2.5-pro',
        invocation: 'agy --print-timeout 15m --model gemini-2.5-pro --prompt "$(cat .ultraswarm-prompt.txt)"'
      },
      expert: {
        model: 'gemini-2.5-pro',
        invocation: 'agy --print-timeout 15m --model gemini-2.5-pro --prompt "$(cat .ultraswarm-prompt.txt)"'
      }
    }
  },
  droid: {
    specialty: 'general full-stack implementation, refactoring',
    timeoutMs: 600000,
    effortFlags: { off: '-r low', low: '-r low', medium: '-r medium', high: '-r high', xhigh: '-r high' },
    models: {
      simple: {
        model: 'claude-haiku-4-5',
        invocation: 'droid exec -m claude-haiku-4-5 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"'
      },
      moderate: {
        model: 'claude-sonnet-4-6',
        invocation: 'droid exec -m claude-sonnet-4-6 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"'
      },
      complex: {
        model: 'claude-opus-4-8',
        invocation: 'droid exec -m claude-opus-4-8 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"'
      },
      expert: {
        model: 'claude-opus-4-8',
        invocation: 'droid exec -m claude-opus-4-8 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"'
      }
    }
  },
  opencode: {
    specialty: 'junior tier: boilerplate, lint/type fixes, simple tests, JSDoc',
    timeoutMs: 600000,
    models: {
      simple: {
        model: 'xai/grok-build-0.1',
        invocation: 'opencode run --agent build -m "xai/grok-build-0.1" "$(cat .ultraswarm-prompt.txt)"'
      },
      moderate: {
        model: 'xai/grok-4.3',
        invocation: 'opencode run --agent build -m "xai/grok-4.3" "$(cat .ultraswarm-prompt.txt)"'
      },
      complex: {
        model: 'google/gemini-3.1-pro-preview',
        invocation: 'opencode run --agent build -m "google/gemini-3.1-pro-preview" "$(cat .ultraswarm-prompt.txt)"'
      },
      expert: {
        model: 'xai/grok-4.20-0309-reasoning',
        invocation: 'opencode run --agent build -m "xai/grok-4.20-0309-reasoning" "$(cat .ultraswarm-prompt.txt)"'
      }
    }
  },
  pi: {
    specialty: 'provider-agnostic generalist, full-stack, refactors',
    timeoutMs: 600000,
    binary: 'pi',
    effortFlags: { off: '--thinking off', low: '--thinking low', medium: '--thinking medium', high: '--thinking high', xhigh: '--thinking xhigh' },
    models: {
      simple: {
        model: 'claude-haiku-4-5',
        invocation: 'pi -p --provider anthropic --model claude-haiku-4-5 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"'
      },
      moderate: {
        model: 'claude-sonnet-4-6',
        invocation: 'pi -p --provider anthropic --model claude-sonnet-4-6 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"'
      },
      complex: {
        model: 'claude-opus-4-8',
        invocation: 'pi -p --provider anthropic --model claude-opus-4-8 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"'
      },
      expert: {
        model: 'claude-opus-4-8',
        invocation: 'pi -p --provider anthropic --model claude-opus-4-8 {{EFFORT}}"$(cat .ultraswarm-prompt.txt)"'
      }
    }
  },
  'pi-local': {
    specialty: 'local/private models via Ollama (offline-capable, lower-stakes work)',
    timeoutMs: 900000,
    binary: 'pi',
    models: {
      simple: {
        model: 'qwen3-coder:7b',
        invocation: 'pi -p --provider ollama --model qwen3-coder:7b "$(cat .ultraswarm-prompt.txt)"'
      },
      moderate: {
        model: 'qwen3-coder:30b',
        invocation: 'pi -p --provider ollama --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"'
      },
      complex: {
        model: 'qwen3-coder:30b',
        invocation: 'pi -p --provider ollama --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"'
      },
      expert: {
        model: 'qwen3-coder:30b',
        invocation: 'pi -p --provider ollama --model qwen3-coder:30b "$(cat .ultraswarm-prompt.txt)"'
      }
    }
  }
});

/**
 * Resolve one alias entry against its `extends` base. Inherits binary, timeoutMs,
 * effortFlags, and specialty (when omitted); the alias OWNS its models map (no per-tier
 * merge with the base) and carries maxTier through. Assumes the alias has already passed
 * validateAliases — buildRegistry never resolves an alias with a bad/missing base.
 */
function resolveAlias(name, alias) {
  const base = DEFAULT_REGISTRY[alias.extends] ?? {};
  return {
    specialty: alias.specialty ?? base.specialty,
    timeoutMs: alias.timeoutMs ?? base.timeoutMs,
    effortFlags: alias.effortFlags ?? base.effortFlags,
    binary: alias.binary ?? base.binary ?? alias.extends ?? name,
    models: alias.models,
    ...(alias.maxTier ? { maxTier: alias.maxTier } : {}),
    extends: alias.extends,
  };
}

/**
 * Effective registry = the frozen built-ins plus the user's resolved aliases.
 * With no aliases, returns DEFAULT_REGISTRY itself (referential identity preserved).
 */
export function buildRegistry(config = {}) {
  const aliases = config?.aliases;
  if (!aliases || typeof aliases !== 'object' || Object.keys(aliases).length === 0) {
    return DEFAULT_REGISTRY;
  }
  const resolved = {};
  for (const [name, alias] of Object.entries(aliases)) {
    resolved[name] = resolveAlias(name, alias);
  }
  return freezeDeep({ ...DEFAULT_REGISTRY, ...resolved });
}

/**
 * Load and merge the optional global and project ultraswarm config files.
 */
export function loadConfig({ globalPath, projectPath } = {}) {
  const resolvedGlobalPath = globalPath ?? path.join(os.homedir(), '.claude', 'ultraswarm.config.json');
  const resolvedProjectPath = projectPath ?? path.resolve('ultraswarm.config.json');
  const globalConfig = readJsonFile(resolvedGlobalPath);
  const projectConfig = readJsonFile(resolvedProjectPath);

  if (!globalConfig && !projectConfig) {
    return {};
  }

  const merged = { ...(globalConfig ?? {}) };
  if (globalConfig?.overrides || projectConfig?.overrides) {
    merged.overrides = mergeOverrides(globalConfig?.overrides, projectConfig?.overrides);
  }
  if (projectConfig && Object.hasOwn(projectConfig, 'enabled')) {
    merged.enabled = projectConfig.enabled;
  }
  for (const [key, value] of Object.entries(projectConfig ?? {})) {
    if (key !== 'enabled' && key !== 'overrides') {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Validate an ultraswarm config object without throwing.
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  const candidate = config && typeof config === 'object' && !Array.isArray(config) ? config : {};

  if (Object.hasOwn(candidate, 'enabled') && (!Array.isArray(candidate.enabled) || candidate.enabled.length === 0)) {
    errors.push('enabled must be a non-empty array; omit enabled to allow all CLIs.');
  }
  for (const cli of Array.isArray(candidate.enabled) ? candidate.enabled : []) {
    if (!Object.hasOwn(DEFAULT_REGISTRY, cli)) {
      warnings.push(`enabled contains unknown CLI "${cli}"; it will be ignored.`);
    }
  }
  for (const [cli, override] of Object.entries(candidate.overrides ?? {})) {
    validateOverride(cli, override, errors, warnings);
  }
  validateIntelligence(candidate, errors);
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Resolve the CLI command and timeout for a task.
 */
export function resolveRoute(task, config = {}) {
  const cli = task?.cli;
  if (!Object.hasOwn(DEFAULT_REGISTRY, cli)) {
    throw new Error(`Unknown cli "${cli}". Allowed values: ${Object.keys(DEFAULT_REGISTRY).join(', ')}.`);
  }
  if (task?.model_tier !== undefined && !VALID_TIER_SET.has(task.model_tier)) {
    throw new Error(`Invalid model_tier ${JSON.stringify(task.model_tier)}. Allowed values: ${VALID_TIERS.join(', ')}.`);
  }
  if (task?.effort !== undefined && !VALID_EFFORT_SET.has(task.effort)) {
    throw new Error(`Invalid effort ${JSON.stringify(task.effort)}. Allowed values: ${VALID_EFFORTS.join(', ')}.`);
  }
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.intelligence?.promptAnalysis?.complexityThresholds ?? {}) };
  const tier = task?.model_tier ?? getTier(task?.complexity_score, thresholds);
  const command = config.overrides?.[cli]?.models?.[tier]?.invocation
    ?? config.overrides?.[cli]?.models?.simple?.invocation
    ?? config.overrides?.[cli]?.invocation
    ?? DEFAULT_REGISTRY[cli].models[tier].invocation;
  const timeoutMs = config.overrides?.[cli]?.timeoutMs ?? DEFAULT_REGISTRY[cli].timeoutMs;
  const model = config.overrides?.[cli]?.models?.[tier]?.model ?? config.overrides?.[cli]?.models?.simple?.model ?? DEFAULT_REGISTRY[cli].models[tier].model;

  const effort = task?.effort ?? DEFAULT_EFFORT;
  const effortFlags = config.overrides?.[cli]?.effortFlags ?? DEFAULT_REGISTRY[cli].effortFlags;
  const effortFragment = effortFlags?.[effort] ?? effortFlags?.[DEFAULT_EFFORT] ?? '';
  const resolvedCommand = command.replace('{{EFFORT}}', effortFragment ? `${effortFragment} ` : '');

  return { cli, tier, model, command: resolvedCommand, timeoutMs, effort };
}
