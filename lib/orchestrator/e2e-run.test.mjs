// End-to-end orchestrator test: drives the real ultraswarm runner IN-PROCESS (via the exported
// commandMain) through complete run → status → logs → export → merge flows, with NO network.
//
// Determinism + isolation strategy (see CLAUDE.md "Critical mechanics"):
//   - ULTRASWARM_BRAIN=mock makes brain() return a MockLlmClient(mockBrainBehavior): reviews
//     approve, judges score high, expert lenses don't refute — so QA passes with no LLM call.
//   - Worker CLIs are stubbed by overriding each enabled built-in's `invocation` to run
//     fixtures/fake-worker.mjs (writes the task's declared files) or fixtures/noop-worker.mjs
//     (writes nothing). The probe `<binary> --version` still hits the real installed binary, so
//     enabled built-ins report healthy; only the IMPLEMENTATION invocation is the stub.
//   - loadConfig() reads the PROJECT config from process.cwd() and the GLOBAL config from
//     $HOME/.claude — so every scenario chdir's into its temp repo and points HOME at a temp dir,
//     restoring both (and console) in finally. The temp target repo has no package.json, so
//     detectGates() returns [] (gates trivially pass).
//   - Happy-path task files are declared at the repo ROOT (a.js, b.js, …) with distinct names so
//     they never collide across the cross-wave integration merge. (The runner lists worker output
//     with `git status --porcelain -uall`, so files in new subdirectories are reported individually
//     too — see the forbiddenPaths-in-a-new-dir scenario below.)
//
// Run: node --test lib/orchestrator/e2e-run.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { commandMain, EXIT } from '../../bin/cli.mjs'
import { openRepoStore } from '../state/store.mjs'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')
const FAKE_WORKER = `node ${path.join(FIXTURES, 'fake-worker.mjs')} "$(cat .ultraswarm-prompt.txt)"`
const NOOP_WORKER = `node ${path.join(FIXTURES, 'noop-worker.mjs')} "$(cat .ultraswarm-prompt.txt)"`
const ROGUE_WORKER = `node ${path.join(FIXTURES, 'rogue-worker.mjs')} "$(cat .ultraswarm-prompt.txt)"`

// Each e2e "worker" is an ALIAS whose binary is `node` — always installed, so its health probe
// (`node --version`) passes in ANY environment, including CI where codex/droid/pi are absent. The
// implementation invocation is stubbed to a fixture; `extends` only inherits a capability profile.
// Tasks pin these aliases via `cli` (valid since validatePlan checks the effective registry).
const aliasWorker = (invocation, { extends: ext = 'codex', specialty = 'stub worker' } = {}) =>
  ({ extends: ext, binary: 'node', specialty, models: { simple: { model: 'stub', invocation } } })

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

// Build an isolated git repo with an initial commit. Caller cleans up.
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'us-e2e-repo-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'e2e@ultraswarm.test'])
  git(repo, ['config', 'user.name', 'ultraswarm-e2e'])
  fs.writeFileSync(path.join(repo, 'README.md'), '# e2e fixture repo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

// Allocate the full isolated environment for one scenario.
function makeEnv(config) {
  const repo = makeRepo()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'us-e2e-home-'))
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'us-e2e-wt-'))
  fs.writeFileSync(path.join(repo, 'ultraswarm.config.json'), JSON.stringify(config, null, 2))
  return { repo, home, worktreeRoot }
}

function cleanupEnv({ repo, home, worktreeRoot }) {
  for (const dir of [repo, home, worktreeRoot]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

function writePlan(home, plan) {
  const planFile = path.join(home, 'plan.json')
  fs.writeFileSync(planFile, JSON.stringify(plan))
  return planFile
}

// Drive commandMain in-process with cwd/HOME/console captured + restored. Returns
// { code, stdout }. stdout is the concatenation of console.log/console.error lines so callers
// can both assert on text (the run report) and JSON.parse single-command output.
async function drive({ repo, home }, argv) {
  const cwd0 = process.cwd()
  const home0 = process.env.HOME
  const brain0 = process.env.ULTRASWARM_BRAIN
  const log0 = console.log
  const err0 = console.error
  const lines = []
  process.chdir(repo)
  process.env.HOME = home
  process.env.ULTRASWARM_BRAIN = 'mock'
  console.log = (...a) => lines.push(a.join(' '))
  console.error = (...a) => lines.push(a.join(' '))
  try {
    // Two harness shims so these orchestration tests keep asserting machine output:
    //  • run: functional preflight is ON by default, but the fake fixtures respond only to the e2e
    //    task prompts, not the generic smoke prompt — opt out (--no-smoke) and let --version stand in.
    //    The functional smoke path has its own coverage (smoke.test + adapters tests).
    //  • status/doctor/workers: these now render human tables by default; the harness consumes JSON.
    let effective = argv
    if (argv[0] === 'run' && !argv.includes('--no-smoke')) effective = [...effective, '--no-smoke']
    if (['status', 'doctor', 'workers'].includes(argv[0]) && !argv.includes('--json')) effective = [...effective, '--json']
    const code = await commandMain(effective, repo)
    return { code, stdout: lines.join('\n') }
  } finally {
    console.log = log0
    console.error = err0
    process.chdir(cwd0)
    if (home0 === undefined) delete process.env.HOME; else process.env.HOME = home0
    if (brain0 === undefined) delete process.env.ULTRASWARM_BRAIN; else process.env.ULTRASWARM_BRAIN = brain0
  }
}

// Read store state directly (asserting persisted truth, independent of console output).
function withStore(repo, fn) {
  const store = openRepoStore(repo)
  try { return fn(store) } finally { store.close() }
}

describe('e2e orchestrator: run → status → logs → export → merge (in-process, mock brain)', () => {
  it('drives a complex multi-wave plan to awaiting_merge, then merges it into the target repo', async () => {
    // Three alias workers (binary `node`, healthy everywhere). Tasks are pinned to specific
    // aliases via `cli` — exercising the fix that lets a plan select an alias explicitly — with one
    // task left unpinned to exercise auto-routing too. `local-x` is pinned to general-setup so its
    // selection is asserted deterministically.
    const config = {
      enabled: ['w-backend', 'w-fullstack', 'local-x'],
      aliases: {
        'w-backend': aliasWorker(FAKE_WORKER, { extends: 'codex', specialty: 'backend and logic' }),
        'w-fullstack': aliasWorker(FAKE_WORKER, { extends: 'droid', specialty: 'full-stack refactors' }),
        'local-x': aliasWorker(FAKE_WORKER, { extends: 'pi', specialty: 'general local generalist' }),
      },
    }
    const env = makeEnv(config)
    const RID = 'e2e-happy-multiwave'
    // 4 tasks across 2 waves. Each writes a DISTINCT root-level file (clean integration merges).
    const plan = {
      tasks: [
        { id: 'core-refactor', description: 'refactor the core module architecture', files: ['core.js'], cli: 'w-backend', complexity_score: 15, risk: 'routine', dependencies: [], prompt: 'refactor core' },
        { id: 'general-setup', description: 'general project setup work', files: ['setup.js'], cli: 'local-x', complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'general setup' },
        { id: 'api-layer', description: 'full-stack refactor of the api layer', files: ['api.js'], cli: 'w-fullstack', complexity_score: 20, risk: 'routine', dependencies: ['core-refactor'], prompt: 'build api on core' },
        { id: 'general-polish', description: 'another general cleanup pass', files: ['polish.js'], complexity_score: 12, risk: 'routine', dependencies: ['general-setup'], prompt: 'general polish' },
      ],
    }
    const planFile = writePlan(env.home, plan)
    try {
      // ── run ───────────────────────────────────────────────────────────────────
      const run = await drive(env, ['run', '--plan-file', planFile, '--approve-plan', '--run-id', RID, '--worktree-root', env.worktreeRoot])
      assert.equal(run.code, EXIT.OK, `run should succeed; output:\n${run.stdout}`)
      assert.match(run.stdout, new RegExp(`Run: ${RID}`), 'report names the run id')
      assert.match(run.stdout, /4\/4 integrated/, 'all four tasks integrated into the integration branch')
      for (const id of ['core-refactor', 'general-setup', 'api-layer', 'general-polish']) {
        assert.match(run.stdout, new RegExp(`${id}\\s+\\S+\\s+integrated`), `report marks ${id} integrated`)
      }
      assert.match(run.stdout, /ultraswarm merge .* --approve/, 'report instructs the merge step')

      // v3.6: the report ENDS with the estimated-vs-used table by CLI × model × effort. The fake
      // node-binary workers emit no structured usage, so `used` must render "—" (honesty invariant)
      // while `est.` still shows the tier-curve estimate per routed bucket.
      assert.match(run.stdout, /TOKENS BY CLI \/ MODEL \/ EFFORT/, 'report ends with the route usage table')
      assert.match(run.stdout, /CLI\s+model\s+effort\s+est\.\s+used\s+Δ\s+attempts/, 'route table header present')
      assert.match(run.stdout, /route\(s\) reported no usage/, 'unreported workers surfaced honestly, not fabricated')

      // The alias must actually have been selected for a task (auto-routing reached local-x).
      // The human plan-preview table carries each task's resolved worker.
      assert.match(run.stdout, /local-x/, 'a task routed to the local-x alias')

      // run reached awaiting_merge with all tasks integrated (persisted truth).
      withStore(env.repo, (store) => {
        const r = store.getRun(RID)
        assert.equal(r.status, 'awaiting_merge', 'run is awaiting_merge')
        const states = Object.fromEntries(store.getTasks(RID).map((t) => [t.task_id, t.status]))
        assert.deepEqual(states, {
          'core-refactor': 'integrated', 'general-setup': 'integrated',
          'api-layer': 'integrated', 'general-polish': 'integrated',
        }, 'every task is integrated')
        // at least one task recorded local-x as its worker
        const workers = store.getTasks(RID).map((t) => t.worker)
        assert.ok(workers.includes('local-x'), 'a task is persisted with worker=local-x')
      })

      // ── status ────────────────────────────────────────────────────────────────
      const status = await drive(env, ['status', RID])
      assert.equal(status.code, EXIT.OK)
      const statusJson = JSON.parse(status.stdout)
      assert.equal(statusJson.run.id, RID, 'status carries the run id')
      assert.equal(statusJson.run.status, 'awaiting_merge')
      assert.equal(statusJson.tasks.length, 4, 'status lists all four task rows')
      assert.ok(statusJson.tasks.every((t) => t.status === 'integrated'), 'status shows tasks integrated')
      assert.ok(statusJson.attempts.length >= 4, 'status carries worker attempts')

      // ── logs --json ─────────────────────────────────────────────────────────────
      const logs = await drive(env, ['logs', RID, '--json'])
      assert.equal(logs.code, EXIT.OK)
      const events = JSON.parse(logs.stdout)
      assert.ok(Array.isArray(events) && events.length > 0, 'logs returns an event array')
      const types = new Set(events.map((e) => e.type))
      assert.ok(types.has('run.created'), 'events include run.created')
      assert.ok(types.has('attempt.started'), 'events include attempt.started')
      assert.ok(events.every((e) => typeof e.seq === 'number' && 'payload' in e), 'each event has seq + parsed payload')

      // ── export ──────────────────────────────────────────────────────────────────
      const exported = await drive(env, ['export', RID])
      assert.equal(exported.code, EXIT.OK)
      const dump = JSON.parse(exported.stdout)
      for (const key of ['run', 'tasks', 'attempts', 'events', 'approvals', 'worker_metrics']) {
        assert.ok(key in dump, `export includes ${key}`)
      }
      assert.equal(dump.run.id, RID)
      assert.ok(dump.approvals.some((a) => a.gate === 'plan'), 'export shows the plan approval')
      assert.ok(dump.events.length === events.length, 'export events match logs events count')

      // ── merge ───────────────────────────────────────────────────────────────────
      // Drive merge by the 8-char run-id PREFIX (the form the report's "Approve merge with:" line
      // prints) — proving prefix resolution: it must resolve to the full id (carried in the result).
      const merged = await drive(env, ['merge', RID.slice(0, 8), '--approve'])
      assert.equal(merged.code, EXIT.OK, `merge should succeed; output:\n${merged.stdout}`)
      const mergeResult = JSON.parse(merged.stdout)
      assert.equal(mergeResult.runId, RID, 'merge result carries the FULL run id, resolved from the prefix')
      assert.match(mergeResult.targetSha, /^[0-9a-f]{40}$/, 'merge result carries a target sha')

      // the merge actually landed: generated files now exist on main in the target repo.
      for (const file of ['core.js', 'setup.js', 'api.js', 'polish.js']) {
        assert.ok(fs.existsSync(path.join(env.repo, file)), `${file} landed in the target repo after merge`)
      }
      // and the run is recorded as merged with a moved HEAD.
      withStore(env.repo, (store) => {
        const r = store.getRun(RID)
        assert.equal(r.status, 'merged', 'run is merged')
        assert.equal(git(env.repo, ['rev-parse', 'HEAD']), mergeResult.targetSha, 'target HEAD advanced to the merge sha')
      })
    } finally {
      cleanupEnv(env)
    }
  })

  it('holds the approval gate: run WITHOUT --approve-plan returns EXIT.APPROVAL and executes nothing', async () => {
    const config = {
      enabled: ['w-backend', 'w-fullstack'],
      aliases: {
        'w-backend': aliasWorker(FAKE_WORKER, { extends: 'codex', specialty: 'backend and logic' }),
        'w-fullstack': aliasWorker(FAKE_WORKER, { extends: 'droid', specialty: 'full-stack refactors' }),
      },
    }
    const env = makeEnv(config)
    const RID = 'e2e-approval-gate'
    const plan = {
      tasks: [
        { id: 't1', description: 'refactor a thing', files: ['a.js'], cli: 'w-backend', complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'do it' },
      ],
    }
    const planFile = writePlan(env.home, plan)
    try {
      const run = await drive(env, ['run', '--plan-file', planFile, '--run-id', RID, '--worktree-root', env.worktreeRoot])
      assert.equal(run.code, EXIT.APPROVAL, 'run without --approve-plan is gated')
      assert.match(run.stdout, /approval required/i, 'output explains the gate')
      // The gate fires BEFORE any run row is created — nothing executed or persisted.
      withStore(env.repo, (store) => {
        assert.equal(store.getRun(RID), null, 'no run row was created')
        assert.equal(store.listRuns().length, 0, 'no runs exist at all')
      })
      // no worktrees were spun up under the worktree root.
      assert.deepEqual(fs.readdirSync(env.worktreeRoot), [], 'no worktrees created')
    } finally {
      cleanupEnv(env)
    }
  })

  it('enforces forbiddenPaths against a file the worker writes into a brand-new subdirectory', async () => {
    // The task DECLARES an innocuous root file (passes the pre-run enforceTaskPolicy check), but the
    // rogue worker ALSO writes vault/leak.secret — undeclared, forbidden, in a new dir. The implement
    // step lists actually-written files with `git status --porcelain -uall`, so the new-dir file is
    // seen individually and the forbiddenPaths policy blocks the attempt. (Without -uall, git would
    // report only "vault/", the *.secret glob would miss it, and the leak would integrate.)
    const config = {
      enabled: ['w-rogue'],
      aliases: { 'w-rogue': aliasWorker(ROGUE_WORKER, { extends: 'codex', specialty: 'rogue' }) },
      policy: { forbiddenPaths: ['**/*.secret'], minimumHealthyWorkers: 1 },
    }
    const env = makeEnv(config)
    const RID = 'e2e-forbidden-newdir'
    const plan = { tasks: [
      { id: 'rogue-task', description: 'write app.js', files: ['app.js'], cli: 'w-rogue', complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'write app.js' },
    ] }
    const planFile = writePlan(env.home, plan)
    try {
      const run = await drive(env, ['run', '--plan-file', planFile, '--approve-plan', '--run-id', RID, '--worktree-root', env.worktreeRoot])
      assert.equal(run.code, EXIT.BLOCKED, `forbidden write must block the run; output:\n${run.stdout}`)
      assert.ok(!fs.existsSync(path.join(env.repo, 'vault', 'leak.secret')), 'forbidden file must NOT reach the target repo')
      assert.ok(!fs.existsSync(path.join(env.repo, 'app.js')), 'blocked task must not integrate its declared file either')
      const status = await drive(env, ['status', RID])
      const statusJson = JSON.parse(status.stdout)
      assert.equal(statusJson.tasks.find((t) => t.task_id === 'rogue-task').status, 'failed', 'rogue task is persisted failed')
      assert.ok(statusJson.attempts.some((a) => a.error_kind === 'policy_blocked'), 'an attempt was rejected as policy_blocked')
    } finally {
      cleanupEnv(env)
    }
  })

  it('surfaces a failure: a task whose worker produces no change fails after retries/escalation', async () => {
    // w-good => the working fake worker; w-noop => the no-op worker (prints a token line, writes
    // nothing). The plan pins the bad task to w-noop. The implement no_changes gate rejects every
    // attempt; after 3 escalating attempts the task tombstones. This exercises the implement
    // retry/escalation loop and report's failed path.
    const config = {
      enabled: ['w-good', 'w-noop'],
      aliases: {
        'w-good': aliasWorker(FAKE_WORKER, { extends: 'codex', specialty: 'works' }),
        'w-noop': aliasWorker(NOOP_WORKER, { extends: 'droid', specialty: 'no-op' }),
      },
    }
    const env = makeEnv(config)
    const RID = 'e2e-failure-path'
    const plan = {
      tasks: [
        { id: 'noop-task', description: 'full-stack change that the worker silently skips', files: ['ghost.js'], cli: 'w-noop', complexity_score: 10, risk: 'routine', dependencies: [], prompt: 'write ghost.js' },
      ],
    }
    const planFile = writePlan(env.home, plan)
    try {
      const run = await drive(env, ['run', '--plan-file', planFile, '--approve-plan', '--run-id', RID, '--worktree-root', env.worktreeRoot])
      // A failed/blocked task drives a non-OK exit (BLOCKED).
      assert.equal(run.code, EXIT.BLOCKED, `failing run should exit BLOCKED; output:\n${run.stdout}`)
      assert.match(run.stdout, /noop-task\s+—\s+FAILED/, 'report marks the task FAILED (exhausted)')
      assert.match(run.stdout, /0\/1 integrated/, 'nothing integrated')

      // The worker never wrote the file — it must not exist in the target repo.
      assert.ok(!fs.existsSync(path.join(env.repo, 'ghost.js')), 'no-op worker produced no file')

      // status reflects the failed task and a non-mergeable run.
      const status = await drive(env, ['status', RID])
      assert.equal(status.code, EXIT.OK)
      const statusJson = JSON.parse(status.stdout)
      assert.equal(statusJson.run.status, 'completed_with_findings', 'run completed with findings (nothing to merge)')
      const task = statusJson.tasks.find((t) => t.task_id === 'noop-task')
      assert.equal(task.status, 'failed', 'noop-task is persisted failed')
      // escalation actually happened: the worker was retried (>1 attempt recorded).
      assert.ok(statusJson.attempts.length >= 2, 'the task was retried/escalated, not abandoned on first try')
    } finally {
      cleanupEnv(env)
    }
  })
})

// High-risk competition end-to-end through the REAL runner (real worktrees, judge, adversarial QA,
// integration merge) — unblocked by the alias-can't-compete fix, since e2e workers are aliases.
describe('e2e high-risk competition (in-process, mock brain)', () => {
  const config = {
    enabled: ['w-x', 'w-y'],
    aliases: {
      'w-x': aliasWorker(FAKE_WORKER, { extends: 'codex', specialty: 'backend' }),
      'w-y': aliasWorker(FAKE_WORKER, { extends: 'droid', specialty: 'full-stack' }),
    },
  }

  it('a high-risk task competes between two ALIAS workers and integrates the winner', async () => {
    const env = makeEnv(config)
    const RID = 'e2e-highrisk'
    const plan = { tasks: [
      { id: 'risky', description: 'high-risk feature', files: ['risky.js'], cli: 'w-x', complexity_score: 70, risk: 'high', dependencies: [], prompt: 'build the risky feature' },
    ] }
    const planFile = writePlan(env.home, plan)
    try {
      const run = await drive(env, ['run', '--plan-file', planFile, '--approve-plan', '--run-id', RID, '--worktree-root', env.worktreeRoot])
      assert.equal(run.code, EXIT.OK, `high-risk run should succeed; output:\n${run.stdout}`)
      assert.match(run.stdout, /1\/1 integrated/, 'the competition winner integrated')
      withStore(env.repo, (store) => {
        assert.equal(store.getRun(RID).status, 'awaiting_merge')
        assert.equal(store.getTasks(RID).find((t) => t.task_id === 'risky').status, 'integrated')
        // Proof a real COMPETITION ran (not a single-worker routine): both alias workers each made an
        // attempt. Pre-fix this tombstoned with 0 attempts ("only N usable worker(s)").
        const workers = new Set(store.getAttempts(RID).map((a) => a.worker))
        assert.ok(workers.has('w-x') && workers.has('w-y'), `both alias workers competed; saw ${[...workers]}`)
      })
    } finally { cleanupEnv(env) }
  })

  it('O3: a QA-rejected high-risk winner drives the retry path end-to-end (real runner)', async () => {
    const env = makeEnv(config)
    const RID = 'e2e-o3'
    // The QA_REJECT sentinel in the prompt makes the mock adversarial-QA lenses refute critically, so
    // the competition winner is rejected → handleFailedCompetition retries (with the QA feedback) →
    // the sentinel keeps rejecting → the task exhausts. Confirms the reject→retry path runs live.
    const plan = { tasks: [
      { id: 'rej', description: 'feature flagged QA_REJECT for the test', files: ['rej.js'], cli: 'w-x', complexity_score: 70, risk: 'high', dependencies: [], prompt: 'build it — QA_REJECT' },
    ] }
    const planFile = writePlan(env.home, plan)
    try {
      const run = await drive(env, ['run', '--plan-file', planFile, '--approve-plan', '--run-id', RID, '--worktree-root', env.worktreeRoot])
      assert.match(run.stdout, /0\/1 integrated|FAILED/, 'QA never approved → nothing integrated')
      withStore(env.repo, (store) => {
        assert.equal(store.getTasks(RID).find((t) => t.task_id === 'rej').status, 'failed', 'task failed after QA kept rejecting')
        // The competition ran (both alias workers) AND the winner was retried after QA rejection —
        // more attempts than the 2 initial competitors. Confirms the reject→retry path runs live.
        const attempts = store.getAttempts(RID)
        const workers = new Set(attempts.map((a) => a.worker))
        assert.ok(workers.has('w-x') && workers.has('w-y'), 'both alias workers competed')
        assert.ok(attempts.length > 2, `winner retried after QA rejection (got ${attempts.length} attempts)`)
      })
    } finally { cleanupEnv(env) }
  })
})
