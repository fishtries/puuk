# Stage 4: Feature Structure Progress

**Status:** batches 1–8 accepted after independent senior review; batch 9 pending. The earlier album blocker is resolved; historical observations below are retained with their original context. No commits made.

## Acceptance prerequisite

Stage 2 device checks were confirmed by the user on iPhone 11 Pro, iOS 18.6.2, in Expo Go. See `02-app-composition-report.md`.

## Batch 1 — auth

- Moved `AppAuthGate.js`, `LoginModal.js`, `loginModalStyles.js` and their two tests from `components/` into `features/auth/`.
- Updated two imports in `App.js`, LoginModal API/settings imports, and its test imports/mocks.
- Coordinator compared all five destination files to their HEAD originals: only required import paths differ; styles and gate files are identical.
- Worker checks: focused auth tests passed (2 suites, 3 tests); full `npm test -- --runInBand` passed (26 suites, 299 tests); `npx expo export --platform ios --output-dir /tmp/puuk-ios-export-auth-7o8L5D` succeeded; `git diff --check` passed. Stale-reference audit was clean.
- Coordinator independently reran `npm test -- --runInBand`: 26 suites, 299 tests passed.

## Batch 2 — catalog

- Moved `HomeScreen.js` into `features/catalog/`, and pagination hook/test into `features/catalog/hooks/` with colocated `__tests__/`.
- Updated HomeScreen import in `navigation/MainTabs.js`, pagination import in `App.js`, and moved-file relative imports/mocks.
- Coordinator compared all three destination files to their HEAD originals and inspected App/MainTabs diffs: only import paths differ. Navigation registration and options are unchanged.
- Worker focused command: `npm test -- --runInBand features/catalog/hooks/__tests__/useTracksPagination.test.js utils/__tests__/apiCache.test.js components/__tests__/LibraryScreen.test.js` — 3 suites, 54 tests passed.
- Worker full suite: `npm test -- --runInBand` — 26 suites, 299 tests passed.
- `npx expo export --platform ios --output-dir /tmp/opencode/puuk-ios-stage4-batch2-export` succeeded. `git diff --check` passed; no stale catalog imports found.
- Coordinator independently reran the full suite: 26 suites, 299 tests passed.
- Detailed worker report: `/tmp/opencode/puuk-ios-stage4-batch2-report.md` (temporary local artifact).

## Remaining work and verification

- Next: isolated bounded batch 7, CoverImage and its test, after coordinator handoff and a fresh dirty-tree/import-consumer inspection. Preserve accepted batches 1–6; do not repeat their moves. Batches 8–9 remain pending.
- No player implementation, audio lifecycle, background, native, dependency, or build configuration edits were included in batches 1–6. App/navigation changes are import-only.
- Current independent senior validation includes full Jest and Expo iOS export; no new physical-device run, native unsigned IPA build, or GitHub Actions run was performed. The Stage 2 device confirmation remains historical evidence only.
- `.github/workflows/build-ios-unsigned.yml` exists locally and was inspected during senior review. The earlier search missed it. It uses macOS 26, Node 22, `npm ci`, the existing Expo Audio patch, Expo prebuild, CocoaPods, unsigned `xcodebuild archive`, and IPA artifact packaging; no workflow changes were needed.

## Orca accounting

- Run: `run_942ddf241d65`.
- Batch 1: `task_705e397db071`, `ctx_432942e6a809`, succeeded and reviewed.
- Batch 2: `task_9111f30bd3ba`, `ctx_f98b0f22ebc8`, succeeded and reviewed.
- Both completion deliveries acknowledged. Release requested for both workers; Orca retained their terminals as `user_owned` / `user_takeover`, with no process action. No reclaimable resources remained.

## Historical current-session audit (album blocker subsequently resolved)

The observations and unaccepted statuses in this historical section describe the pre-recovery tree. They are superseded by the independent senior acceptance section below.

**Audit timestamp / session:** Run `run_5e427d2525ad`, Task `task_0d107a52e36b`, Dispatch `ctx_8ab059e70f57`.  
**Model / role:** Junior explicitly Gemini `antigravity-manager/gemini-3.8-flash`.  
**Terminal handles:** Worker `term_4525f905-7288-42af-a469-36e3bf6a3b01`, Coordinator `term_50062568-9b7e-4399-8628-3b535608ab62`.

### 1. Distinction: Accepted vs. Moved (Unaccepted)

- **Batches 1–2 (Accepted):**
  - **Batch 1 (Auth):** `AppAuthGate.js`, `LoginModal.js`, `loginModalStyles.js`, and tests moved to `features/auth/`. Accepted by coordinator.
  - **Batch 2 (Catalog):** `HomeScreen.js` moved to `features/catalog/`; `useTracksPagination.js` and tests moved to `features/catalog/hooks/`. Accepted by coordinator.
- **Batches 3–5 (Moved on disk, NOT yet accepted):**
  - **Batch 3 (Search):** `SearchScreen.js` moved to `features/search/SearchScreen.js`; `navigation/MainTabs.js` updated. Verified present on disk; unaccepted.
  - **Batch 4a (Library):** `LibraryScreen.js` and its test moved to `features/library/`; `navigation/MainTabs.js` updated. Verified present on disk; unaccepted.
  - **Batch 4b (Track Edit):** `TrackEditScreen.js` and `trackEditScreenStyles.js` moved to `features/library/`; `navigation/RootNavigator.js` updated. Verified present on disk; unaccepted.
  - **Batch 5 (Playlists):** `PlaylistScreen.js` and `AddToPlaylistModal.js` moved to `features/playlists/`; `App.js` and `navigation/RootNavigator.js` updated. Verified present on disk; unaccepted.
- **Batch 6 (Albums) — BLOCKED / Incomplete:**
  - `components/AlbumScreen.js` and `components/AlbumEditScreen.js` are deleted from `components/` in git working tree.
  - Destinations `features/albums/AlbumScreen.js` and `features/albums/AlbumEditScreen.js` do not exist.
  - Directory `app/ios/puuk-ios/features/albums` exists but is completely empty.
  - `navigation/RootNavigator.js` still contains stale imports from deleted paths: `import AlbumScreen from '../components/AlbumScreen';` and `import AlbumEditScreen from '../components/AlbumEditScreen';`.
- **Batches 7–9 (CoverImage, AppHeader/TrackContextMenuModal, Shared API/Storage):** Not started.

### 2. Independent Filesystem and Git Status Verification

Direct verification by worker against `app/ios/puuk-ios/` and git status:
- `git status --short app/ios/puuk-ios`:
  - `M app/ios/puuk-ios/App.js` (imports Auth, Catalog, Playlists)
  - `M app/ios/puuk-ios/navigation/MainTabs.js` (imports Catalog, Search, Library)
  - `M app/ios/puuk-ios/navigation/RootNavigator.js` (imports Playlists, Library; still imports deleted `components/AlbumScreen` and `components/AlbumEditScreen`)
  - `D app/ios/puuk-ios/components/AddToPlaylistModal.js`
  - `D app/ios/puuk-ios/components/AlbumEditScreen.js` (deleted without destination file)
  - `D app/ios/puuk-ios/components/AlbumScreen.js` (deleted without destination file)
  - `D app/ios/puuk-ios/components/AppAuthGate.js`
  - `D app/ios/puuk-ios/components/HomeScreen.js`
  - `D app/ios/puuk-ios/components/LibraryScreen.js`
  - `D app/ios/puuk-ios/components/LoginModal.js`
  - `D app/ios/puuk-ios/components/PlaylistScreen.js`
  - `D app/ios/puuk-ios/components/SearchScreen.js`
  - `D app/ios/puuk-ios/components/TrackEditScreen.js`
  - `D app/ios/puuk-ios/components/__tests__/AppAuthGate.test.js`
  - `D app/ios/puuk-ios/components/__tests__/LibraryScreen.test.js`
  - `D app/ios/puuk-ios/components/__tests__/LoginModal.test.js`
  - `D app/ios/puuk-ios/components/loginModalStyles.js`
  - `D app/ios/puuk-ios/components/trackEditScreenStyles.js`
  - `D app/ios/puuk-ios/hooks/__tests__/useTracksPagination.test.js`
  - `D app/ios/puuk-ios/hooks/useTracksPagination.js`
  - `?? app/ios/puuk-ios/features/` (contains `auth/`, `catalog/`, `search/`, `library/`, `playlists/`, and empty `albums/`)
- Verified `app/ios/puuk-ios/features/albums/` contains 0 files.
- `git diff --check`: PASSED cleanly (zero whitespace errors or merge marker conflicts).

### 3. Senior Verification (Senior-Reported)

- Jest test suite: **Senior-reported full suite pass: 26 suites, 299 tests passed** (confirmed via escalation inquiry to coordinator). Note: marked strictly as senior-reported per orchestration protocol; Jest was not independently re-run in this documentation-only junior dispatch to avoid churn or concurrent test interference.

### 4. Blocker Statement: Stage 4 Blocked

Stage 4 is explicitly **BLOCKED** pending user explanation and decision regarding the unexpected deletion of album screen files:
- `app/ios/puuk-ios/components/AlbumScreen.js` and `app/ios/puuk-ios/components/AlbumEditScreen.js` were deleted without their target files being created at `features/albums/`.
- `navigation/RootNavigator.js` continues to import the nonexistent `../components/AlbumScreen` and `../components/AlbumEditScreen`.
- Under the **README non-negotiable constraint at line 16** ("Existing uncommitted changes are user work and part of the starting tree. Never reset, checkout, clean, or overwrite them. Inspect status and diffs before every stage; stop if the stage overlaps with unexpected concurrent edits.") and the **Stage 4 Constraints text at line 19** ("Preserve all dirty worktree changes. Stop if a source file differs from the approved map or has concurrent edits not included in the task context."):
  - Workers must not autonomously restore, recreate, revert, or check out deleted files.
  - Stage 4 cannot proceed to batch acceptance or further moves until the user clarifies the intent regarding the deleted album screens.

### 5. Session and Orca Accounting

- **Current Session Run:** `run_5e427d2525ad`
- **Task:** `task_0d107a52e36b`
- **Dispatch:** `ctx_8ab059e70f57`
- **Model:** `antigravity-manager/gemini-3.8-flash` (explicitly Junior role)
- **Historical Batches Recorded:**
  - Batch 1 (Auth): Run `run_942ddf241d65`, Task `task_705e397db071`, Dispatch `ctx_432942e6a809` (accepted)
  - Batch 2 (Catalog): Run `run_942ddf241d65`, Task `task_9111f30bd3ba`, Dispatch `ctx_f98b0f22ebc8` (accepted)
  - Batch 3 (Search): Task `task_99d14668df21`, Dispatch `ctx_7018fe187ddf` (moved, pending review/acceptance)
  - Batch 4a (Library Screen): Task `task_92c7f15ab111`, Dispatch `ctx_21b40821d7f9` (moved, pending review/acceptance)
  - Batch 4b (Track Edit): Task `task_a8167220498e`, Dispatch `ctx_31f31faa9897` (moved, pending review/acceptance)
  - Batch 5 (Playlists): Artifact `/tmp/opencode/puuk-stage4-batch5-report.md` (moved, pending review/acceptance)
  - Batch 6 (Albums): Incomplete / blocked by missing files.

## Batch 6 — albums recovery and implementation (worker report; subsequently accepted below)

**User authorization:** The user explicitly authorized recovering the missing album screens from HEAD at approved feature destinations under bounded batch 6.

### Changed files
- Created `app/ios/puuk-ios/features/albums/AlbumScreen.js` from HEAD `components/AlbumScreen.js` with only two relative import substitutions:
  - `import CoverImage from './CoverImage';` → `import CoverImage from '../../components/CoverImage';`
  - `import { authFetch } from '../utils/api';` → `import { authFetch } from '../../utils/api';`
- Created `app/ios/puuk-ios/features/albums/AlbumEditScreen.js` from HEAD `components/AlbumEditScreen.js` with only two relative import substitutions:
  - `import CoverImage from './CoverImage';` → `import CoverImage from '../../components/CoverImage';`
  - `import { authFetch, parseApiErrorMessage } from '../utils/api';` → `import { authFetch, parseApiErrorMessage } from '../../utils/api';`
- Updated `app/ios/puuk-ios/navigation/RootNavigator.js`:
  - `import AlbumScreen from '../components/AlbumScreen';` → `import AlbumScreen from '../features/albums/AlbumScreen';`
  - `import AlbumEditScreen from '../components/AlbumEditScreen';` → `import AlbumEditScreen from '../features/albums/AlbumEditScreen';`
- Preserved deleted status of `components/AlbumScreen.js` and `components/AlbumEditScreen.js`. No commits or reset performed.

### Verification and observable acceptance
1. **HEAD comparison assertion:** Both destination files compared byte-for-byte against HEAD originals via python assertion; identical except for exact allowed relative import substitutions. Zero behavior, styling, JSX, or state changes.
2. **Stale reference audit:** Grep for `components/Album` in `app/ios/puuk-ios` returned zero matches. RootNavigator is the sole consumer importing both screens at `features/albums/`.
3. **Jest test suite:** `npm test -- --runInBand` in `app/ios/puuk-ios` passed: 26 suites, 299 tests passed, 0 snapshots (3.345s).
4. **Expo iOS export:** `npx expo export --platform ios --output-dir /tmp/opencode/ios-stage4-batch6-export` succeeded: 1,586 modules bundled in 7,603ms; Hermes bytecode bundle `_expo/static/js/ios/index-0397a2c89b7af25e8fa5ab9e61345ed6.hbc` (4.2MB) and 36 assets generated cleanly.
5. **Diff check:** `git diff --check` passed cleanly from repository root.

### Status and next steps
At worker completion, bounded batch 6 was complete on disk and awaiting review. Independent senior acceptance of batches 3–6 is recorded below; Stage 4 remains incomplete until batches 7–9 are accepted.

### Session accounting
- Run: `run_5e427d2525ad`
- Task: `task_047d3049d2c8`
- Dispatch: `ctx_ccb49abc27dc`
- Role: Junior Gemini `antigravity-manager/gemini-3.8-flash`
- Terminal: `term_4525f905-7288-42af-a469-36e3bf6a3b01`

## Independent senior acceptance — batches 3–6

**Reviewer:** Senior `nyxos-openai/gpt-6.1-sol`, Run `run_5e427d2525ad`, Task `task_e53288599e07`, Dispatch `ctx_3bfd1fcd19bb`.

### Decision and source comparison

- **Accept batch 3 (search), batch 4a (library), batch 4b (track editor), batch 5 (playlists), and batch 6 (albums)** as behavior-preserving structural moves. Batches 1–2 remain accepted; batches 7–9 are pending. Current review does not retroactively establish that the original batch 4a/4b dispatch sequencing gate occurred.
- Independently compared all **17** current feature destination files with their matching `HEAD` originals, inspected every unified diff, and asserted equality after normalizing relative specifiers. Only required import, mock, and `jest.requireActual` path changes exist. Gate/auth styles/gate test/track-editor styles are byte-identical. No JSX, styling, text, component API, event payload, subscriptions, or state changes were observed.
- Search: `components/SearchScreen.js` → `features/search/SearchScreen.js`; library: `components/LibraryScreen.js` and its test → `features/library/` with matching test folder; track editor and styles → `features/library/`; playlist screen and modal → `features/playlists/`. Changes are only CoverImage/API/cache/settings import depth and library test import/mock paths.
- Independently asserted exact album equality using `git show HEAD:app/ios/puuk-ios/components/AlbumScreen.js` and the corresponding `AlbumEditScreen.js`: each destination equals its HEAD original after exactly `./CoverImage` → `../../components/CoverImage` and `../utils/api` → `../../utils/api` in import clauses. The user-authorized recovery therefore contains no other changes; the missing-destination blocker is resolved.
- App.js has only four moved-module import substitutions. MainTabs has only the Home/Search/Library import substitutions. RootNavigator has only Album/AlbumEdit/Playlist/TrackEdit import substitutions; all destinations exist and resolve. Route names, params, options, registrations and callbacks are unchanged.
- Independently checked tracked diffs for player components/background, usePlayerController, utilities/audio services, native iOS, workflow and package/lockfile paths: no changes. Player presentation, audio lifecycle and background implementation remain the source baseline.

### Independent commands and results

Commands ran in `app/ios/puuk-ios/` unless stated otherwise:

1. `npm test -- --runInBand` — **PASS**, 26 suites, 299 tests, 0 snapshots (3.390s). Expected negative-case warnings appeared; no failures.
2. `npx expo export --platform ios --output-dir /tmp/opencode/ios-stage4-batch6-senior-export` — **PASS**, 1,586 modules bundled (7,343ms), 36 assets including the unchanged default cover, Hermes bundle `_expo/static/js/ios/index-0397a2c89b7af25e8fa5ab9e61345ed6.hbc` (4.2MB). This independently resolves the production album/navigation graph previously missed by Jest alone.
3. `git diff --check` from repository root — **PASS**, exit 0, no output. This check covers tracked diffs; new destination correctness was separately checked by full comparisons and export.
4. Python read-only comparisons using `git show HEAD:<original>` — **PASS** for all 17 destinations, plus exact authorized album substitutions as described above.
5. Stale-path audit across **72 handwritten JS files** (features/components/hooks/navigation/utils and App.js), resolving relative string specifiers against the actual removed-path set from `git diff --diff-filter=D` — **PASS**, no specifier resolves to removed source/test paths. The initial broad pagination search also matched the valid `features/catalog/hooks/useTracksPagination` path; that is not a stale old hook reference.
6. Direct inspection of `.github/workflows/build-ios-unsigned.yml` — present, build sequence unchanged, no workflow/native/dependency edits required.

### Remaining acceptance scope

- No new physical-iPhone, background playback, lock-screen/Control Center, gesture/animation equivalence or standalone IPA validation is claimed. Automated tests/export and source equivalence support this structural acceptance; they do not replace device/native checks for later player-touching stages.
- Next dispatch is **batch 7 only**: move CoverImage/test with exact production import and Jest mock consumers rechecked against the current tree, now including both recovered album screens. Keep `assets/default_cover.jpg` in place and use `require('../../assets/default_cover.jpg')` from `shared/media/CoverImage.js`; the moved test API import becomes `../../../utils/api`.
- AppHeader has both MainTabs and catalog HomeScreen as direct import consumers; recheck both before batch 8. API/cache/settings fan-out must be mapped afresh for dedicated batch 9, with no Stage 5 behavior/ownership redesign mixed in.
- Preserve the existing dirty tree. This senior task changed only this progress report and produced a temporary Expo export; it made no source fixes, commits, reset, or cleanup.

## Independent senior acceptance — batch 7 CoverImage

**Reviewer:** Senior `nyxos-openai/gpt-6.1-sol`, dispatched task `task_23b44bae05ee`, dispatch `ctx_d0462ff6f498`. Gemini batch task `task_8b871a8f4704` / `ctx_9ad2642d6d37` completed successfully.

### Decision

- **Accept batch 7** as a behavior-preserving structural move. Batches 1–7 are accepted; batches 8–9 remain pending.
- Moved `components/CoverImage.js` to `shared/media/CoverImage.js` and its test to `shared/media/__tests__/coverImageUtils.test.js`.
- Updated only approved CoverImage production/test specifiers. The moved component uses `../../assets/default_cover.jpg`, the moved test uses `../../../utils/api`, and the asset remains in place.
- Both moved files equal their `HEAD` originals except exact approved relative paths. No rendering, API, audio, playback, queue, background, native, dependency, package, or workflow behavior changed.

### Independent commands and results

Commands ran in `app/ios/puuk-ios/` unless stated otherwise:

1. `npm test -- --runInBand` — **PASS**, 26 suites, 299 tests, 0 snapshots.
2. `rm -rf /tmp/puuk-ios-stage4-batch7-senior-export && npx expo export --platform ios --output-dir /tmp/puuk-ios-stage4-batch7-senior-export` — **PASS**, 1,586 modules, 36 assets including `assets/default_cover.jpg`, Hermes bundle emitted. Expo forcefully exited after export completion, with the export directory complete.
3. `git diff --check` from repository root — **PASS**, exit 0.
4. Python `git show HEAD:<path>` equivalence assertions — **PASS** for both moved files after only approved asset/API/test path substitutions.
5. Targeted stale-path and destination audit — **PASS**; no stale CoverImage paths, and asset/destinations exist. A first broad recursive script traversed `node_modules/decimal.js` as a directory; this was a tooling-script issue, not a source/export failure.
6. Direct inspection of `.github/workflows/build-ios-unsigned.yml` — **PASS**, unsigned workflow unchanged (Node 22, `npm ci`, Expo Audio patch, prebuild, CocoaPods, unsigned archive, IPA packaging).

### Manual checks and remaining concerns

- No new physical-iPhone, background-playback, lock-screen/Control Center, gesture/animation, or standalone unsigned IPA check is claimed.
- Batch 8 must re-audit `AppHeader` and `TrackContextMenuModal` consumers before moving them. Current direct consumers are `features/catalog/HomeScreen.js` and `navigation/MainTabs.js` for `AppHeader`, and `App.js` for `TrackContextMenuModal`; only import-specifier changes are authorized.

## Independent senior acceptance — batch 8

**Reviewer:** Senior `nyxos-openai/gpt-6.1-sol`, dispatched task `task_8cde6aa6b4a8`, dispatch `ctx_e475ab86fb93`. The implementation report is `04-batch8-implementation-report.md` for worker task `task_699adf94cb22` / dispatch `ctx_fe136bf26c94`.

### Decision

- **Accept batch 8** as a behavior-preserving structural move. Batches 1–8 are accepted; batch 9 is pending.
- Moved exactly `components/AppHeader.js` → `shared/components/AppHeader.js` and `components/TrackContextMenuModal.js` → `shared/components/TrackContextMenuModal.js`.
- The fresh consumer audit found exactly three production import updates: `features/catalog/HomeScreen.js`, `navigation/MainTabs.js`, and `App.js`. No player consumer, test consumer, or unlisted consumer was found.
- Source comparison against `HEAD` confirms `TrackContextMenuModal.js` is byte-identical and `AppHeader.js` differs only by the required `../utils/settings` → `../../utils/settings` import-depth substitution. JSX, styles, props, callbacks, settings event behavior, and component APIs are unchanged.

### Independent checks and evidence

1. `npm test -- --runInBand` — **PASS**, 26 suites and 299 tests passed, 0 snapshots.
2. `npx expo export --platform ios --output-dir /tmp/opencode/puuk-ios-batch8-senior-export` — **PASS**, 1,586 modules bundled, 36 assets emitted, Hermes iOS bundle generated. The requested export directory was retained.
3. `git diff --check` — **PASS**, no whitespace or conflict-marker errors.
4. HEAD equivalence and moved-path check — **PASS** for both destinations; old source paths are absent. The implementation report's byte-comparison assertions were independently reviewed against the current tree.
5. Stale import audit — **PASS**: current handwritten JavaScript contains only the three new shared component specifiers; no `components/AppHeader` or `components/TrackContextMenuModal` stale path remains. The earlier accepted batch move paths remain absent from import consumers.
6. App/Home/MainTabs audit — **PASS**: `App.js`, `features/catalog/HomeScreen.js`, and `navigation/MainTabs.js` changes are import-only for this batch; route registration and composition behavior are unchanged.
7. Native/dependency/workflow audit — **PASS**: no status entries under `.github/`, package metadata, lockfiles, or `app/ios/puuk-ios/ios`.

### Manual checks not claimed

No physical-iPhone, background-playback, lock-screen/Control Center, gesture/animation equivalence, or unsigned-IPA native build check is claimed. The automated suite and Expo export establish import/build resolution but do not replace those manual/native checks.

## Batch 9 — pending: exact shared API/cache/settings path-only move

Batch 9 is a fresh-audit, path-only Stage 4 task. It must preserve API/auth transport, retry/timeout/abort, cache persistence/SWR/deduplication/invalidation, settings persistence/listener timing, last-track guards, DTOs, and identity semantics exactly. It must not begin Stage 5 event/service redesign, Stage 8 identity normalization, add wrappers/barrels/libraries, or redesign any module. Execute serially as **9a → 9b → 9c**, accepting each slice before starting the next; no overlapping edits to shared modules.

### Serial 9a — API module and tests

Move exactly:

- `utils/api.js` → `shared/api/api.js`
- `utils/__tests__/api.test.js` → `shared/api/__tests__/api.test.js`
- `utils/__tests__/apiErrorMessage.test.js` → `shared/api/__tests__/apiErrorMessage.test.js`

Update only import/mock specifiers in these named consumers/tests: `App.js`, `features/auth/LoginModal.js`, `features/auth/__tests__/LoginModal.test.js`, `features/catalog/HomeScreen.js`, `features/catalog/hooks/useTracksPagination.js`, `features/catalog/hooks/__tests__/useTracksPagination.test.js`, `features/search/SearchScreen.js`, `features/library/LibraryScreen.js`, `features/library/__tests__/LibraryScreen.test.js`, `features/library/TrackEditScreen.js`, `features/playlists/AddToPlaylistModal.js`, `features/playlists/PlaylistScreen.js`, `features/albums/AlbumScreen.js`, `features/albums/AlbumEditScreen.js`, `shared/media/CoverImage.js`, `shared/media/__tests__/coverImageUtils.test.js`, `components/fullplayer/lyrics/AppleLyricsView.js`, `components/fullplayer/lyrics/__tests__/AppleLyricsView.test.js`, `hooks/usePlayerController.js`, and `hooks/__tests__/usePlayerController.test.js`. Senior-approved import-only additions are `utils/streamUrl.js`, `utils/playbackCoordinator.js`, `utils/preloadScheduler.js`, `utils/apiCache.js`, `utils/settings.js` (`./api` → `../shared/api/api`) and `utils/__tests__/apiCache.test.js` (`../api` → `../../shared/api/api` in import/mock). No other file is allowlisted for 9a.

### Serial 9b — cache module and test

Move exactly:

- `utils/apiCache.js` → `shared/api/apiCache.js`
- `utils/__tests__/apiCache.test.js` → `shared/api/__tests__/apiCache.test.js`

Update only cache import/mock/`jest.requireActual` specifiers in these named consumers/tests: `features/catalog/HomeScreen.js`, `features/catalog/hooks/useTracksPagination.js`, `features/catalog/hooks/__tests__/useTracksPagination.test.js`, `features/library/LibraryScreen.js`, and `features/library/__tests__/LibraryScreen.test.js`. Update the moved `shared/api/apiCache.js` internal API import from `../shared/api/api` to `./api` after the accepted 9a move; no API behavior or export changes. No other file is allowlisted for 9b.

### Serial 9c — settings storage module

Move exactly:

- `utils/settings.js` → `shared/storage/settings.js`

Update only settings import specifiers in these named consumers/tests: `App.js`, `navigation/MainTabs.js`, `shared/components/AppHeader.js`, `features/auth/LoginModal.js`, `features/auth/__tests__/LoginModal.test.js`, `features/search/SearchScreen.js`, `features/library/LibraryScreen.js`, `features/library/__tests__/LibraryScreen.test.js`, `features/library/TrackEditScreen.js`, `features/playlists/PlaylistScreen.js`, `hooks/usePlayerController.js`, and `hooks/__tests__/usePlayerController.test.js`. Update the moved module's `DEFAULT_SERVER_URL` import to `../api/api` only as the required relative path to the accepted 9a destination. The pre-move audit additionally requires `utils/playbackCoordinator.js` (`./settings` → `../shared/storage/settings`) because it is an actual consumer. No other file is allowlisted for 9c.

### Batch 9a senior acceptance audit — accepted coordinator record

Independent Senior (, task , dispatch ) reviewed the 9a implementation and current worktree. The six coordinator-approved consumers are explicitly limited to , , , , , and , with exact substitutions recorded in ; no source edits are authorized beyond those path changes.

Senior evidence: moved API files are byte-equivalent to HEAD originals; diff check passes; no workflow, dependency, or native changes; full Jest passes (26 suites / 299 tests); Expo export passes to retained  (1,586 modules, 36 assets). Stale audit found exact five 9b cache consumers and exact twelve listed 9c settings consumers plus actual ; 9b must change moved apiCache import  to , and 9c must update playbackCoordinator  to . Manual device, background audio, lock-screen/Control Center, gesture/animation, and unsigned-IPA checks are not claimed.


### Batch 9 contract and acceptance

- Before each slice, rerun the named consumer audit against the current tree and stop if any additional consumer, changed source, or ambiguity appears. Do not use wildcard ownership.
- Destinations must equal their `HEAD` originals except exact relative import-depth substitutions; old paths must be removed and no unlisted file may move or change.
- Preserve every existing export and test mock surface. Preserve auth listener Set/callback isolation/ordering, SecureStore keys/options, `authFetch` endpoint/header/body/retry/timeout/abort/401 behavior, cache user/server isolation/SWR/deduplication/abort generations/auth-clear hook, settings default merge/translations/snapshot/persistence/event payload/timing, and last-track `track.id` guard.
- After each slice run focused tests for the moved module, then `npm test -- --runInBand`, `npx expo export --platform ios --output-dir <new retained temporary directory>`, and `git diff --check`. Audit stale old imports and inspect `.github/`, package metadata, lockfiles, native iOS, player files, and workflow status.
- Report every changed path, exact import substitutions, full named consumer audit, equivalence result, commands/results, remaining old paths, and manual checks not claimed. Do not claim device, background audio, lock-screen, gesture/animation, or unsigned-IPA validation unless actually performed.

### Batch 9b Senior acceptance — accepted

Independent Senior reviewer: `nyxos-openai/gpt-6.1-sol` (task `task_b0ab43640c81`, dispatch `ctx_70b6db734a94`; review target implementation task `task_0b12368944a9`, dispatch `ctx_971e144b02db`).

The current tree satisfies the 9b contract. Exactly the two cache files moved to `shared/api/`, and both destinations are byte-for-byte identical to their `HEAD` originals. The moved cache module uses the accepted sibling API import `./api`; the moved cache test retains the local `../api` import and all exports/mocks. The old `utils/apiCache.js` and `utils/__tests__/apiCache.test.js` paths are absent, and no stale `utils/apiCache` imports remain in handwritten iOS source.

The exhaustive current consumer audit found exactly the five allowlisted cache consumers and no others: `features/catalog/HomeScreen.js`, `features/catalog/hooks/useTracksPagination.js`, `features/catalog/hooks/__tests__/useTracksPagination.test.js`, `features/library/LibraryScreen.js`, and `features/library/__tests__/LibraryScreen.test.js`. Their changes are import/mock/`jest.requireActual` path substitutions only; no cache source behavior, API surface, persistence, SWR, deduplication, isolation, abort generation, invalidation, or auth-clear behavior changed.

Evidence recorded for this independent review:

- `npm test -- --runInBand shared/api/__tests__/apiCache.test.js features/catalog/hooks/__tests__/useTracksPagination.test.js features/library/__tests__/LibraryScreen.test.js` — **PASS**, 3 suites / 54 tests.
- `npm test -- --runInBand` — **PASS**, 26 suites / 299 tests.
- `npx expo export --platform ios --output-dir /tmp/opencode/puuk-ios-9b-senior-export` — **PASS**, 1,586 modules / 36 assets.
- `git diff --check` — **PASS**.
- Native, dependency, package, and workflow audit — **PASS**, no changes under `.github/`, package metadata/lockfiles, or `app/ios/puuk-ios/ios`.
- Destination-vs-`HEAD` byte comparison — **PASS** for both moved cache files; no source behavior changes were observed.

Batch 9 status at the time of the 9b review was **9a accepted, 9b accepted, 9c pending**. The next exact 9c consumer correction was required to include `utils/playbackCoordinator.js` (`./settings` → `../shared/storage/settings`) in addition to the twelve settings consumers named in the contract; no manual device, audio, lock-screen/Control Center, gesture/animation, or unsigned-IPA claims were made.

### Batch 9c Senior acceptance — accepted

Independent Senior reviewer: `nyxos-openai/gpt-6.1-sol` (task `task_24adf5860200`, dispatch `ctx_dd516dcf1ce1`; review target implementation task `task_c3ad70bc32d0`, dispatch `ctx_1b4a61dc74ff`).

The current tree satisfies the 9c contract. Exactly `utils/settings.js` moved to `shared/storage/settings.js`; the old path is absent, and the destination is byte-equivalent to `HEAD:app/ios/puuk-ios/utils/settings.js` except the required `DEFAULT_SERVER_URL` substitution from `./api` to `../api/api`. The moved file remains 187 lines with all exports, SecureStore keys/options, defaults, translations, settings event timing, and last-track `track.id` guard preserved.

The exhaustive settings audit found exactly the twelve contract consumers plus the senior-approved `utils/playbackCoordinator.js`: `App.js`, `navigation/MainTabs.js`, `shared/components/AppHeader.js`, `features/auth/LoginModal.js`, `features/auth/__tests__/LoginModal.test.js`, `features/search/SearchScreen.js`, `features/library/LibraryScreen.js`, `features/library/__tests__/LibraryScreen.test.js`, `features/library/TrackEditScreen.js`, `features/playlists/PlaylistScreen.js`, `hooks/usePlayerController.js`, `hooks/__tests__/usePlayerController.test.js`, and `utils/playbackCoordinator.js`. All changes are import/mock path substitutions only, including `./settings` → `../shared/storage/settings` in the coordinator; no unlisted settings consumers or stale `utils/settings`, `./settings`, or `../utils/settings` references remain.

Independent review evidence:

- Focused settings/auth/player Jest command — **PASS**, 4 suites / 81 tests.
- `npm test -- --runInBand` — **PASS**, 26 suites / 299 tests.
- `npx expo export --platform ios --output-dir /tmp/opencode/puuk-ios-9c-senior-export` — **PASS**, 1,586 modules / 36 assets.
- `git diff --check` — **PASS**.
- Destination equivalence, stale-import, old-path, workflow/native/dependency/package, player, and source-diff audits — **PASS** within the contract scope.

No physical-device, background-audio, lock-screen/Control Center, gesture/animation, or unsigned-IPA checks are claimed. Stage 4 batches 1–9 are now **accepted**, and the Stage 5 prerequisites are open; the exact next action is to begin the already-defined Stage 5 implementation task from the accepted design/prerequisite documents, without redesigning Stage 5 in this review.
