# Stage 4: Feature-Oriented File Moves

**Owner:** Junior model for explicitly allowlisted batches; senior reviews each batch.  
**Dependencies:** Stage 3 map approved.

## Target

Only the exact files and destinations listed in the approved Stage 3 batch. Exclude player internals until Stage 6/7 approval.

## Change

Move related existing screens, components, hooks, services, and tests into the approved feature structure. Update imports and test paths without altering behavior.

## Constraints

- One bounded batch per dispatch. Do not move all features in one patch.
- The task prompt must include an exact source/destination allowlist copied from the approved map.
- Do not opportunistically rename symbols, reformat files, fix unrelated bugs, alter UI, or change component APIs.
- Preserve all dirty worktree changes. Stop if a source file differs from the approved map or has concurrent edits not included in the task context.
- Keep relative import resolution valid. Avoid index/barrel files unless explicitly present in the approved map and they remove real import coupling.
- Do not move Expo config, native iOS files, scripts, `dist/`, or package metadata.
- Player appearance and behavior remain unchanged; do not modify player files in non-player batches.

## Ownership

Junior may edit only the listed move batch and corresponding import/test references. Senior owns merge/review and any ambiguous ownership decision.

## Observable acceptance

- All listed files exist at approved destinations; no unapproved files moved.
- No stale imports reference removed paths.
- Relevant tests pass, then full `npm test -- --runInBand` passes when practical.
- Expo bundle/export or configured GitHub Actions validation resolves the new imports.
- Diff is primarily file moves/import updates; behavior-bearing hunks are explained and separately reviewed.
- No new empty feature folders or generic utility modules were introduced.

## Report

List moved files, import changes, exact checks/results, any files intentionally left in place, and blockers. Do not continue to another batch without coordinator acceptance.
