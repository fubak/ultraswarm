// Shared prompt templates and JSON schemas extracted from skills/ultraswarm/SKILL.md.
// These are pure functions — no closure over Workflow globals.

export const IMPL_SCHEMA = { type:'object', properties:{
  status:{type:'string',enum:['ok','cli_failed','gates_failed','timeout','model_unavailable','complexity_exceeded','no_changes']},
  worktree:{type:'string'}, branch:{type:'string'},
  files_changed:{type:'array',items:{type:'string'}},
  gate_results:{type:'array',items:{type:'object',properties:{name:{type:'string'},pass:{type:'boolean'},detail:{type:'string'},duration:{type:'number'}},required:['name','pass']}},
  summary:{type:'string'}, concerns:{type:'array',items:{type:'string'}},
  cli_tokens:{type:'number'}, model_used:{type:'string'}, complexity_achieved:{type:'number'},
  performance_metrics:{type:'object',properties:{execution_time:{type:'number'},memory_peak:{type:'number'},quality_indicators:{type:'object'}}}
}, required:['status','worktree','branch','files_changed','gate_results','summary','concerns','cli_tokens','model_used','complexity_achieved'] }

export const ENHANCED_REVIEW_SCHEMA = { type:'object', properties:{
  approve:{type:'boolean'}, issues:{type:'array',items:{type:'string'}},
  quality_score:{type:'number'}, complexity_assessment:{type:'number'},
  recommendations:{type:'array',items:{type:'string'}}, requires_expert_review:{type:'boolean'}
}, required:['approve','issues','quality_score','complexity_assessment'] }

export const ADAPTIVE_JUDGE_SCHEMA = { type:'object', properties:{
  score:{type:'number'}, rationale:{type:'string'}, graft_ideas:{type:'array',items:{type:'string'}},
  complexity_handling:{type:'number'}, model_efficiency:{type:'number'}, code_quality:{type:'number'}
}, required:['score','rationale','graft_ideas','complexity_handling','model_efficiency','code_quality'] }

export const EXPERT_VERDICT_SCHEMA = { type:'object', properties:{
  refuted:{type:'boolean'}, reasons:{type:'array',items:{type:'string'}},
  confidence:{type:'number'}, severity:{type:'string',enum:['low','medium','high','critical']},
  alternative_approach:{type:'string'}
}, required:['refuted','reasons','confidence','severity'] }

export const EXPERT_LENSES = ['correctness', 'security', 'regression']
export const VALID_MODEL_TIERS = ['simple', 'moderate', 'complex', 'expert']
export const VALID_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh']
export const DEFAULT_EFFORT = 'low'
export const VALID_CLAUDE_MODELS = ['haiku', 'sonnet', 'opus', 'fable']

// Hard cap for the on-disk worker prompt. Truncation is LOUD (an explicit marker in the prompt
// itself, and callers log `truncated`) — a silently clipped prompt reads as full coverage (Rule 12).
export const WORKER_PROMPT_MAX_CHARS = 64_000
export const capWorkerPrompt = (text, max = WORKER_PROMPT_MAX_CHARS) =>
  text.length <= max
    ? { text, truncated: 0 }
    : { text: `${text.slice(0, max)}\n[ultraswarm: prompt truncated — ${text.length - max} chars dropped]`, truncated: text.length - max }

// Clean inner task prompt for direct handoff to external coding CLIs (portable runner path).
// The external CLI receives ONLY the user task + files + acceptance criteria + prior feedback.
// No wrapper role-play, no worktree instructions, no meta "run the CLI" steps — the Node runner
// handles worktree creation, prompt writing (this content), CLI invocation, gates, and commit.
// Feedback is bounded (last 10 items, 500 chars each) so retries don't balloon the prompt with
// repeated gate dumps — the newest feedback is what the retry must fix.
export const buildWorkerTaskPrompt = (t, feedback = []) => {
  const bounded = feedback.slice(-10).map((f) => String(f).slice(0, 500))
  return `${t.description}
Files to modify: ${JSON.stringify(t.files)}

${t.prompt}${bounded.length ? `

FIX ALL of these issues from prior attempts:
${bounded.map((f, i) => `${i+1}. ${f}`).join('\n')}` : ''}`
}

export const enhancedImplPrompt = (cfg, t, cli, attempt, feedback, command, timeoutMs) => {
  const wt = (t, cli) => `${cfg.worktreeRoot}/${cfg.repoName}-us-${t.id}-${cli}`
  const br = (t, cli) => `ultraswarm/${t.id}-${cli}`
  const gateList = cfg.gates.map(g => `${g.name}: ${g.cmd}${g.expectedDuration ? ` (expected: ${g.expectedDuration}ms)` : ''}`).join('\n   ')
  return `You are a WRAPPER around the external CLI "${cli}". You do NOT write feature code — only run the CLI and report. Task ${t.id} (${t.model_tier} tier, attempt ${attempt}).

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

3. Run the CLI (timeout ${timeoutMs}ms):
   cd ${wt(t,cli)} && ${command}

4. Run the gates in the worktree:
   ${gateList}

5. Housekeeping + commit:
   rm ${wt(t,cli)}/.ultraswarm-prompt.txt
   cd ${wt(t,cli)} && git add -A && git commit -m "ultraswarm: ${t.id}/${t.model_tier} attempt ${attempt}"

6. Return the IMPL schema: status, worktree, branch, files_changed, gate_results, summary,
   concerns (scope creep / pattern deviations), cli_tokens and model_used parsed from the CLI
   output (0 / "default" when absent), complexity_achieved (your estimate vs ${t.complexity_score}/100 target).`
}

export const adaptiveReviewPrompt = (cfg, t, impl) => `INTELLIGENT CODE REVIEW — Adaptive depth based on complexity score ${t.complexity_score}/100.

ANALYSIS TARGET:
cd ${impl.worktree} && git diff ${cfg.baseBranch}...${impl.branch}
Task: ${t.description} · Complexity: ${t.complexity_score}/100 · Model: ${impl.model_used}

REVIEW CRITERIA (adaptive based on complexity):
${t.complexity_score <= 20 ? 'SIMPLE TASK REVIEW:' : t.complexity_score <= 50 ? 'MODERATE TASK REVIEW:' : 'COMPLEX TASK REVIEW:'}

CORE CHECKS (all complexity levels):
0. (MUST) The actual git diff must contain modifications to the files listed in the task (${JSON.stringify(t.files)}). If the diff is empty, only touches unrelated files, or does not implement the full requirements described, this is a hard failure: set approve=false and include a clear issue such as "no relevant changes to requested files" or "diff does not match task".
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

export const intelligentJudgePrompt = (cfg, t, impl) => `INTELLIGENT IMPLEMENTATION SCORING — Multi-dimensional analysis for task ${t.id}.

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

export const expertLensPrompt = (lens, t, impl, baseBranch) => `EXPERT ADVERSARIAL ANALYSIS — ${lens} lens with confidence scoring.

ANALYSIS TARGET:
cd ${impl.worktree} && git diff ${baseBranch}...${impl.branch}
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
