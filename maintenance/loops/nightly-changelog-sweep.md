# Nightly Changelog Sweep (Loop 008)

Source: https://signals.forwardfuture.ai/loop-library/loops/nightly-changelog-sweep/

## Base Loop Instruction

Each night, review changes from the previous day and update the changelog with anything users should know.

**Verify / stop:** Every user-relevant change from the previous day is accounted for. The changelog is updated and validated, or the no-change result is recorded.

## Ultraswarm-Specific Scope and Rules

ultraswarm user audience includes people who:
- Install the runner or host skills/plugins
- Use new workers (`codex`, `gemini`, `grok`, `pi`, `small-harness`, `agent`/Cursor, aliases)
- Configure policy, effort levels, overrides
- Rely on commands, durability, recovery, routing explanations

**User-facing** (usually warrant entries):
- New or changed worker support
- New top-level features (effort, aliases, contracts, approvals)
- Installation / plugin marketplace changes
- Breaking changes or important behavior shifts
- Significant bug fixes that affect users of the CLI

**Usually not user-facing**:
- Pure internal refactors with no behavior change
- Test-only additions
- Development process changes (unless they affect consumers)

Use Keep a Changelog format + SemVer (see header of CHANGELOG.md). Look at recent entries (3.4.0, 3.3.0, 3.2.x) for tone, structure, and grouping (Added / Fixed / Changed).

## Execution Steps

1. Collect previous day's changes:
   - `git log --since="1 day ago" --oneline`
   - `gh pr list --state=merged --search "merged:>YYYY-MM-DD" --json number,title,author,mergedAt,body` (calculate yesterday)
   - Include any direct main commits.
2. For each item, evaluate whether a typical user or integrator needs to know.
3. Read the top of CHANGELOG.md.
4. Add or update entries only where justified. Keep entries concise, accurate, and reference PRs where helpful.
5. Do not duplicate existing entries. Preserve structure.
6. Sanity check: `npm test && bash scripts/validate.sh`
7. If an update was made:
   - Commit (conventional).
   - `gh pr create --fill`
8. If nothing warranted an entry, record the reviewed changes and conclude "no user-facing changes requiring changelog update".

## Additional Constraints (this repo)

- Source of truth = actual merged behavior and user impact, not commit messages.
- ALWAYS use `gh` for PR creation.
- Surgical edits.
- Follow project conventions.
- Report the list of changes considered and the final decision.

## Outcome

Final summary must include:
- Date range reviewed
- Key changes evaluated
- Action taken (update + PR link, or no-change with justification)

Stop only when verify condition is met.
