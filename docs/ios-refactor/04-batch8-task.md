# Stage 4 Batch 8 Task — Shared AppHeader and TrackContextMenuModal

## Target

Move only these approved files (paths relative to `app/ios/puuk-ios/`):

- `components/AppHeader.js` → `shared/components/AppHeader.js`
- `components/TrackContextMenuModal.js` → `shared/components/TrackContextMenuModal.js`

No other source, test, asset, configuration, native, dependency, workflow, or package files are in the allowlist. Do not move player implementation files.

## Change

Perform exact file moves with no source behavior changes. Update only these currently identified direct imports after re-auditing the tree:

- `features/catalog/HomeScreen.js`: `../../components/AppHeader` → `../../shared/components/AppHeader`
- `navigation/MainTabs.js`: `../components/AppHeader` → `../shared/components/AppHeader`
- `App.js`: `./components/TrackContextMenuModal` → `./shared/components/TrackContextMenuModal`

If additional consumers exist, stop and report them before expanding. Any player consumer discovered has import-only permission: only its approved import specifier may change, with no JSX, props, state, event, audio, playback, background, gesture, animation, or lifecycle edits. No player consumers are currently expected.

## Constraints

- One bounded batch only; do not begin batch 9 or move API/cache/settings modules.
- Preserve dirty worktree changes. Do not reset, checkout, clean, overwrite, reformat, rename symbols, or fix unrelated issues.
- Keep component APIs, rendering, styles, callbacks, navigation behavior, event payloads, and app composition unchanged.
- Do not add barrels or generic utility modules; do not move Expo config, native iOS files, scripts, `dist/`, package metadata, player files, or assets.
- Preserve player appearance and behavior, including audio lifecycle, background playback, queue, lyrics, gestures, transitions, and lock-screen/Control Center behavior.

## Ownership

Junior may edit only the two listed moves and explicitly authorized import-only consumer references. Senior owns consumer-map verification, source equivalence, import graph resolution, test/build interpretation, and acceptance. Any behavior-bearing or ambiguous change must stop for coordinator review.

## Observable acceptance

- Both shared destinations exist and old source paths are removed; no unapproved files move.
- No stale imports reference removed component paths; all consumers resolve to new paths.
- Destinations equal `HEAD` originals except exact relative import substitutions required by this batch.
- `npm test -- --runInBand` passes with expected 26 suites and 299 tests.
- `npx expo export --platform ios --output-dir <temporary-directory>` resolves the iOS graph.
- `git diff --check` passes; workflow inspection confirms no native/dependency/workflow edits.
- Report changed files, exact commands/results, source equivalence, consumer audit, manual checks not claimed, and unresolved concerns. Do not claim physical-device, background-audio, lock-screen, gesture, animation, or unsigned-IPA validation unless run.

## Report

Record moved files, every import-only consumer update, stale-path and ownership audit, exact checks, workflow inspection, equivalence result, manual checks, and blockers. If accepted, update `docs/ios-refactor/04-feature-structure-report.md` to state batches 1–8 accepted and batch 9 pending; for rejection record the concern without source fixes.
