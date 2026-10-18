# iOS Client Refactoring Plan

This folder is the execution plan for refactoring `app/ios/puuk-ios/`. The coordinator should dispatch one stage at a time, verify the result, and only then release dependent stages.

## Objective

Make the iOS client easier to understand, test, and extend by organizing code around product features and clarifying ownership. Preserve the player as users currently experience it. Other screens may be redesigned in separate, explicitly scoped work, but that is not part of this behavior-preserving refactor.

The current player background implementation is the accepted baseline. Do not recreate it, move its color into a one-line module, or change its appearance as part of structural work.

## Non-negotiable constraints

- Preserve player appearance and behavior, including artwork/ambient background, lyrics, queue, gestures, mini-player/full-player transitions, playback controls, and current error/loading states.
- Preserve background playback and lock-screen/Control Center controls. These already work and must not be “reimplemented” during cleanup.
- Do not change audio engine, playback timing, server contracts, or navigation behavior unless a separate task explicitly authorizes it.
- Existing uncommitted changes are user work and part of the starting tree. Never reset, checkout, clean, or overwrite them. Inspect status and diffs before every stage; stop if the stage overlaps with unexpected concurrent edits.
- Use Expo SDK 57 and the current GitHub Actions unsigned IPA workflow. Do not add a native module or alter signing/build distribution. Any dependency proposal must be reviewed against the workflow before implementation.
- Do not add abstractions or files solely for isolation. A module must have a clear responsibility and expected change boundary; tiny constants stay beside their consumer unless they are shared meaningful configuration.
- Keep each stage small, behavior-preserving, and independently reviewable. Do not combine broad formatting, renames, architecture changes, and behavior changes in one stage.
- Do not add Zustand or migrate the app wholesale to TypeScript in this plan. Revisit after the core boundaries are clear and with a concrete benefit.
- Follow `app/ios/puuk-ios/AGENTS.md`: consult exact Expo SDK 57 docs before changing Expo APIs.

## Stage order

| Stage | File | Owner | Depends on | Outcome |
|---|---|---|---|---|
| 0 | [00-baseline-and-inventory.md](00-baseline-and-inventory.md) | Senior | none | Record baseline, dirty work, checks, and behavior contracts; no source edits |
| 1 | [01-quality-tools.md](01-quality-tools.md) | Senior decides, junior implements | 0 | Consistent formatting and focused lint checks without repo-wide churn |
| 2 | [02-app-composition.md](02-app-composition.md) | Senior | 0 | Reduce `App.js` responsibility while keeping runtime behavior unchanged |
| 3 | [03-feature-move-map.md](03-feature-move-map.md) | Senior | 0, 2 | Approve concrete feature tree and file ownership before moving files |
| 4 | [04-feature-structure.md](04-feature-structure.md) | Junior in bounded batches, senior reviews | 3 | Move related files by feature with imports/tests/build verified per batch |
| 5 | [05-shared-events-settings-api.md](05-shared-events-settings-api.md) | Senior designs, junior bounded implementation | 2, 4 | Make shared service/event ownership explicit without behavior changes |
| 6 | [06-player-boundary.md](06-player-boundary.md) | Senior | 0, 2 | Define stable player interface and protect audio lifecycle before decomposition |
| 7 | [07-player-decomposition.md](07-player-decomposition.md) | Senior leads; junior only on isolated pure modules | 6 | Reduce player complexity without changing presentation or playback behavior |
| 8 | [08-track-data-contract.md](08-track-data-contract.md) | Senior designs, junior implements narrow slices | 4, 6 | Normalize track identity at boundaries and reduce repeated `id`/`track_id` handling |
| 9 | [09-final-review-and-handoff.md](09-final-review-and-handoff.md) | Senior | all accepted stages | Verify invariants, document remaining debt, and update architecture map |

Stages 2 and 6 may be prepared in parallel only as read-only design work. Source edits should be serialized because `App.js`, navigation, and player composition are coupled. Stage 4 should be split into non-overlapping batches; never dispatch concurrent file moves in the same feature tree.

## Junior vs senior assignment

**Junior model is suitable for:** exact file moves after the move map is approved; updating imports; extracting a pure helper with supplied behavior; adding focused tests from explicit cases; applying formatter to listed changed files; updating an agreed file map. Give it an exact allowlist of files and ask it to stop rather than broaden scope.

**Senior model owns:** architecture and API boundaries; player/audio behavior; decisions about event/state ownership; feature placement when ownership is ambiguous; dependency/build changes; interpreting test failures; review and acceptance. A junior can investigate these areas read-only but must not independently redesign them.

Do not use model labels as a quality guarantee. The coordinator reviews actual diffs and reruns acceptance checks for every stage.

## Required task contract

Copy the relevant stage file into the orchestration Task/Dispatch. Each task must retain its Target, Change, Constraints, Ownership, Observable acceptance, and Report sections. A worker may not silently expand ownership. If it discovers that a behavior change is required, it stops and asks the coordinator to create a separate task.

## Stage completion

A stage is accepted only when:

1. The diff contains only the stage's intended structural changes and tests/docs needed for them.
2. Existing relevant tests pass; new tests cover extracted logic or a proven risk, not merely mirror implementation.
3. The coordinator verifies imports, navigation, and relevant GitHub Actions/build configuration.
4. Player invariants remain intact. Where a stage touches player rendering/audio lifecycle, record a physical-iPhone check. Automated checks do not prove background audio, lock-screen controls, gesture feel, or animation equivalence.
5. The report lists changed files, exact commands and outcomes, manual checks still required, and unresolved concerns.

Do not commit unless the user asks. Avoid running a whole-tree formatter as part of this plan.
