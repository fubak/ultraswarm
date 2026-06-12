---
name: ultraswarm
description: Advanced orchestration of external AI CLIs with intelligent prompt analysis, dynamic model routing, and ultra-granular task decomposition. Uses optimal models per task complexity and leverages Claude Code's dynamic workflows with sophisticated subagent capabilities. Use when the user invokes /ultraswarm <task> or asks to delegate complex coding jobs with intelligent resource allocation.
---

# Ultraswarm v2 — Intelligent Multi-Model Agent Swarm

**Enhanced Role Contract:** Claude provides intelligent orchestration, prompt analysis, dynamic model routing, and quality assurance. External CLIs execute ultra-granular coding tasks using optimally selected models. Advanced task decomposition reduces token usage while maximizing parallelization.

**Intelligent Capabilities:**
- **Prompt Analysis**: Automatic complexity assessment and model requirement determination
- **Dynamic Model Routing**: Optimal model selection per task difficulty and CLI capabilities  
- **Ultra-Granular Decomposition**: Break tasks into atomic, parallelizable units
- **Adaptive Quality Control**: Multi-tier QA scaling with task complexity
- **Claude Model Optimization**: Use Haiku/Sonnet/Opus appropriately per orchestration phase

**Modes** — dispatch on the invocation argument:
- `/ultraswarm config` (argument is exactly `config`, or the user asks to set up / choose / change which CLIs the swarm uses) → run the **Configuration builder** and stop. Do NOT decompose or run a Workflow.
- `/ultraswarm analyze <task>` → run **Prompt Analysis** only (Phase 0a) to show complexity assessment and recommended model routing
- `/ultraswarm <task>` (anything else) → full intelligent run, starting at Phase 0a.

## Enhanced CLI Worker Registry with Multi-Model Support

The registry now supports **intelligent model selection** per task complexity. Each CLI can use different models based on task difficulty, optimizing cost and performance.

### Base CLI Configurations

| CLI | Base Invocation | Primary Specialty | Models Available (verified 2026-06-10) | Timeout |
|---|---|---|---|---|
| **codex** | Dynamic model selection (see complexity table) | Backend, algorithms, debugging, architecture | gpt-5.4-mini → gpt-5.5 | 5-20 min |
| **opencode** | Multi-model with agent selection | Boilerplate, testing, docs, simple features | xai/grok-build-0.1 → xai/grok-4.20-reasoning (run `opencode models` for the full list) | 5-15 min |
| **gemini** | Google model ecosystem | Frontend, UI, components, design | gemini-2.5-flash → gemini-2.5-pro | 5-15 min |
| **grok** | xAI model family | Tests, refactors, general coding | grok-build → grok-composer-2.5-fast (run `grok models`) | 5-15 min |
| **agy** | Google Antigravity models | Documentation, boilerplate, automation | gemini-2.5-flash → gemini-2.5-pro (via `--model`) | 10-20 min |
| **droid** | Factory AI ecosystem | Full-stack, refactoring, complex logic | claude-haiku-4-5 → claude-opus-4-8 (default: claude-opus-4-8) | 10-20 min |

### Dynamic Model Selection by Complexity

Tier→model mappings come from the config (`overrides.<cli>.models.<tier>`); the rows below are the verified defaults shipped in `ultraswarm.config.advanced.json`. **Model IDs drift** — Phase 0 must re-verify each configured model (e.g. `opencode models`, `grok models`, codex's `~/.codex/models_cache.json`) and drop tiers whose model is rejected, because an invalid model name does NOT fail fast (codex hangs until the wrapper timeout).

| Complexity | Score Range | codex Models | opencode Models | gemini Models | Timeout Multiplier |
|---|---|---|---|---|---|
| **Simple** | 1-20 | gpt-5.4-mini | xai/grok-build-0.1 | gemini-2.5-flash | 1.0x |
| **Moderate** | 21-50 | gpt-5.4 | xai/grok-4.3 | gemini-2.5-pro | 1.5x |
| **Complex** | 51-100 | gpt-5.5 | google/gemini-3.1-pro-preview | gemini-2.5-pro | 2.0x |
| **Expert** | 101+ | gpt-5.5 (reasoning_effort=high) | xai/grok-4.20-0309-reasoning | gemini-2.5-pro | 3.0x |

### Registry Intelligence Features

- **Automatic Model Routing**: Phase 0a analyzes prompt complexity and assigns optimal models
- **CLI Capability Matching**: Tasks routed based on both specialty and model capabilities
- **Cost Optimization**: Simple tasks use efficient models; complex tasks get powerful models
- **Parallel Competition**: High-risk tasks compete across different model tiers
- **Fallback Chains**: Intelligent degradation when preferred models unavailable

**Enhanced Registry Quirks** (updated 2026-06-09):
- Model selection overrides base invocation strings dynamically
- CLI availability checked per model tier during health probe
- Complexity scoring considers context length, logic depth, and domain expertise requirements
- Timeout scaling applied automatically based on selected model tier
- Token usage tracked per model tier for cost analysis

Worktrees: `~/worktrees/<reponame>-us-<taskid>-<cli>`, branch `ultraswarm/<taskid>-<cli>`.

## Advanced Configuration System

Enhanced configuration supports intelligent routing, multi-model selection, and ultra-granular task decomposition.

### Configuration Locations
Two locations, **project overrides global**:
1. **Global default:** `~/.claude/ultraswarm.config.json` — applies to every repo
2. **Project override:** `ultraswarm.config.json` in repo root — overrides global for that project

### Enhanced Schema

```json
{
  "enabled": ["codex", "gemini", "grok", "agy", "droid", "opencode"],
  "intelligence": {
    "promptAnalysis": {
      "enabled": true,
      "complexityThresholds": {
        "simple": 20, "moderate": 50, "complex": 100, "expert": 200
      },
      "taskGranularity": "ultra-fine",
      "maxTaskComplexity": 15
    },
    "modelRouting": {
      "enabled": true,
      "claudeModels": {
        "promptAnalysis": "sonnet", "decomposition": "sonnet",
        "orchestration": "haiku", "codeReview": "sonnet",
        "highRiskQA": "opus", "finalReport": "haiku"
      }
    }
  },
  "overrides": {
    "codex": {
      "models": {
        "simple": { "model": "gpt-5.4-mini", "invocation": "codex exec -s workspace-write --skip-git-repo-check -m gpt-5.4-mini \"$(cat .ultraswarm-prompt.txt)\" </dev/null" },
        "moderate": { "model": "gpt-5.4", "invocation": "..." },
        "complex": { "model": "gpt-5.5", "invocation": "..." },
        "expert": { "model": "gpt-5.5", "invocation": "..." }
      }
    }
  },
  "taskStrategies": {
    "decomposition": {
      "strategy": "ultra-granular",
      "maxComplexityPerTask": 15,
      "preferredTaskSize": "atomic",
      "dependencies": "minimal",
      "parallelization": "aggressive"
    }
  }
}
```

### Configuration Fields

**Intelligence Settings:**
- `promptAnalysis.enabled` — Enable complexity analysis and model routing
- `complexityThresholds` — Scoring boundaries for model selection  
- `taskGranularity` — Task decomposition strategy: `standard`, `fine`, `ultra-fine`
- `claudeModels` — Which Claude model to use per orchestration phase (`haiku`, `sonnet`, `opus`, `fable`)
- `maxIntelligence` — Opt-in (default false). Flips the ceiling slots — the always-on security adversarial lens and the expert-escalation review — and expert-tier decomposition from Opus to Fable. Fable is ≈30% more tokens (tokenizer) + premium price, so leave it off unless the work is safety-critical.

**Multi-Model Overrides:**
- `models.<complexity>` — Per-complexity model configuration for each CLI
- `model` — Model identifier for the CLI
- `invocation` — Command template with model parameter

**Task Strategy:**
- `decomposition.strategy` — How granular to make task breakdown
- `maxComplexityPerTask` — Upper bound on individual task complexity
- `parallelization` — Task independence optimization: `conservative`, `balanced`, `aggressive`

### Intelligent Merge Rules

1. **Global → Project:** Project config completely replaces global for each top-level key
2. **Model Selection:** CLI model tiers merge (project can override specific complexity levels)
3. **Intelligence:** Project intelligence settings override global completely
4. **Validation:** Complex schemas validated at load time with helpful error messages

### Enhanced Configuration Builder (`/ultraswarm config`)

Advanced interactive configuration builder supporting intelligence features and multi-model selection. Run when invoked as `/ultraswarm config`.

1. **Comprehensive CLI Discovery & Model Probing**:
   - Test basic availability: `command -v <cli>` and `<cli> --version`
   - **Model availability check**: For CLIs supporting model selection:
     - `opencode models` → list available models
     - `codex models` → check GPT model access
     - `gemini models` → verify Gemini model access
   - **Performance probe**: Optional quick test of model response time
   - **Auth verification**: Check for required subscriptions (droid, etc.)

2. **Enhanced Status Table**:
   ```
   CLI      | Installed | Models Available              | Auth Status | Current Config
   codex    | ✅ v2.1   | gpt-5.4-mini, gpt-5.4, gpt-5.5  | ✅ API key  | enabled
   opencode | ✅ v1.3   | 12 models across 4 providers  | ✅ keys     | disabled
   gemini   | ❌        | —                             | —           | —
   ```

3. **Multi-Stage Configuration**:

   **Stage 1 — CLI Selection:**
   Use AskUserQuestion with `multiSelect: true` for basic CLI enablement.

   **Stage 2 — Intelligence Settings:**
   ```
   Enable intelligent features?
   ○ Basic (legacy mode) 
   ● Standard (complexity analysis + model routing)
   ○ Advanced (ultra-granular + adaptive QA)
   ○ Expert (full intelligence + competition)
   ```

   **Stage 3 — Model Configuration (if applicable):**
   For each enabled CLI with model options, show complexity tier mapping:
   ```
   opencode model selection:
   Simple tasks    → xai/grok-build-0.1     (fast, cheap)
   Moderate tasks  → xai/grok-4.3           (balanced)
   Complex tasks   → google/gemini-3.1-pro-preview (powerful)
   Expert tasks    → anthropic/claude-sonnet (expert reasoning)
   ```

   **Stage 4 — Task Strategy:**
   ```
   Task decomposition strategy:
   ○ Standard (3-8 tasks, moderate complexity)
   ● Ultra-granular (8-20 tasks, low complexity each)
   ○ Balanced (5-12 tasks, adaptive complexity)
   ```

4. **Configuration Scope & Advanced Options**:
   - Choose global vs project config location
   - Enable experimental features (dependency coordination, etc.)
   - Set complexity thresholds and timeout scaling
   - Configure Claude model preferences per orchestration phase

5. **Validation & Preview**:
   - Show generated JSON structure before writing
   - Validate model availability and auth status
   - Estimate token cost impact of configuration choices
   - Warn about potential issues (< 2 CLIs, missing auth, etc.)

6. **Write Enhanced Configuration**:
   ```json
   {
     "enabled": [...],
     "intelligence": {
       "promptAnalysis": { "enabled": true, "complexityThresholds": {...} },
       "modelRouting": { "enabled": true, "claudeModels": {...} }
     },
     "overrides": {
       "cli": { "models": { "complexity_tier": { "model": "...", "invocation": "..." } } }
     },
     "taskStrategies": {...}
   }
   ```

7. **Post-Configuration Verification**:
   - Test write-probe each enabled CLI with selected models
   - Verify intelligence features work with current Claude Code version
   - Provide getting-started guidance based on configuration choices

## Phase 0a — Intelligent Prompt Analysis (inline, pre-decomposition)

**Run this analysis on a strong model — this is the one place to spend, not save.** Complexity assessment and the decomposition that follows are the highest-leverage reasoning in the whole run; a bad split wastes far more downstream (wasted external-CLI runs + QA cycles) than the analysis itself costs. It runs inline on the session model (typically Opus); `intelligence.modelRouting.promptAnalysis` records the intended tier. **Opt-in ceiling:** when `intelligence.maxIntelligence` is set, dispatch Phase 0a/0 for expert-tier or very-large tasks to a Fable subagent (`Agent({ model: 'fable' })`) for the deepest decomposition — but Fable costs ≈30% more tokens (its tokenizer) plus premium pricing, so reserve it for genuinely hard decompositions only, never the default path.

1. **Complexity Assessment**: Analyze the incoming task to determine:
   - **Domain complexity**: Technical depth required (1-10 scale)
   - **Logic complexity**: Algorithmic thinking needed (1-10 scale)  
   - **Context complexity**: Amount of codebase context required (1-10 scale)
   - **Interface complexity**: API/UI interaction complexity (1-10 scale)
   - **Risk complexity**: Security, data, or architectural impact (1-10 scale)
   - **Overall complexity score**: Weighted sum determining model tier selection

2. **Task Decomposition Preview**: Predict optimal granularity:
   - Estimate number of atomic subtasks
   - Identify dependency chains and parallelization opportunities
   - Flag potential bottlenecks or coordination points
   - Calculate expected token budget per subtask

3. **Model Requirement Analysis**: For each CLI type, determine:
   - Optimal model tier per anticipated task complexity
   - Expected token usage per model tier
   - Cost optimization opportunities
   - Risk factors requiring model upgrades

4. **Intelligent Routing Strategy**: Generate routing plan:
   - CLI-to-complexity mapping for efficient resource utilization
   - Competition strategies for high-risk components
   - Fallback plans for model unavailability
   - Parallelization vs coordination tradeoffs

5. **Quality Assurance Planning**: Determine QA strategy:
   - Which tasks need multi-reviewer competition
   - Adversarial testing requirements
   - Integration testing complexity
   - Review model requirements (Haiku vs Sonnet vs Opus)

**Output**: Complexity assessment report with recommended decomposition strategy and model routing plan. For `/ultraswarm analyze <task>`, stop here and present the analysis. For normal runs, proceed to Phase 0.

## Phase 0 — Enhanced Decomposition (inline, using analysis from 0a)

1. **Load enhanced config & intelligent health-check.** Read config with new schema (global `~/.claude/ultraswarm.config.json`, then project overriding). Parse intelligence settings, model routing configuration, and task strategy parameters. For each CLI candidate:
   - Run basic health check: `<cli> --version`
   - **Enhanced write probe**: Test each complexity tier model if configured
   - **Model availability check**: Verify configured models are accessible (e.g., `opencode models` to check availability)
   - Build dynamic registry mapping complexity tiers to available models per CLI
   - Apply timeout scaling based on model complexity tiers

2. **Repository analysis with intelligence.** **Use Sonnet for deep analysis**:
   - Analyze codebase structure, conventions, architectural patterns
   - Detect gate commands and estimate execution time complexity
   - Identify domain-specific patterns (auth, data, UI, API, testing)
   - Map dependencies between modules/components
   - Assess testing coverage and quality patterns

3. **Ultra-granular decomposition** using Phase 0a analysis:
   - Break work into atomic tasks with complexity score ≤ configured `maxComplexityPerTask` (default 15)
   - Each task: `{id, description, files, cli, model_tier, complexity_score, risk, dependencies, acceptance, prompt}`
   - **Model tier assignment**: Route tasks to appropriate complexity tier based on analysis
   - **Dependency waves**: Compute topological levels over the `dependencies` edges — wave 1 = tasks with no dependencies, wave N = tasks whose dependencies all sit in earlier waves. A dependency cycle is a decomposition error: stop and re-split the tasks. Tasks within one wave MUST be mutually independent — each wave becomes its own Workflow launch (see "Dependency waves — chaining Workflows" below), because all worktrees in a Workflow branch from the same base SHA, so work from a co-launched predecessor is invisible to its dependents (e2e-verified 2026-06-10).
   - **Parallelization optimization**: Identify truly independent task clusters *within* each wave
   - **Risk stratification**: Enhanced risk assessment using multiple factors

4. **Intelligent task routing**:
   - Primary routing by CLI specialty AND model capability
   - Secondary considerations: complexity score, context requirements, token budget
   - Competition assignments for high-risk tasks
   - Fallback chains considering model availability
   - Load balancing across available CLIs

5. **Enhanced gate verification**: 
   - Run all gates on base tree and benchmark execution time
   - Test compatibility with selected model outputs
   - Estimate gate execution cost for token budget planning

6. **Present intelligent task plan with model routing table.** Show:
   - Task breakdown with complexity scores and model assignments
   - Estimated token usage per CLI and model tier
   - Dependency waves and the parallelization plan within each wave
   - Risk assessment and competition strategy
   - Get explicit user confirmation before the first Workflow launch (one confirmation covers the whole wave chain)

## Dependency waves — chaining Workflows

A single Workflow invocation handles ONE wave of mutually independent tasks. Dependent tasks run in later waves, each in its own Workflow, re-based on the merged result of the wave before it. The execution loop (inline, orchestrator Claude):

1. `baseSha` ← current HEAD (captured at Phase 0).
2. For each wave in order:
   a. Launch the Workflow template with `tasks` = this wave's tasks and `baseBranch` = `baseSha`. Tasks in the wave run in parallel inside the Workflow as usual.
   b. When it returns, run **Phase 3 merge** for that wave's approved results (sequential, gate after each merge).
   c. `baseSha` ← new HEAD. Worktrees for the next wave now fork from a base that contains every merged predecessor.
3. After the last wave, run Phase 4 once for the whole chain (aggregate the per-wave token accounting).

**Blocked dependents — fail loud, never run blind:** if a task tombstones (or its merge is reverted) and a later-wave task depends on it, do NOT launch the dependent against a base missing its prerequisite. Mark it `blocked (dependency <id> failed)`, skip it, and list it in the Phase 4 report alongside the failed tasks. The user decides whether to re-run the chain after fixing the blocker.

**Why not one Workflow with sequenced clusters:** every worktree branches from the Workflow's single `baseBranch`; QA-approved work lands on per-task branches but is only merged to the real branch by Claude in Phase 3, *after* the Workflow returns. Sequencing clusters inside one Workflow orders execution but cannot re-base dependents — they would build against a tree where their prerequisites don't exist. The Workflow script enforces this with a fail-fast guard (it refuses a `tasks` list containing intra-invocation dependency edges).

## Phases 1–2 — Enhanced Workflow Script Template

Author this per-invocation with intelligent model routing and ultra-granular task management. Pass real values via `args`, never hardcode into the script body:

```js
export const meta = {
  name: 'ultraswarm-intelligent-run',
  description: 'Intelligent external CLI orchestration with dynamic model routing and ultra-granular tasks',
  phases: [
    { title: 'Implement', detail: 'external CLIs with optimal models code in isolated worktrees', model: 'haiku' },
    { title: 'QA', detail: 'adaptive QA: routine → sonnet review, complex → opus adversarial', model: 'sonnet' },
    { title: 'Coordination', detail: 'dependency resolution and task sequencing', model: 'haiku' },
  ],
}
// Enhanced configuration parsing with intelligent routing support
const cfg = typeof args === 'string' ? JSON.parse(args) : args
// cfg: {
//   repo: '/abs/path', repoName: 'name',
//   baseBranch: 'main',
//   worktreeRoot: '/home/<user>/worktrees',
//   gates: [{name:'build',cmd:'npm run build',expectedDuration:30000}, ...],
//   
//   // Enhanced registry with multi-model support
//   registry: { 
//     codex: { 
//       simple: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.4-mini "$(cat .ultraswarm-prompt.txt)" </dev/null',
//       moderate: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.4 "$(cat .ultraswarm-prompt.txt)" </dev/null',
//       complex: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.5 "$(cat .ultraswarm-prompt.txt)" </dev/null',
//       expert: 'codex exec -s workspace-write --skip-git-repo-check -m gpt-5.5 "$(cat .ultraswarm-prompt.txt)" </dev/null'
//     }, ... 
//   },
//   
//   // Intelligence configuration  
//   intelligence: {
//     taskGranularity: 'ultra-fine',
//     maxComplexityPerTask: 15,
//     modelRouting: { enabled: true, claudeModels: {...} },
//     adaptiveQA: true
//   },
//   
//   // Enhanced task structure
//   tasks: [{ 
//     id, description, files:[], cli, model_tier, complexity_score, 
//     risk, dependencies:[], acceptance, prompt, estimated_tokens 
//   }],
//   
//   // Optional grouping of tasks WITHIN this wave (all mutually independent — the
//   // script throws if any task depends on another task in the same invocation;
//   // dependency chains are split across chained Workflow runs by Phase 0)
//   taskGraph: { dependencies: {}, independent_clusters: [[]], critical_path: [] },
//   
//   // Resource management
//   timeoutMs: 600000,
//   timeouts: { 'codex-expert': 1800000, 'codex-complex': 1200000, ... },
//   alternates: { 'codex-complex': 'droid-complex', ... }
// }

// Enhanced schemas with intelligence tracking
const IMPL_SCHEMA = { type:'object', properties:{
  status:{type:'string',enum:['ok','cli_failed','gates_failed','timeout','model_unavailable','complexity_exceeded']},
  worktree:{type:'string'}, branch:{type:'string'},
  files_changed:{type:'array',items:{type:'string'}},
  gate_results:{type:'array',items:{type:'object',properties:{name:{type:'string'},pass:{type:'boolean'},detail:{type:'string'},duration:{type:'number'}},required:['name','pass']}},
  summary:{type:'string'}, concerns:{type:'array',items:{type:'string'}},
  cli_tokens:{type:'number'}, model_used:{type:'string'}, complexity_achieved:{type:'number'},
  performance_metrics:{type:'object',properties:{execution_time:{type:'number'},memory_peak:{type:'number'},quality_indicators:{type:'object'}}}
}, required:['status','worktree','branch','files_changed','gate_results','summary','concerns','cli_tokens','model_used','complexity_achieved'] }

const ENHANCED_REVIEW_SCHEMA = { type:'object', properties:{ 
  approve:{type:'boolean'}, issues:{type:'array',items:{type:'string'}},
  quality_score:{type:'number'}, complexity_assessment:{type:'number'},
  recommendations:{type:'array',items:{type:'string'}}, requires_expert_review:{type:'boolean'}
}, required:['approve','issues','quality_score','complexity_assessment'] }

const ADAPTIVE_JUDGE_SCHEMA = { type:'object', properties:{ 
  score:{type:'number'}, rationale:{type:'string'}, graft_ideas:{type:'array',items:{type:'string'}},
  complexity_handling:{type:'number'}, model_efficiency:{type:'number'}, code_quality:{type:'number'}
}, required:['score','rationale','graft_ideas','complexity_handling','model_efficiency','code_quality'] }

const EXPERT_VERDICT_SCHEMA = { type:'object', properties:{ 
  refuted:{type:'boolean'}, reasons:{type:'array',items:{type:'string'}},
  confidence:{type:'number'}, severity:{type:'string',enum:['low','medium','high','critical']},
  alternative_approach:{type:'string'}
}, required:['refuted','reasons','confidence','severity'] }

// Enhanced helper functions with intelligent routing
const wt = (t, cli) => `${cfg.worktreeRoot}/${cfg.repoName}-us-${t.id}-${cli}`
const br = (t, cli) => `ultraswarm/${t.id}-${cli}`
const gateList = cfg.gates.map(g => `${g.name}: ${g.cmd}${g.expectedDuration ? ` (expected: ${g.expectedDuration}ms)` : ''}`).join('\n   ')

// Dynamic model selection based on task complexity
const getCliCommand = (t, cli) => {
  const validCli = validateCliName(cli)
  const modelTier = validateModelTier(t.model_tier || 'simple')
  const cliRegistry = cfg.registry[validCli]
  
  if (!cliRegistry) {
    throw new Error(`CLI ${validCli} not found in registry`)
  }
  
  if (typeof cliRegistry === 'string') {
    return cliRegistry // Legacy single-model CLI
  }
  
  const command = cliRegistry[modelTier] || cliRegistry['simple'] || cliRegistry
  if (!command) {
    throw new Error(`No command found for CLI ${validCli} with tier ${modelTier}`)
  }
  
  return command
}

const getTimeout = (t, cli) => {
  const validCli = validateCliName(cli)
  const modelTier = validateModelTier(t.model_tier || 'simple')
  const cliKey = `${validCli}-${modelTier}`
  return cfg.timeouts?.[cliKey] ?? cfg.timeouts?.[validCli] ?? cfg.timeoutMs
}

const enhancedImplPrompt = (t, cli, attempt, feedback) => `You are a WRAPPER around the external CLI "${cli}". You do NOT write feature code — only run the CLI and report. Task ${t.id} (${t.model_tier} tier, attempt ${attempt}).

1. Worktree (create, or reuse if it exists):
   cd ${cfg.repo} && git worktree add ${wt(t,cli)} -b ${br(t,cli)} ${cfg.baseBranch}

2. Write ${wt(t,cli)}/.ultraswarm-prompt.txt with this self-contained task for the CLI:
---PROMPT START---
${t.description}
Files to modify: ${JSON.stringify(t.files)}

${t.prompt}${feedback.length ? `

FIX ALL of these issues from prior attempts:
${feedback.map((f, i) => `${i+1}. ${f}`).join('\n')}` : ''}
---PROMPT END---

3. Run the CLI (timeout ${getTimeout(t, cli)}ms):
   cd ${wt(t,cli)} && ${getCliCommand(t, cli)}

4. Run the gates in the worktree:
   ${gateList}

5. Housekeeping + commit:
   rm ${wt(t,cli)}/.ultraswarm-prompt.txt
   cd ${wt(t,cli)} && git add -A && git commit -m "ultraswarm: ${t.id}/${t.model_tier} attempt ${attempt}"

6. Return the IMPL schema: status, worktree, branch, files_changed, gate_results, summary,
   concerns (scope creep / pattern deviations), cli_tokens and model_used parsed from the CLI
   output (0 / "default" when absent), complexity_achieved (your estimate vs ${t.complexity_score}/100 target).`

// Enhanced QA prompts with intelligence and adaptive depth
const adaptiveReviewPrompt = (t, impl) => `INTELLIGENT CODE REVIEW — Adaptive depth based on complexity score ${t.complexity_score}/100.

ANALYSIS TARGET:
cd ${impl.worktree} && git diff ${cfg.baseBranch}...${impl.branch}
Task: ${t.description} · Complexity: ${t.complexity_score}/100 · Model: ${impl.model_used}

REVIEW CRITERIA (adaptive based on complexity):
${t.complexity_score <= 20 ? 'SIMPLE TASK REVIEW:' : t.complexity_score <= 50 ? 'MODERATE TASK REVIEW:' : 'COMPLEX TASK REVIEW:'}

CORE CHECKS (all complexity levels):
1. Acceptance criteria met (not just plausible)
2. Project convention conformance
3. No scope creep beyond ${JSON.stringify(t.files)}
4. Error handling appropriate for complexity level
5. Tests verify intent vs hardcoded outputs

${t.complexity_score > 20 ? `
MODERATE+ ADDITIONAL CHECKS:
6. Code maintainability and readability
7. Performance considerations
8. Integration implications
9. Security implications for data/interfaces` : ''}

${t.complexity_score > 50 ? `
COMPLEX ADDITIONAL CHECKS:
10. Architectural impact assessment
11. Scalability considerations  
12. Dependency management quality
13. Error propagation patterns
14. Testing depth and coverage` : ''}

Provide quality_score (0-100), complexity_assessment (actual complexity achieved), and flag requires_expert_review for borderline cases.`

const intelligentJudgePrompt = (t, impl) => `INTELLIGENT IMPLEMENTATION SCORING — Multi-dimensional analysis for task ${t.id}.

COMPARISON TARGET:
cd ${impl.worktree} && git diff ${cfg.baseBranch}...${impl.branch}
Task: ${t.description} · Target Complexity: ${t.complexity_score}/100 · Model: ${impl.model_used}

SCORING DIMENSIONS:
1. Correctness (40%): Does it solve the stated problem completely?
2. Model Efficiency (25%): Appropriate model usage for complexity level?
3. Code Quality (20%): Readability, maintainability, patterns
4. Complexity Handling (15%): How well does it manage stated complexity?

ANALYSIS REQUIREMENTS:
- Compare achieved vs target complexity (${t.complexity_score}/100)
- Assess model tier appropriateness (was ${t.model_tier} suitable?)
- Identify transferable techniques (graft_ideas) 
- Rate performance vs resource usage

Return enhanced metrics: overall score, per-dimension scores, and actionable graft ideas.`

const expertLensPrompt = (lens, t, impl) => `EXPERT ADVERSARIAL ANALYSIS — ${lens} lens with confidence scoring.

ANALYSIS TARGET:
cd ${impl.worktree} && git diff ${cfg.baseBranch}...${impl.branch}
Task: ${t.description} · Complexity: ${t.complexity_score}/100 · Model: ${impl.model_used}

${lens === 'correctness' ? `CORRECTNESS LENS — Logic, edge cases, unmet acceptance criteria:
- Run actual tests to verify functionality
- Check edge case handling appropriate for complexity level
- Validate acceptance criteria satisfaction
- Look for logic errors or incomplete implementations` : ''}

${lens === 'security' ? `SECURITY LENS — Vulnerabilities, data exposure, injection risks:
- Check for hardcoded secrets or credentials
- Validate input sanitization and validation
- Assess authentication/authorization implications  
- Look for potential injection vectors or data leaks` : ''}

${lens === 'regression' ? `REGRESSION LENS — Breaking changes, compatibility, existing behavior:
- Run existing test suite to check for breaks
- Validate backward compatibility if applicable
- Check for unintended side effects
- Verify integration points still work` : ''}

VERDICT POLARITY — read carefully:
- Set refuted=true ONLY if you found a concrete, demonstrable problem with the work. The reasons array must then describe the PROBLEMS you found, nothing else.
- If the work survives your scrutiny, set refuted=false (reasons may briefly note what you verified).
- severity describes the worst PROBLEM found; with refuted=false use severity "low".
Provide confidence (0-100) in your verdict, and suggest alternative_approach only when refuted=true.`

const EXPERT_LENSES = ['correctness', 'security', 'regression']
const ALLOWED_CLIS = ['codex', 'gemini', 'grok', 'agy', 'droid', 'opencode']
const VALID_MODEL_TIERS = ['simple', 'moderate', 'complex', 'expert']
const VALID_CLAUDE_MODELS = ['haiku', 'sonnet', 'opus', 'fable']

// Input validation functions
function validateCliName(cli) {
  if (!cli || typeof cli !== 'string') {
    throw new Error('CLI name must be a non-empty string')
  }
  if (!ALLOWED_CLIS.includes(cli)) {
    throw new Error(`Invalid CLI name: ${cli}. Allowed: ${ALLOWED_CLIS.join(', ')}`)
  }
  return cli
}

function validateModelTier(tier) {
  if (!tier || typeof tier !== 'string') {
    throw new Error('Model tier must be a non-empty string')
  }
  if (!VALID_MODEL_TIERS.includes(tier)) {
    throw new Error(`Invalid model tier: ${tier}. Allowed: ${VALID_MODEL_TIERS.join(', ')}`)
  }
  return tier
}

function validateClaudeModel(model) {
  if (!model || typeof model !== 'string') {
    throw new Error('Claude model must be a non-empty string')
  }
  if (!VALID_CLAUDE_MODELS.includes(model)) {
    throw new Error(`Invalid Claude model: ${model}. Allowed: ${VALID_CLAUDE_MODELS.join(', ')}`)
  }
  return model
}

function sanitizeTaskId(id) {
  if (!id || typeof id !== 'string') {
    throw new Error('Task ID must be a non-empty string')
  }
  // Remove any potentially dangerous characters
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

// Enhanced tracking with intelligence metrics
let externalTokens = 0, tokenAttempts = 0, tokenCaptured = 0
let complexityMetrics = { planned: 0, achieved: 0, efficiency: 0 }
let modelUsage = {}  // Track which models were actually used vs planned

// Intelligent implementation with dynamic model routing
async function intelligentImplement(t, cli, attempt, feedback) {
  try {
    // Validate inputs
    const validCli = validateCliName(cli)
    const validTaskId = sanitizeTaskId(t.id)
    const modelTier = validateModelTier(t.model_tier || 'simple')
    
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error('Attempt must be a positive integer')
    }
    
    const command = getCliCommand(t, validCli)
    const expectedModel = command.includes('-m ') ? 
      command.match(/-m ["']?([^"'\s]+)["']?/)?.[1] : 'default'
    
    // Use Haiku for implementation orchestration (cost-efficient)
    const r = await agent(enhancedImplPrompt(t, validCli, attempt, feedback), { 
      label: `impl:${validTaskId}:${validCli}:${modelTier}#${attempt}`, 
      phase: 'Implement', 
      schema: IMPL_SCHEMA,
      model: validateClaudeModel('haiku')
    })
    
    if (r) {
      tokenAttempts += 1
      const tokens = typeof r.cli_tokens === 'number' ? r.cli_tokens : 0
      externalTokens += tokens
      if (tokens > 0) tokenCaptured += 1
      
      // Track intelligence metrics
      complexityMetrics.planned += (t.complexity_score || 0)
      complexityMetrics.achieved += (r.complexity_achieved || t.complexity_score || 0)
      
      const actualModel = r.model_used || expectedModel
      modelUsage[actualModel] = (modelUsage[actualModel] || 0) + 1
    }
    
    return r
  } catch (error) {
    log(`Implementation failed for ${t.id}: ${error.message}`)
    return { 
      status: 'cli_failed', 
      worktree: '', 
      branch: '', 
      files_changed: [], 
      gate_results: [], 
      summary: `Implementation error: ${error.message}`, 
      concerns: ['validation_failed'], 
      cli_tokens: 0, 
      model_used: 'none', 
      complexity_achieved: 0 
    }
  }
}

// Constants for QA thresholds
const QA_CONFIDENCE_THRESHOLD = 60
const SIMPLE_COMPLEXITY_THRESHOLD = 30
const EXPERT_COMPLEXITY_THRESHOLD = 50

// Simple task QA: fast review with Haiku
async function runSimpleQA(t, impl) {
  try {
    const r = await agent(adaptiveReviewPrompt(t, impl), { 
      label: `review:${t.id}:simple`, 
      phase: 'QA', 
      schema: ENHANCED_REVIEW_SCHEMA,
      model: 'haiku'
    })
    return r ? { approve: r.approve, issues: r.issues } : { approve: false, issues: ['reviewer agent died'] }
  } catch (error) {
    return { approve: false, issues: [`QA error: ${error.message}`] }
  }
}

// Moderate task QA: thorough review with potential expert escalation
async function runModerateQA(t, impl) {
  try {
    const useExpertReview = t.complexity_score > EXPERT_COMPLEXITY_THRESHOLD || t.risk === 'high'
    const reviewModel = useExpertReview ? 'sonnet' : 'haiku'
    
    const r = await agent(adaptiveReviewPrompt(t, impl), { 
      label: `review:${t.id}:moderate`, 
      phase: 'QA', 
      schema: ENHANCED_REVIEW_SCHEMA,
      model: reviewModel
    })
    
    if (r?.requires_expert_review) {
      return await runExpertEscalation(t, impl)
    }
    
    return r ? { approve: r.approve, issues: r.issues } : { approve: false, issues: ['reviewer agent died'] }
  } catch (error) {
    return { approve: false, issues: [`QA error: ${error.message}`] }
  }
}

// Expert escalation QA: detailed analysis on the ceiling model (Opus, or Fable when maxIntelligence is opted in)
async function runExpertEscalation(t, impl) {
  try {
    const ceiling = cfg.intelligence?.maxIntelligence ? 'fable' : 'opus'
    const expert = await agent(adaptiveReviewPrompt(t, impl) + '\n\nEXPERT ESCALATION: Provide detailed analysis for complex edge cases.', { 
      label: `review:${t.id}:expert`, 
      phase: 'QA', 
      schema: ENHANCED_REVIEW_SCHEMA,
      model: ceiling
    })
    return expert ? { approve: expert.approve, issues: expert.issues } : { approve: false, issues: ['expert review failed'] }
  } catch (error) {
    return { approve: false, issues: [`Expert QA error: ${error.message}`] }
  }
}

// High-risk adversarial QA: multi-lens expert review, FrugalGPT-style cascade.
// security is the asymmetric-risk lens → always the ceiling model. correctness/regression
// start on sonnet and escalate to the ceiling model only when they refute or return
// borderline confidence — observe the verdict, escalate on doubt, instead of paying the
// ceiling model on every lens up front.
const LENS_BORDERLINE = 75
async function runAdversarialQA(t, impl) {
  try {
    // ceiling = opus by default; fable only when maxIntelligence is opted in (see runExpertEscalation)
    const ceiling = cfg.intelligence?.maxIntelligence ? 'fable' : 'opus'
    const firstModel = lens => lens === 'security' ? ceiling : 'sonnet'

    // First pass: security on the ceiling model, the rest on sonnet, all in parallel.
    const firstPass = (await parallel(EXPERT_LENSES.map(lens => () =>
      agent(expertLensPrompt(lens, t, impl), {
        label: `verify:${t.id}:${lens}`,
        phase: 'QA',
        schema: EXPERT_VERDICT_SCHEMA,
        model: firstModel(lens)
      }).then(v => v && { lens, v })))).filter(Boolean)

    // Escalate any sonnet lens that refuted or is borderline to the ceiling model for a
    // final verdict; keep the sonnet verdict if the escalated agent dies.
    const votes = (await parallel(firstPass.map(({ lens, v }) => async () => {
      if (firstModel(lens) === ceiling) return v
      if (!v.refuted && v.confidence >= LENS_BORDERLINE) return v
      const escalated = await agent(expertLensPrompt(lens, t, impl), {
        label: `verify:${t.id}:${lens}:${ceiling}`,
        phase: 'QA',
        schema: EXPERT_VERDICT_SCHEMA,
        model: ceiling
      })
      return escalated || v
    }))).filter(Boolean)

    // Quorum guard: a high-risk task must never pass without at least 2 lens votes
    if (votes.length < 2) {
      return { approve: false, issues: [`adversarial verification could not complete (${votes.length}/${EXPERT_LENSES.length} lens agents responded)`] }
    }
    
    const weightedScore = votes.reduce((sum, v) => sum + (v.refuted ? 0 : v.confidence), 0) / votes.length
    const criticalIssues = votes.filter(v => v.refuted && v.severity === 'critical')
    // Any critical refutation is an instant fail regardless of the other lenses' confidence
    const ok = weightedScore >= QA_CONFIDENCE_THRESHOLD && criticalIssues.length === 0
    
    const issues = [
      ...votes.filter(v => v.refuted).flatMap(v => v.reasons),
      ...(criticalIssues.length > 0 ? ['CRITICAL issues found - requires immediate attention'] : []),
    ]
    return { approve: ok, issues }
  } catch (error) {
    return { approve: false, issues: [`Adversarial QA error: ${error.message}`] }
  }
}

// Main adaptive QA dispatcher - routes to appropriate QA strategy
async function adaptiveQA(t, impl) {
  if (t.risk === 'high') {
    return await runAdversarialQA(t, impl)
  }
  
  if (t.complexity_score <= SIMPLE_COMPLEXITY_THRESHOLD) {
    return await runSimpleQA(t, impl)
  }
  
  return await runModerateQA(t, impl)
}
/**
 * Enhanced attempt loop with intelligent model escalation
 * @param {Object} t - Task object with complexity scoring and dependencies
 * @param {string} cli - CLI name to use for implementation attempts
 * @param {number} maxAttempts - Maximum number of implementation attempts
 * @param {string[]} seedFeedback - Initial feedback from previous attempts
 * @param {number} attemptOffset - Starting attempt number offset
 * @param {string|null} startTier - Tier to begin at (carries escalation across CLI reassignment); defaults to the task's own tier
 * @returns {Promise<Object>} Result object with success status and metrics
 */
async function intelligentAttemptLoop(t, cli, maxAttempts, seedFeedback, attemptOffset = 0, startTier = null) {
  try {
    // Validate inputs
    const validCli = validateCliName(cli)
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer')
    }
    if (!Array.isArray(seedFeedback)) {
      throw new Error('seedFeedback must be an array')
    }
    
    let feedback = seedFeedback
    let currentModelTier = validateModelTier(startTier || t.model_tier || 'simple')
  
  for (let n = 1; n <= maxAttempts; n++) {
    const attempt = attemptOffset + n
    
    // Model escalation on retry attempts
    if (n > 1 && currentModelTier !== 'expert') {
      const tiers = ['simple', 'moderate', 'complex', 'expert']
      const currentIndex = tiers.indexOf(currentModelTier)
      if (currentIndex < tiers.length - 1) {
        currentModelTier = tiers[currentIndex + 1]
        log(`${t.id}: escalating to ${currentModelTier} model for attempt ${attempt}`)
      }
    }
    
    // Immutable per-attempt view: never mutate the shared task object
    const tAttempt = { ...t, model_tier: currentModelTier }
    
    const impl = await intelligentImplement(tAttempt, cli, attempt, feedback)
    if (!impl || impl.status !== 'ok') {
      const gates = impl ? (impl.gate_results || []).filter(g => !g.pass)
        .map(g => `${g.name}: ${g.detail || 'failed'}${g.duration ? ` (${g.duration}ms)` : ''}`)
        .join('; ') : ''
      feedback = [...feedback, impl
        ? `attempt ${attempt} (${cli}/${currentModelTier}): ${impl.status} — ${impl.summary}${gates ? ` · gates: ${gates}` : ''}`
        : `attempt ${attempt} (${cli}): wrapper agent died`]
      continue
    }
    
    const verdict = await adaptiveQA(tAttempt, impl)
    if (verdict.approve) return { 
      task: t.id, cli, impl, attempts: attempt, feedback, 
      final_model_tier: currentModelTier, complexity_achieved: impl.complexity_achieved 
    }
    feedback = [...feedback, ...verdict.issues]
    log(`${t.id}: attempt ${attempt} on ${validCli}/${currentModelTier} rejected (${verdict.issues.length} issues)`)
  }
  return { exhausted: true, feedback, final_model_tier: currentModelTier }
  } catch (error) {
    log(`Attempt loop failed for ${t.id}: ${error.message}`)
    return { exhausted: true, feedback: [...seedFeedback, `Attempt loop error: ${error.message}`], final_model_tier: t.model_tier || 'simple' }
  }
}

// Constants for task execution
const COMPLEX_THRESHOLD = 70
const COMPLEXITY_WEIGHT = 0.4
const EFFICIENCY_WEIGHT = 0.3
const MODEL_WEIGHT = 0.3

// Competition between multiple CLIs for high-risk/complex tasks
async function runCompetitiveTask(t) {
  try {
    const competitors = [t.cli, cfg.alternates[t.cli]].filter(c => c && cfg.registry[c])
    log(`${t.id} (${t.risk === 'high' ? 'high risk' : 'complex'}): competing on ${competitors.join(' vs ')}`)
    
    const all = (await parallel(competitors.map(c => () =>
      intelligentImplement(t, c, 1, []).then(i => i && { ...i, cli: c })))).filter(Boolean)
    const impls = all.filter(i => i.status === 'ok')
    
    if (impls.length === 0) {
      return await handleFailedCompetition(t, all)
    }
    
    const { winner, graft } = await judgeCompetition(t, impls)
    
    if (winner) {
      const verdict = await adaptiveQA(t, winner)
      if (verdict.approve) {
        return { 
          task: t.id, cli: winner.cli, impl: winner, attempts: 1, graft,
          final_model_tier: winner.model_used, complexity_achieved: winner.complexity_achieved 
        }
      }
    }
    
    return await handleFailedCompetition(t, all, winner)
  } catch (error) {
    log(`Competition failed for ${t.id}: ${error.message}`)
    return { task: t.id, failed: true, error: error.message }
  }
}

// Judge competition between implementations
async function judgeCompetition(t, impls) {
  let winner = impls[0], graft = []
  
  if (impls.length > 1) {
    try {
      const scores = (await parallel(impls.map(i => () =>
        agent(intelligentJudgePrompt(t, i), { 
          label: `judge:${t.id}:${i.cli}`, 
          phase: 'QA', 
          schema: ADAPTIVE_JUDGE_SCHEMA,
          model: 'sonnet'
        }).then(s => ({ i, s }))))).filter(x => x && x.s)
      
      // Weight by complexity handling and model efficiency
      scores.forEach(x => {
        x.weighted_score = x.s.score * COMPLEXITY_WEIGHT + 
                          x.s.complexity_handling * EFFICIENCY_WEIGHT + 
                          x.s.model_efficiency * MODEL_WEIGHT
      })
      scores.sort((a, b) => b.weighted_score - a.weighted_score)
      
      winner = scores[0]?.i ?? winner
      graft = scores.slice(1).flatMap(x => x.s.graft_ideas)
    } catch (error) {
      log(`Judging failed for ${t.id}: ${error.message}`)
    }
  }
  
  return { winner, graft }
}

// Handle failed competition with retry logic
async function handleFailedCompetition(t, all, winner = null) {
  const retryCli = winner ? winner.cli : t.cli
  const seed = all.filter(i => i.status !== 'ok').map(i => {
    const gates = (i.gate_results || []).filter(g => !g.pass).map(g => `${g.name}: ${g.detail}`).join('; ')
    return `competition attempt (${i.cli}): ${i.status} — ${i.summary}${gates ? ` · gates: ${gates}` : ''}`
  })
  
  const retried = await intelligentAttemptLoop(t, retryCli, 2, seed, 1)
  if (!retried.exhausted) return { ...retried, graft: [] }
  
  // Carry the escalated tier into the alternate CLI (don't restart at the task's base tier)
  const fallback = await intelligentAttemptLoop(t, cfg.alternates[retryCli], 2,
    [...retried.feedback, `prior CLI (${retryCli}) exhausted`], 3, retried.final_model_tier)
  return fallback.exhausted ? { task: t.id, failed: true } : fallback
}

// Standard single-CLI task execution
async function runStandardTask(t) {
  try {
    const primary = await intelligentAttemptLoop(t, t.cli, 3, [])
    if (!primary.exhausted) return primary
    
    log(`${t.id}: ${t.cli} exhausted, reassigning to ${cfg.alternates[t.cli]}`)
    // Carry the escalated tier into the alternate CLI (don't restart at the task's base tier)
    const fallback = await intelligentAttemptLoop(t, cfg.alternates[t.cli], 2,
      [...primary.feedback, `prior CLI (${t.cli}) exhausted`], 3, primary.final_model_tier)
    return fallback.exhausted ? { task: t.id, failed: true } : fallback
  } catch (error) {
    log(`Standard task failed for ${t.id}: ${error.message}`)
    return { task: t.id, failed: true, error: error.message }
  }
}

/**
 * Main intelligent task execution dispatcher
 * Routes tasks to appropriate execution strategy based on risk and complexity
 * @param {Object} t - Task object with complexity scoring and metadata
 * @returns {Promise<Object>} Execution result with success/failure status and metrics
 */
async function runIntelligentTask(t) {
  log(`Starting ${t.id}: complexity ${t.complexity_score}/100, model tier ${t.model_tier}, deps: ${t.dependencies?.join(',') || 'none'}`)
  
  if (t.risk === 'high' || t.complexity_score > COMPLEX_THRESHOLD) {
    return await runCompetitiveTask(t)
  }
  
  return await runStandardTask(t)
}

// GUARD: one Workflow invocation = one dependency wave. All worktrees branch from
// the same cfg.baseBranch, so a co-launched predecessor's work is INVISIBLE to its
// dependents — dependency chains must be split across chained Workflow runs, with
// Phase 3 merging between them (see "Dependency waves — chaining Workflows").
const taskIds = new Set(cfg.tasks.map(t => t.id))
const intraDeps = cfg.tasks.filter(t => (t.dependencies || []).some(d => taskIds.has(d)))
if (intraDeps.length > 0) {
  throw new Error(`tasks [${intraDeps.map(t => t.id).join(', ')}] depend on tasks in this same Workflow invocation — split dependency waves into chained Workflow runs and merge between waves; worktrees all fork from ${cfg.baseBranch}, so in-flight predecessor work would be invisible to them`)
}

phase('Implement')
let results = []

// Optional grouping of (mutually independent) tasks into clusters within this wave
if (cfg.taskGraph && cfg.taskGraph.independent_clusters) {
  for (const cluster of cfg.taskGraph.independent_clusters) {
    log(`Processing cluster: ${cluster.map(id => cfg.tasks.find(t => t.id === id)?.description).join(', ')}`)
    
    const clusterTasks = cluster.map(id => cfg.tasks.find(t => t.id === id)).filter(Boolean)
    const clusterResults = (await parallel(clusterTasks.map(t => () => runIntelligentTask(t)))).filter(Boolean)
    results.push(...clusterResults)
    
    // Brief coordination pause for large clusters
    if (cluster.length > 3) {
      log(`Cluster complete: ${clusterResults.filter(r => !r.failed).length}/${cluster.length} successful`)
    }
  }
} else {
  // Fallback: process all tasks in parallel (legacy mode)
  results = (await pipeline(cfg.tasks, t => runIntelligentTask(t))).filter(Boolean)
}

phase('QA')
// Additional QA coordination for complex dependencies
const failedTasks = results.filter(r => r.failed)
if (failedTasks.length > 0 && cfg.intelligence?.adaptiveQA) {
  log(`${failedTasks.length} tasks failed - checking dependency impact`)
  // Note: Could add dependency impact analysis here
}

// Calculate intelligence metrics
complexityMetrics.efficiency = complexityMetrics.planned > 0 ? 
  (complexityMetrics.achieved / complexityMetrics.planned) * 100 : 100

return {
  approved: results.filter(r => !r.failed),
  failed: results.filter(r => r.failed).map(r => r.task),
  external_tokens: externalTokens,
  token_coverage: { captured: tokenCaptured, total: tokenAttempts },
  
  // Enhanced intelligence metrics
  intelligence_metrics: {
    complexity_efficiency: Math.round(complexityMetrics.efficiency),
    planned_complexity: complexityMetrics.planned,
    achieved_complexity: complexityMetrics.achieved,
    model_usage: modelUsage,
    task_parallelization: cfg.taskGraph?.independent_clusters?.length || 1,
    average_attempts: tokenAttempts > 0 ? Math.round((results.length / tokenAttempts) * 10) / 10 : 0
  }
}
```

Notes: the high-risk branch is terminal — attempt 1 is a two-CLI competition; the judged winner (or the primary, when no competitor passes attempt 1) gets 2 feedback retries (attempts 2–3) on its own CLI/worktree, then that CLI's alternate gets 2 attempts (4–5), then the task tombstones as `{task, failed: true}`. Routine tasks get 3 attempts on the primary, then 2 on the alternate (attempts 4–5), then the same tombstone. `attemptLoop` returns `{exhausted: true, feedback}` on exhaustion, so all rejection feedback — QA issues and failing-gate details — accumulates and is carried into the alternate CLI's prompts along with a reassignment note. In the high-risk path the alternate may resume in its own competition worktree rather than a fresh one — deliberate: it has its own branch, committed history, and the carried feedback. Both branches return through the same shape; a task that exhausts every path comes back as `{task, failed: true}` — never silently dropped.

## Phase 3 — Intelligent Merge (orchestrator Claude, after each wave's Workflow returns)

**Delegate the mechanical merge to a Haiku subagent — do NOT run it in the main loop.** The orchestrator's own model is the *session* model (e.g. Opus), and a skill cannot downshift its own main-loop model, so merging inline pays Opus rates for mechanical work. Instead, for each approved task spawn an `Agent({ model: 'haiku' })` that performs that one task's squash-merge + full gate run and reports pass/fail back. The orchestrator sequences the tasks (dependency-ordered) and inspects each result before the next. **Escalate to `Agent({ model: 'sonnet' })` only when a merge conflicts** — conflict resolution is Rule 7 judgment (pick, don't blend) and belongs on the stronger model. (A `claudeModels` config block can override these per-phase model choices.)

1. **Dependency-aware merge sequence**: Use task dependency graph to determine safe merge order. Dependencies must be merged before dependents.

2. **Enhanced merge process** per approved task:
```bash
cd <repo>
# Verify clean working tree
git status --porcelain   # must be empty

# Intelligent merge with conflict prediction
git merge --squash <branch>   # or git diff + apply for complex cases
# Run ALL gates with performance tracking
for gate in build typecheck test lint; do
  time $gate_command   # track duration for future optimization
done

# Enhanced commit with intelligence metadata
git commit -m "feat: <task_summary> (ultraswarm: <cli>/<model_tier>, complexity: <achieved_complexity>/100)"
```

3. **Intelligent conflict resolution**:
   - **Simple conflicts**: Auto-resolve using project patterns and conventions
   - **Complex conflicts**: Use Sonnet to analyze context and determine optimal resolution 
   - **Document all resolution choices** with rationale for transparency

4. **Graft application**: Apply beneficial ideas from losing implementations as Claude micro-edits, tracking:
   - Source implementation and rationale
   - Files modified and approach taken
   - Performance/quality impact

5. **Enhanced gate failure handling**:
   - Immediate rollback and impact analysis
   - Complexity reassessment (was model tier too low?)
   - Re-entry with enhanced feedback and model escalation
   - Escalation to expert-tier models if needed

6. **Progressive cleanup**: Remove worktrees and branches after successful merge, but preserve failed ones for post-mortem analysis until final report.

7. **Quality checkpoints**: After each merge, run abbreviated intelligence analysis to ensure integrated complexity doesn't exceed thresholds.

## Phase 4 — Enhanced Verification & Intelligence Report

**Delegate report generation to a Haiku subagent** (`Agent({ model: 'haiku' })`) rather than writing it in the main loop — structured-table output is mechanical and shouldn't run at the session model's (Opus) rate. Hand the subagent the per-task results, model-usage map, and token accounting; it formats the tables and prose below. (The orchestrator still runs the final full-suite verification itself before handing off.)

1. **Comprehensive final verification**:
   - Full test suite with coverage analysis (maintain 80%+ target)
   - Performance regression testing if applicable
   - Security scan for any auth/data-related changes
   - Integration testing across modified components
   - Lint and code quality verification

2. **Intelligence Summary Report**:

   **Task Execution Overview:**
   | Task ID | Description | CLI/Model | Complexity | Attempts | Status | Files |
   |---------|-------------|-----------|------------|----------|--------|-------|
   | t1 | Feature X | codex/gpt-5.4 | 35/100 | 1 | ✅ | src/feature.js, test/feature.test.js |
   | t2 | UI Component | gemini/gemini-2.5-pro | 28/100 | 2 | ✅ | src/ui/component.tsx |
   
   **Intelligence Metrics:**
   - **Complexity Efficiency**: 94% (achieved 847/planned 900 complexity points)
   - **Model Optimization**: 87% tasks used optimal model tier
   - **Parallelization**: 8 tasks across 3 independent clusters
   - **Task Granularity**: Average 23/100 complexity per task (target: ≤15)
   
   **Model Usage Distribution:**
   - gpt-5.4-mini: 3 tasks (simple boilerplate)
   - gpt-5.4: 2 tasks (moderate logic)  
   - gemini-2.5-pro: 2 tasks (UI components)
   - xai/grok-4.20-reasoning: 1 task (complex architecture)

3. **Enhanced token accounting** with intelligence breakdown:
   ```
   Token Accounting (intelligent run analysis)
     Claude — orchestration + QA:      ~<subagent_tokens> tokens (+ inline orchestration)
     └── Phase breakdown: 
         • Prompt analysis (Sonnet):   ~<analysis_tokens> tokens
         • Implementation (Haiku):     ~<impl_tokens> tokens  
         • QA reviews (Sonnet/Opus):   ~<qa_tokens> tokens
         • Coordination (Haiku):       ~<coord_tokens> tokens
     
     External CLIs — coding:           ~<external_tokens> tokens (captured <captured>/<total> CLI runs)
     └── Model tier breakdown:
         • Simple tasks (fast models): ~<simple_tokens> tokens
         • Moderate tasks:             ~<moderate_tokens> tokens
         • Complex tasks:              ~<complex_tokens> tokens
         • Expert escalations:         ~<expert_tokens> tokens
     
     Intelligence Efficiency Gain:    ~<efficiency_gain>% (vs. uniform high-tier models)
     Est. Claude work offloaded:      ~<external_tokens>† proxy estimate
   ```

4. **Failure Analysis** (if applicable):
   - Tasks that required model escalation and why
   - Dependencies that created coordination bottlenecks  
   - CLIs that underperformed expectations
   - Complexity misestimation patterns

5. **Quality Insights**:
   - Grafted improvements from competitive implementations
   - Security or architectural decisions made during conflicts
   - Performance optimization opportunities identified
   - Recommended configuration adjustments

6. **Final Status**: Report "COMPLETED WITH INTELLIGENCE" only if:
   - All tasks successful or acceptable failure rate documented
   - Final gates pass with performance benchmarks
   - Intelligence metrics meet configured thresholds
   - No critical security or architectural issues remain

## Failure handling

| Failure | Response |
|---|---|
| CLI missing/broken at health check or write probe | Drop from routing, tell the user |
| Gate fails on the base tree | Caught in Phase 0 — never launch the Workflow against a broken gate |
| CLI timeout / crash mid-task | Counts as failed attempt → retry/reassign path |
| Wrapper agent dies (null) | Same as failed attempt |
| All CLIs exhausted on a task | Claude implements it directly — flagged in report |
| Task fails with dependents in later waves | Dependents are blocked, never launched against a base missing their prerequisite — listed as `blocked (dependency <id> failed)` in the report |
| Dependent tasks passed to one Workflow invocation | Script throws fail-fast before any agent runs — split into chained per-wave Workflows |
| Merge conflict | Claude resolves, pick-don't-blend, documented |
| Post-merge gate regression | Revert that merge, fail path for that task, line continues |
