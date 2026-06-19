# Overnight Docs Sweep (Loop 001)

Source: https://signals.forwardfuture.ai/loop-library/loops/overnight-docs-sweep/

## Base Loop Instruction

Each night, review the codebase in full and make sure all documentation reflects the latest changes from the previous day. Update the documentation as needed, then open a pull request with those changes.

**Verify / stop:** Documentation matches the current implementation. Finish with a reviewable pull request.

## Ultraswarm-Specific Scope and Rules

Focus areas for ultraswarm (/home/fubak/projects/ultraswarm):

- README.md — all installation instructions (Claude Code plugin, Codex skill, Grok marketplace, Cursor agent, shell), "What's New" sections, command reference, policy, workers (including recent additions like `agent`, `small-harness`, `pi`, aliases, effort levels), development section.
- Generated host skills — `skills/ultraswarm/SKILL.md` and `hosts/*/skills/ultraswarm/SKILL.md` are produced from `hosts/host-contract.json` by `scripts/generate-host-skills.mjs`. Never hand-edit the generated SKILL.md files. If the contract or generation changes, update relevant documentation describing the process.
- Config examples: `ultraswarm.config.example.json`, `ultraswarm.config.advanced.json`.
- Scripts: validate.sh, install-*.sh, generate-host-skills.mjs.
- Source behavior: bin/ultraswarm.mjs surface, lib/orchestrator/*, state, routing, policy.
- Historical design docs in `docs/plans/`, `docs/specs/`, `docs/notes/` — these are mostly archival. Update references only when they are actively linked or clearly incorrect for current users. Prefer leaving dated design records as-is.

**Do not touch** CHANGELOG.md in this loop (separate loop).

## Execution Steps

1. Discover recent relevant changes (git log --since="1 day ago", gh pr list for recent merges, review key commits).
2. Cross-reference against current documentation using read_file, grep, and terminal commands (e.g. `node bin/ultraswarm.mjs --help`).
3. Identify only genuine drift.
4. Make precise, minimal updates using search_replace (preferred) or write.
5. Verify: run `bash scripts/validate.sh`, `npm test`, and spot-check any updated commands/examples.
6. If documentation was changed:
   - Commit using conventional style.
   - Create PR with `gh pr create --fill`.
   - Describe the drift and fixes clearly.
7. If no changes: explicitly conclude with evidence that docs are current.

## Additional Constraints (this repo)

- Follow all rules in the root CLAUDE.md and development standards.
- ALWAYS use the `gh` CLI for pull requests and GitHub interactions.
- Surgical changes only. Do not rewrite accurate documentation.
- Prefer editing existing files.
- Run tests and validation before considering the task complete.
- Use relative paths.
- If non-doc code changes are required to keep docs accurate, keep scope minimal and note them separately.

## Outcome

Report:
- Changes reviewed
- Files inspected
- Updates made (or "none")
- PR URL (if created)
- Verification commands run and results

Only stop when the verify condition is satisfied.