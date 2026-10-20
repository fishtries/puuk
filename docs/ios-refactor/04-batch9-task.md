# Stage 4 Batch 9 Task — Shared API, Cache, and Settings Path-Only Moves

## Target

Move only the exact files listed in one serial subtask. Execute `9a`, then accept it; execute `9b`, then accept it; execute `9c`, then accept it. Do not overlap edits to shared modules.

## Change

Perform path-only structural moves after a fresh consumer audit. Preserve all exports, APIs, auth behavior, timeout/retry/abort behavior, cache behavior, settings persistence/listener timing, DTOs, and `id`/`track_id` identity semantics. Do not begin Stage 5 event/service redesign or Stage 8 identity normalization.

## Serial 9a — API

### Move allowlist

- `utils/api.js` → `shared/api/api.js`
- `utils/__tests__/api.test.js` → `shared/api/__tests__/api.test.js`
- `utils/__tests__/apiErrorMessage.test.js` → `shared/api/__tests__/apiErrorMessage.test.js`

### Consumer/test allowlist

Update only API import, mock, and `jest.requireActual` specifiers in: `App.js`; `features/auth/LoginModal.js`; `features/auth/__tests__/LoginModal.test.js`; `features/catalog/HomeScreen.js`; `features/catalog/hooks/useTracksPagination.js`; `features/catalog/hooks/__tests__/useTracksPagination.test.js`; `features/search/SearchScreen.js`; `features/library/LibraryScreen.js`; `features/library/__tests__/LibraryScreen.test.js`; `features/library/TrackEditScreen.js`; `features/playlists/AddToPlaylistModal.js`; `features/playlists/PlaylistScreen.js`; `features/albums/AlbumScreen.js`; `features/albums/AlbumEditScreen.js`; `shared/media/CoverImage.js`; `shared/media/__tests__/coverImageUtils.test.js`; `components/fullplayer/lyrics/AppleLyricsView.js`; `components/fullplayer/lyrics/__tests__/AppleLyricsView.test.js`; `hooks/usePlayerController.js`; `hooks/__tests__/usePlayerController.test.js`.

Senior-approved import-only additions are `utils/streamUrl.js`, `utils/playbackCoordinator.js`, `utils/preloadScheduler.js`, `utils/apiCache.js`, `utils/settings.js` (`./api` → `../shared/api/api`) and `utils/__tests__/apiCache.test.js` (`../api` → `../../shared/api/api` in import/mock). No other file is owned by 9a.

## Serial 9b — Cache

### Move allowlist

- `utils/apiCache.js` → `shared/api/apiCache.js`
- `utils/__tests__/apiCache.test.js` → `shared/api/__tests__/apiCache.test.js`

### Consumer/test allowlist

Update only cache import, mock, and `jest.requireActual` specifiers in: `features/catalog/HomeScreen.js`; `features/catalog/hooks/useTracksPagination.js`; `features/catalog/hooks/__tests__/useTracksPagination.test.js`; `features/library/LibraryScreen.js`; `features/library/__tests__/LibraryScreen.test.js`.

After 9a, update the moved cache module's API import from `../shared/api/api` to `./api` because API is beside it. No other file is owned by 9b.

## Serial 9c — Settings

### Move allowlist

- `utils/settings.js` → `shared/storage/settings.js`

### Consumer/test allowlist

Update only settings import, mock, and `jest.requireActual` specifiers in: `App.js`; `navigation/MainTabs.js`; `shared/components/AppHeader.js`; `features/auth/LoginModal.js`; `features/auth/__tests__/LoginModal.test.js`; `features/search/SearchScreen.js`; `features/library/LibraryScreen.js`; `features/library/__tests__/LibraryScreen.test.js`; `features/library/TrackEditScreen.js`; `features/playlists/PlaylistScreen.js`; `hooks/usePlayerController.js`; `hooks/__tests__/usePlayerController.test.js`.

Update the moved settings module's `DEFAULT_SERVER_URL` import to `../api/api` as the required relative path to the accepted 9a destination. No other file is owned by 9c.

## Constraints

- Before each serial slice, audit the current tree and stop if any additional consumer, changed source, or ambiguity appears. Never broaden to a wildcard allowlist.
- Preserve dirty batches 1–8. Do not reset, checkout, clean, reformat, rename symbols, add wrappers/barrels/libraries, or alter package/native/workflow files.
- Preserve API/auth transport, SecureStore keys/options, auth listener cleanup/order, endpoint/DTO contracts, retry/timeout/abort/401/logout/offline behavior; cache persistence, SWR, deduplication, isolation, abort generations, invalidation, and auth-clear behavior; settings defaults/translations/snapshot/persistence/event payload/timing; last-track persistence and its `track.id` guard.
- Do not edit player implementation, App/navigation composition beyond listed import specifiers, event producers/consumers, or identity normalization.

## Ownership

The worker may edit only the current serial subtask's move files and the named import/mock consumers. Senior owns consumer-map interpretation, equivalence, and acceptance. Stop and report any behavior-bearing hunk or ambiguous consumer.

## Observable acceptance for each 9x slice

- Destination files exist, old paths are removed, and no unlisted file moves or changes.
- Destination bytes equal `HEAD` originals except exact relative import substitutions required by that slice; every export and test mock surface remains present.
- No stale imports reference removed paths; all named consumers resolve.
- Focused tests for the moved module pass, then full `npm test -- --runInBand` passes with the expected 26 suites and 299 tests.
- `npx expo export --platform ios --output-dir <new retained temporary directory>` succeeds. Do not remove prior exports.
- `git diff --check` passes. Inspect status for `.github/`, package metadata/lockfiles, native iOS, player files, and workflow changes; all must remain untouched.
- Report every changed path, exact substitutions, exhaustive named consumer audit, source equivalence, commands/results, remaining old paths, and manual checks not claimed. Physical-device, background-audio, lock-screen, gesture/animation, and unsigned-IPA checks are not claimed unless actually run.

## Report

Record each accepted serial slice separately. State whether batch 9 is complete only after 9a, 9b, and 9c all pass independently. Do not continue to Stage 5 until the coordinator accepts all three slices.

## Current progress

- Batch 9a: **accepted**.
- Batch 9b: **accepted** by Senior `nyxos-openai/gpt-6.1-sol`; implementation task `task_0b12368944a9`, review task `task_b0ab43640c81`, dispatch `ctx_70b6db734a94`.
- Batch 9c: **accepted** by Senior `nyxos-openai/gpt-6.1-sol`; independent review task `task_24adf5860200`, dispatch `ctx_dd516dcf1ce1`.

### Batch 9c Senior acceptance

The current tree satisfies the 9c contract. Exactly `utils/settings.js` moved to `shared/storage/settings.js`; the old path is absent, and the destination is byte-equivalent to `HEAD:app/ios/puuk-ios/utils/settings.js` except the required `DEFAULT_SERVER_URL` substitution from `./api` to `../api/api`. The moved file remains 187 lines with all exports, SecureStore keys/options, defaults, translations, settings event timing, and last-track `track.id` guard preserved.

The exhaustive settings audit found exactly the twelve contract consumers plus the senior-approved `utils/playbackCoordinator.js`: `App.js`, `navigation/MainTabs.js`, `shared/components/AppHeader.js`, `features/auth/LoginModal.js`, `features/auth/__tests__/LoginModal.test.js`, `features/search/SearchScreen.js`, `features/library/LibraryScreen.js`, `features/library/__tests__/LibraryScreen.test.js`, `features/library/TrackEditScreen.js`, `features/playlists/PlaylistScreen.js`, `hooks/usePlayerController.js`, `hooks/__tests__/usePlayerController.test.js`, and `utils/playbackCoordinator.js`. All changes are import/mock path substitutions only, including `./settings` → `../shared/storage/settings` in the coordinator; no unlisted settings consumers or stale `utils/settings`, `./settings`, or `../utils/settings` references remain.

Independent review evidence:

- `npm test -- --runInBand features/auth/__tests__/LoginModal.test.js hooks/__tests__/usePlayerController.test.js features/library/__tests__/LibraryScreen.test.js utils/__tests__/playbackCoordinator.test.js` — **PASS**, 4 suites / 81 tests.
- `npm test -- --runInBand` — **PASS**, 26 suites / 299 tests.
- `npx expo export --platform ios --output-dir /tmp/opencode/puuk-ios-9c-senior-export` — **PASS**, 1,586 modules / 36 assets.
- `git diff --check` — **PASS**.
- Destination equivalence, stale-import, old-path, workflow/native/dependency/package, player, and source-diff audits — **PASS** within the contract scope.

No physical-device, background-audio, lock-screen/Control Center, gesture/animation, or unsigned-IPA checks are claimed. Stage 4 batches 1–9 are now **accepted**, and the Stage 5 prerequisites are open; the exact next action is to begin the already-defined Stage 5 implementation task from the accepted design/prerequisite documents, without redesigning Stage 5 in this review.
