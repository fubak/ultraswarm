# Repository Cleanup Loop (Loop 012)

Source: https://signals.forwardfuture.ai/loop-library/loops/repository-cleanup-loop/

## Base Loop Instruction

Inspect local and remote branches, pull requests, commits, and worktrees. Recover valuable work and clean everything stale until the repository is current and organized.

**Verify / stop:** Valuable work is recovered and remaining repository state is intentional. Branches, pull requests, commits, and worktrees are current, owned, or safely removed with evidence.

## Ultraswarm-Specific Scope and Rules

This project creates many temporary artifacts:
- Integration branches: `ultraswarm/run-<run-id>`
- Isolated worktrees for worker execution
- Feature branches during development

These are expected but must be cleaned after use.

Other common items: old `feature/*`, `fix/*` branches, stale PRs, unmerged experiments.

**Critical safety rules for this repo:**
- Never delete uncertain work.
- Never discard uncommitted changes.
- Do not close other people's PRs without explicit confirmation.
- Always record evidence (command output) for every deletion or recovery.
- Prefer `gh` CLI.

## Execution Steps

1. Full inventory (capture all output):
   ```bash
   git fetch --all --prune
   git branch -a
   git worktree list
   gh pr list --state open --json number,title,headRefName,author,updatedAt
   gh pr list --state closed --limit 30 --json number,title,headRefName,state,mergedAt,closedAt
   git log --all --oneline --decorate -20
   ```
2. Classify every discovered item with evidence (age, last commit, relation to main, PR status):
   - Current / intentional
   - Valuable unfinished (recover)
   - Merged / superseded
   - Abandoned / stale
3. Recover valuable work first (create a dedicated recovery branch or note in a summary, cherry-pick key commits if small).
4. Clean only after recovery:
   - Delete local branches: `git branch -d <name>`
   - Delete remote: `git push origin --delete <name>` (or gh equivalent)
   - `git worktree prune`
   - `git fetch --prune`
5. Re-run the complete inventory.
6. If recovery or non-trivial cleanup happened, document it (small commit + `gh pr create --fill` describing actions + evidence).

## Additional Constraints (this repo)

- Be extremely conservative with deletions.
- Preserve full evidence in your final report.
- Use gh for PR-related operations.
- Follow git and project conventions.
- If anything is borderline, leave it and explain why.

## Outcome

Your final report must contain:
- Before inventory (key excerpts)
- Classification decisions with rationale
- Recovery actions (if any)
- Cleanup actions with exact commands + output
- After inventory proving intentional state
- Any PR created

Continue iterating the inventory until the verify condition is satisfied. Do not stop while stale items remain without justification.
