# Stage 3: Approved Feature Move Map

**Status:** map approved; Stage 2 accepted after user-confirmed checks on iPhone 11 Pro, iOS 18.6.2, in Expo Go. Stage 4 bounded batches are authorized.

## Target and boundaries

This map covers current handwritten JavaScript source and tests in `app/ios/puuk-ios/`. Expo configuration, native files, scripts, dependencies, generated `dist/`, and package metadata stay in place. Stage 4 must not move player implementation until Stage 6/7; player files are mapped here for ownership clarity only. The player background implementation is an accepted baseline and is not a relocation target in the first Stage 4 batch.

### Proposed tree

```text
app/
  App.js
  index.js
  features/
    auth/
    catalog/
    search/
    library/
    playlists/
    albums/
    player/                 # deferred until Stage 6/7
  navigation/
  shared/
    api/
    storage/
    media/
    components/
    utils/
```

Only create directories when the corresponding move batch lands real files. Do not create hypothetical `artists` or `drawing` features.

## File ownership and destinations

Paths below are relative to `app/ios/puuk-ios/`. Test files move with their source unless marked otherwise. Stage 4 import updates include production imports, test imports/mocks, and path-based test descriptions where applicable.

| Current path(s) | Destination | Owner and rationale | Shared evidence / import updates | Risk and verification |
|---|---|---|---|---|
| `App.js`, `index.js` | unchanged | App composition and Expo entry point | Root imports feature/navigation public paths; `index.js` remains stable | High coupling; do not move or change in Stage 4 |
| `navigation/RootNavigator.js`, `navigation/MainTabs.js` | unchanged | Navigation owns screen registration, tab actions, and routes | Consumes public screen components from catalog/search/library/playlists/albums | Keep screen names, options, params, and event behavior unchanged |
| `components/AppAuthGate.js`, `components/__tests__/AppAuthGate.test.js` | `features/auth/AppAuthGate.js`, `features/auth/__tests__/AppAuthGate.test.js` | Auth gate owns startup loading/signed-out UI | `App.js` imports gate; gate imports LoginModal; test imports both | Auth gate test and lint; preserve loading and login callback behavior |
| `components/LoginModal.js`, `components/loginModalStyles.js`, `components/__tests__/LoginModal.test.js` | `features/auth/LoginModal.js`, `features/auth/loginModalStyles.js`, `features/auth/__tests__/LoginModal.test.js` | Authentication UI and its local styles | AppAuthGate and App import LoginModal; imports shared API and settings | Auth/login tests; preserve auth events and styling |
| `utils/api.js`, `utils/__tests__/api.test.js`, `utils/__tests__/apiErrorMessage.test.js` | `shared/api/api.js`, `shared/api/__tests__/api.test.js`, `shared/api/__tests__/apiErrorMessage.test.js` | Transport, auth persistence/listeners, server URL configuration | Used across App, auth, navigation, screens, player services/hooks, cache/settings | High fan-out; first API move batch should be independent and run all tests plus Expo export |
| `utils/apiCache.js`, `utils/__tests__/apiCache.test.js` | `shared/api/apiCache.js`, `shared/api/__tests__/apiCache.test.js` | Shared catalog/track request cache | Used by catalog, library, pagination hook and tests; imports shared API | Run cache, pagination, library and full tests |
| `utils/settings.js` | `shared/storage/settings.js` | Persistent settings and settings notifications | Used by App, navigation, auth, screens and player; imports shared API | Broad fan-out and DeviceEventEmitter contract; verify settings listeners and app tests |
| `utils/audioCache.js`, `utils/__tests__/audioCache.test.js` | `features/player/services/audioCache.js`, `features/player/services/__tests__/audioCache.test.js` (deferred) | Player-owned audio cache/lifecycle | Used by App, player hook/coordinator/preload scheduler | Defer to Stage 6/7; do not move in Stage 4 |
| `utils/playbackCoordinator.js`, `utils/__tests__/playbackCoordinator.test.js` | `features/player/services/playbackCoordinator.js`, matching `__tests__` (deferred) | Playback orchestration | Used by player hook; consumes audio cache, preload, stream, API/settings, and CoverImage | Defer to Stage 6/7; lifecycle-sensitive |
| `utils/preloadScheduler.js`, `utils/__tests__/preloadScheduler.test.js` | `features/player/services/preloadScheduler.js`, matching `__tests__` (deferred) | Player preloading | Used by playback coordinator and player tests; consumes shared API/network/stream/cache | Defer to Stage 6/7 |
| `utils/loudnessNormalization.js`, `utils/__tests__/loudnessNormalization.test.js` | `features/player/services/loudnessNormalization.js`, matching `__tests__` (deferred) | Playback-specific volume policy | Consumed by player coordinator/hook | Defer to Stage 6/7; preserve original media files and normalization behavior |
| `utils/streamUrl.js`, `utils/__tests__/streamUrl.test.js` | `features/player/services/streamUrl.js`, matching `__tests__` (deferred) | Player stream URL policy | Used by preload and playback coordinator; depends on API server configuration | Defer to Stage 6/7 |
| `utils/networkPolicy.js`, `utils/__tests__/networkPolicy.test.js` | `features/player/services/networkPolicy.js`, matching `__tests__` (deferred) | Playback network policy | Consumed by preload scheduler | Defer to Stage 6/7 |
| `utils/lrcParser.js`, `utils/__tests__/lrcParser.test.js` | `features/player/lyrics/lrcParser.js`, matching `__tests__` (deferred) | Player lyrics parsing | Lyrics view/player tests are its consumers | Defer with player; line-level LRC remains the contract |
| `utils/boundaryGeometry.js`, `utils/__tests__/boundaryGeometry.test.js` | `features/player/services/boundaryGeometry.js`, matching `__tests__` (deferred) | Player transition geometry | Used by player boundary visuals/gestures | Defer to Stage 6/7; preserve transitions |
| `utils/__tests__/lockScreenControls.test.js` | `features/player/integration/__tests__/lockScreenControls.test.js` (deferred) | Player/native integration verification | Verifies the player lock-screen/control-center contract and the Expo Audio patch in `scripts/patch-expo-audio.js` / `node_modules/expo-audio/ios/MediaController.swift`; it is not a production source move | Defer to Stage 6/7; keep the test explicitly in the player/native integration inventory and run it with the player acceptance checks |
| `hooks/usePlayerController.js`, `hooks/__tests__/usePlayerController.test.js` | `features/player/hooks/usePlayerController.js`, matching `__tests__` (deferred) | Owns Expo Audio player lifecycle and playback state | App consumes hook; imports player services, settings and shared API; test mocks those modules | Defer to Stage 6/7; background and lock-screen behavior are invariants |
| `hooks/useTracksPagination.js`, `hooks/__tests__/useTracksPagination.test.js` | `features/catalog/hooks/useTracksPagination.js`, matching `__tests__` | Catalog pagination state | App consumes hook; uses shared API cache | Hook tests and Expo export; preserve page/load-more semantics |
| `components/HomeScreen.js` | `features/catalog/HomeScreen.js` | Home catalog browsing | MainTabs consumes; imports shared UI/media/API cache/settings and catalog pagination-related contracts | Catalog and relevant screen tests; preserve refresh and event behavior |
| `components/SearchScreen.js` | `features/search/SearchScreen.js` | Search workflow | MainTabs consumes; imports shared media/API/settings | Search screen checks and Expo export; preserve query/navigation behavior |
| `components/LibraryScreen.js`, `components/__tests__/LibraryScreen.test.js` | `features/library/LibraryScreen.js`, `features/library/__tests__/LibraryScreen.test.js` | User library/history and playlist-entry workflow | MainTabs consumes; imports shared API/cache/settings/media and playlist modal | Library tests exercise cache and DeviceEventEmitter updates; preserve subscriptions/cleanup |
| `components/PlaylistScreen.js` | `features/playlists/PlaylistScreen.js` | Playlist detail workflow | RootNavigator consumes; imports shared media/API/settings | Expo export and playlist navigation smoke check |
| `components/AddToPlaylistModal.js` | `features/playlists/AddToPlaylistModal.js` | Playlist assignment flow | App consumes; imports shared API | Verify add-to-playlist flow and modal composition |
| `components/AlbumScreen.js`, `components/AlbumEditScreen.js` | `features/albums/AlbumScreen.js`, `features/albums/AlbumEditScreen.js` | Album viewing/editing flows | RootNavigator consumes; shared media/API; editor emits album-updated event | Expo export and route check; preserve event payload and route params |
| `components/TrackEditScreen.js`, `components/trackEditScreenStyles.js` | `features/library/TrackEditScreen.js`, `features/library/trackEditScreenStyles.js` | Track metadata editing is a library item workflow | RootNavigator consumes; shared media/API/settings; emits track update/delete events | Preserve event payloads and update/delete flows; verify LibraryScreen listeners |
| `components/CoverImage.js`, `components/__tests__/coverImageUtils.test.js` | `shared/media/CoverImage.js`, `shared/media/__tests__/coverImageUtils.test.js` | Shared cover loading, URL resolution, and prefetch primitive | Used by catalog, search, library, playlists, albums, queue UI, FullPlayerModal, and playback coordinator; tests and Jest mocks import it | Confirmed multi-feature and playback-service use; broad import/mocks update, run cover/player tests and Expo export. Batch 7 must also allowlist the import-path update for `require('../assets/default_cover.jpg')` to `require('../../assets/default_cover.jpg')`; keep `assets/default_cover.jpg` in place rather than moving the asset. |
| `components/AppHeader.js` | `shared/components/AppHeader.js` | Shared app header | Directly imported only by `navigation/MainTabs.js`, which renders it across the Home, Search, and Library tab composition | Keep here as navigation-shared UI; verify the three rendered tab contexts and revisit if composition diverges |
| `components/QueueItem.js` | `features/player/components/QueueItem.js` (deferred) | Queue row belongs to player UI | Imports CoverImage; consumers are player queue presentation | Defer to Stage 6/7 with player UI |
| `components/FullPlayerModal.js` | `features/player/components/FullPlayerModal.js` (deferred) | Full player composition | App consumes; composes lyrics, queue, controls, shared media and styles | Defer to Stage 6/7; no presentation or lifecycle changes |
| `components/fullplayer/MiniPlayerBar.js`, `components/fullplayer/GlowTrackBoundary.js`, `components/fullplayer/TrackLoadingBadge.js`, `components/fullplayer/PlayerNetworkBanner.js`, `components/fullplayer/PlayerControls.js`, `components/fullplayer/ProgressBar.js`, `components/fullplayer/QueuePanel.js`, `components/fullplayer/ChasingArrowsIcon.js`, `components/fullplayer/playerStyles.js` | `features/player/components/` with corresponding paths (deferred) | Player presentation primitives | Consumed by App/FullPlayerModal/player components | Defer to Stage 6/7; preserve player appearance and interactions |
| `components/fullplayer/playerBackground.js` | unchanged during structural stages | Accepted player-background baseline | App imports this exact module | Explicitly do not simplify, relocate, or restyle as part of structural work |
| `components/fullplayer/__tests__/*.test.js` | `features/player/components/__tests__/*.test.js` (deferred) | Player presentation tests | Cover controls, menu, gestures, mini-player and banners | Defer with player; continue to run during any touching stage |
| `components/fullplayer/lyrics/AppleLyricsView.js`, `AnimatedLyricLine.js`, `lyricDepth.js`, `components/fullplayer/lyrics/__tests__/*.test.js` | `features/player/lyrics/` with matching tests (deferred) | Player lyrics rendering and pure lyric depth behavior | FullPlayerModal consumes view; tests cover rendering/geometry | Defer to Stage 6/7; preserve line-level LRC timing and visuals |
| `components/TrackContextMenuModal.js` | `shared/components/TrackContextMenuModal.js` | Track actions modal shared by app composition and list rows | App consumes; feature screens can open via callback; no independent screen ownership | Verify modal callbacks, navigation and queue actions; keep API unchanged |
| `scripts/patch-expo-audio.js`, `proxy.js`, `babel.config.js`, `eslint.config.js`, `index.js`, and root JSON/config files | unchanged | Tooling, Expo entry/config, and development infrastructure | Not feature-owned source | Excluded from Stage 4 moves; preserve unsigned IPA workflow |

## Public boundaries

- **App composition:** `App.js` remains the root composition owner. It may import `features/auth/AppAuthGate`, `features/player` public UI/hook entry points after their respective approved stages, and `navigation/RootNavigator`. Do not move player state or modal ownership as a consequence of folder moves.
- **Navigation:** `navigation/RootNavigator` and `navigation/MainTabs` own route/tab registration and consume screen components. Feature screens do not import navigators; use existing callbacks/route params and preserve route names.
- **Auth:** `features/auth` owns auth gate/login UI and imports auth operations from `shared/api`. It does not own global app bootstrap or authenticated navigation composition.
- **Settings:** `shared/storage/settings` owns persisted settings and settings notifications. Consumers subscribe through the existing API; event names and cleanup remain unchanged. Do not redesign event/state ownership in Stage 4.
- **Player:** player hooks/services/components remain an internal feature boundary, but no new barrel is proposed. App continues to own presentation layering and supplies current callbacks/props. Stage 6 defines a stable public player interface before any internal movement.
- **Shared media:** `shared/media/CoverImage` owns reusable artwork URL resolution/loading/prefetch because consumers span multiple user-facing features and playback services. It must not acquire feature-specific screen state.
- **Shared API:** `shared/api` owns transport, auth-facing API operations and proven cross-feature caches. This is a path move only; splitting responsibilities is Stage 5 work.

## Stage 4 batch sequence

1. Move `AppAuthGate`, `LoginModal`, their two local style/test files as listed above, and update `App.js`, `AppAuthGate`, tests. This is the smallest contained feature batch.
2. Move catalog pagination hook/tests and `HomeScreen`.
3. Move `SearchScreen`.
4. Move `LibraryScreen` and its test, then `TrackEditScreen` and its local styles only after the library batch is accepted.
5. Move playlist files (`PlaylistScreen`, `AddToPlaylistModal`).
6. Move album screens.
7. Move `CoverImage` and all imports, mocks, and tests referencing it. This batch has broad fan-out and should be isolated. Keep `assets/default_cover.jpg` at its current path and update the moved module's relative require from `../assets/default_cover.jpg` to `../../assets/default_cover.jpg` as part of the exact allowlist.
8. Move `AppHeader` and `TrackContextMenuModal` after consumer mapping is rechecked.
9. Move shared API/cache/settings modules only after a fresh dirty-tree inspection and a dedicated bounded batch; the structural plan does not combine these moves with their Stage 5 ownership changes.

No batch may begin until the stage coordinator inspects the current diffs for every source and import consumer in that batch. In particular, the current worktree has uncommitted changes in `App.js`, `components/AppAuthGate.js`, its test, package/lint/format files, and baseline/stage-2 reports. Batch 1 overlaps those files and must preserve those edits exactly; stop if they have changed since this map was approved or if their intent is unclear.

## Unresolved ownership decisions

- `TrackEditScreen` is assigned to `library` because it edits tracks surfaced by the library and emits track update/delete events consumed there; if future product navigation makes it a standalone workflow, revisit with a separate design decision.
- `AppHeader` currently serves three tabs from `MainTabs`; it is placed in `shared/components` as actual shared navigation UI. It should not become a generic component bucket.
- `TrackContextMenuModal` is composed globally by App and opened from feature screens through callbacks. It remains app-shared UI until its ownership/API is clarified; do not relocate its state or action logic during a move.
- API cache and persistent settings are listed in shared destinations based on current cross-feature usage, but their responsibility split is deferred to Stage 5.
- Player component subfolders should be finalized in Stage 6/7 after the player boundary is specified. The destinations shown above are provisional and authorize no player file move.
- `utils/__tests__/lockScreenControls.test.js` is a player/native integration test rather than a general utility test. Its deferred destination is recorded for inventory completeness, but the test's references to the Expo Audio patch and generated dependency source must remain explicit during Stage 6/7 review.

## Stage 3 acceptance

- The current handwritten JS/test inventory has an owner and explicit destination or an explicit exclusion/deferment.
- Confirmed shared placement includes evidence of current multi-feature use.
- Cross-feature imports, event surfaces, public boundaries and first safe batches are recorded above.
- No source file moves are included in this stage.

## Verification and remaining checks

- Read-only inspection only; no source files were moved or edited.
- Existing `App.js` and `AppAuthGate` work is uncommitted user work and is explicitly carried into the first move-batch warning.
- Before each Stage 4 dispatch, rerun `git status --short`, inspect diffs for allowlisted files, and check all imports/mocks against the current tree.
- Stage 2 physical-device checks were confirmed by the user on iPhone 11 Pro, iOS 18.6.2, in Expo Go; see `02-app-composition-report.md`. The Stage 4 gate is closed. These checks do not constitute standalone IPA validation.
- Stage 4 batches require focused Jest tests, full `npm test -- --runInBand` when practical, `npx expo export --platform ios --output-dir <temporary-directory>`, and `git diff --check`.
