# Stage 0: Baseline and Inventory

**Owner:** Senior model  
**Dependencies:** none  
**Mode:** read-only; do not edit source files.

## Target

`app/ios/puuk-ios/`, its existing tests, and the GitHub Actions workflow that builds the unsigned IPA.

## Change

Produce a compact baseline report for the coordinator. Identify actual feature ownership and risky dependencies before any file moves. This stage is not a code review for unrelated bugs and must not change the accepted player background.

## Constraints

- Inspect `git status` and relevant diffs first. Treat all pre-existing modifications/untracked files as user work. Specifically include the current player background implementation in the baseline; do not revert, rewrite, or judge it solely by its one-line module size.
- Do not edit, format, rename, or generate files.
- Read local iOS `AGENTS.md`, package scripts, current tests, app entry/composition, player controller, navigation, settings/API ownership, and IPA workflow.
- Confirm exact current commands available for Jest and CI/build. Do not claim a simulator or local iOS build was run if unavailable.
- Keep observations evidence-based with file references; distinguish verified behavior from assumptions.

## Ownership

Read-only across the repository. No source or documentation edits.

## Observable acceptance

Report:

- Dirty worktree files and a short description of the existing player/background changes.
- Current test/build/lint/format commands and whether dependencies are installed.
- Feature/file inventory: app bootstrap, auth, player, catalog/home, search, library, playlists/albums, settings, shared UI/API/storage.
- Player contracts that must be preserved: visible composition, background/lock-screen playback, queue/history, lyrics, gestures, likes, normalization, network/loading states.
- Current GitHub Actions IPA workflow and any native/dependency constraints it imposes.
- Candidate extraction/move risks and recommended first implementation slice, without prescribing speculative abstractions.
- Any gaps requiring a physical iPhone check.

## Report

Return findings, exact paths, commands actually run and results, and blockers. No files should be modified.
