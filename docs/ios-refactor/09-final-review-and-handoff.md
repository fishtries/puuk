# Stage 9: Final Review and Handoff

**Owner:** Senior model / coordinator  
**Dependencies:** all accepted implementation stages.

## Target

Full `app/ios/puuk-ios/` diff produced by this plan and applicable GitHub Actions checks.

## Change

Independently verify the refactor, update the iOS code map, and record remaining debt. Do not use the final stage to add unplanned cleanup.

## Constraints

- Review the full diff against the original dirty-tree baseline; do not attribute or remove pre-existing user changes.
- Player appearance/functionality is an invariant. No redesign or new DJ transition behavior is part of this refactor.
- Do not claim physical iPhone checks were done unless the user performed/reported them.
- Do not commit unless requested.
- Do not broaden scope to fix unrelated findings; create separate tasks for them.

## Ownership

Coordinator/senior reviewer owns acceptance and documentation update. Implementation workers do not review their own work as the only acceptance evidence.

## Observable acceptance

- Full Jest suite passes and exact output/command is reported.
- Applicable Expo bundle/export and GitHub Actions unsigned IPA workflow pass or have an explicit environment blocker.
- No accidental edits to generated `dist/`, native signing, package versions, or server contracts.
- Player invariants have a written verification record, including device checks still outstanding.
- Feature tree and module ownership documentation match actual code.
- Remaining risks and postponed decisions (TypeScript, Zustand, deeper event cleanup, DJ transitions) are listed without speculative implementation.

## Report

Provide accepted stages, changed structure, all checks and results, physical-device checks, unresolved risks, and current Git status. Do not summarize unverified behavior as proven.
