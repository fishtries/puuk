# Stage 5: Shared Events, Settings, API — Senior Design

**Status:** design complete; no source implementation dispatched from this document. Stage 4 batches 1–6 are present and accepted in the current dirty tree, while batches 7–9 remain pending. The implementation gate is therefore closed until the minimal Stage 4 prerequisites below are accepted.

## Target

Current API/auth/settings/event code and its direct consumers in `app/ios/puuk-ios/`, with ownership and contracts made explicit before any extraction. The current implementation remains under `utils/` until the approved structural move (Stage 4 batch 9) is complete.

## Change

Clarify ownership of HTTP transport, auth session/storage, app settings, last-track persistence, catalog cache, and cross-screen events. Replace hidden `DeviceEventEmitter` contracts only in separately approved slices after producer/consumer/payload/lifetime inventory. This design does not change runtime behavior, listener timing, retry, timeout, cancellation, auth, offline, persistence, DTO, or track identity semantics.

## Constraints

- Do not replace all event usage in one pass. Inventory event names, producers, consumers, payloads, and lifetime first.
- Keep authentication, retry, timeout, cancellation, 401/logout, and offline semantics unchanged unless separately authorized.
- Keep settings persistence and listener timing unchanged.
- Do not add Zustand or a new event-bus library as a default solution.
- Do not create thin pass-through API modules that only rename imports.
- Preserve server endpoint/DTO contracts.
- Treat `id`/`track_id` normalization as Stage 8; do not mix it into service extraction.
- Preserve the current dirty feature moves and all `App.js`/navigation import changes. No reset, cleanup, checkout, source overwrite, commit, or delegation.
- No behavior, audio/player, background, navigation, auth, retry/timeout/abort, offline, or listener-timing changes.
- This dispatch edits only this design document.

## Ownership

Senior approves each boundary and migration slice. Junior receives an exact allowlist and one event/service at a time. Never run overlapping edits to shared API/settings files.

### Proposed ownership boundaries

| Responsibility | Current owner | Proposed owner | Contract and migration rule |
|---|---|---|---|
| Base URL (`DEFAULT_SERVER_URL`, mutable `SERVER_URL`, `setServerUrl`) | `utils/api.js` | `shared/api/api.js` | Preserve mutable module-level URL and trailing-slash trimming; settings remains the persisted source of the server URL. |
| Secure auth token/user storage, in-memory auth cache | `utils/api.js` | `shared/api/api.js` | Preserve SecureStore keys/options, cache behavior, auth listener Set, callback error isolation, and async ordering. |
| HTTP transport (`authFetch`) | `utils/api.js` | `shared/api/api.js` | Preserve endpoint resolution, headers/body serialization, retry defaults/options, timeout, AbortController wiring, 401 handling, and response-return behavior exactly. |
| API error classification/parsing | `utils/api.js` | `shared/api/api.js` | Keep `ApiError`, classification predicates, and `parseApiErrorMessage` exports/semantics; no DTO changes. |
| Login/logout/check-auth operations | `utils/api.js` | `shared/api/api.js` | API/auth service owns operations; auth UI owns presentation only. Preserve direct `fetch` login endpoints and logout notification behavior. |
| Catalog cache and cache invalidation | `utils/apiCache.js` | `shared/api/apiCache.js` | Cache owns persistence, SWR, isolation, deduplication, abort/invalidation generations, and auth-clear hook. It may import the API service; API must not import cache. |
| Settings defaults/translations/read/write | `utils/settings.js` | `shared/storage/settings.js` | Storage owns SecureStore settings key, default merge, translation lookup, synchronous snapshot, async persistence, and current event emission timing. |
| Last-track persistence | `utils/settings.js` | `shared/storage/settings.js` initially | Keep separate named responsibility within settings storage until a future approved slice; preserve current `track.id` guard and SecureStore behavior. Stage 8 owns identity normalization. |
| Settings notification | `utils/settings.js` + RN `DeviceEventEmitter` | `shared/storage/settings.js` initially | Preserve event name/payload/timing and unsubscribe shape in the first move. Any replacement requires a separate senior-approved event slice and focused lifecycle tests. |
| Cross-screen domain notifications | scattered screens/App/navigation | No new global owner yet; a documented event contract | Keep `DeviceEventEmitter` for the first migration slice. Producers stay with the action that owns the mutation; consumers subscribe in their screen/app lifetime. |

## Current event inventory

All subscriptions below remove their listener in the effect cleanup. No producer currently retains a listener or uses a one-shot subscription. Payloads are plain objects except scroll/create events, which have no payload.

| Event | Producers | Consumers | Payload | Lifetime/cleanup | Ownership decision |
|---|---|---|---|---|---|
| `PUUK_SETTINGS_CHANGED` | `utils/settings.js:updateSetting` | `App.js`, `navigation/MainTabs.js`, `components/AppHeader.js`, `features/auth/LoginModal.js`, `features/search/SearchScreen.js`, `features/library/LibraryScreen.js`, `features/library/TrackEditScreen.js`, `features/playlists/PlaylistScreen.js`, `hooks/usePlayerController.js` | `{ ...cachedSettings, key, value }` (full snapshot plus changed key/value) | Subscriptions live for mounted component; cleanup calls returned `sub.remove()` wrapper. Emitted after SecureStore write attempt, including write failure. | `shared/storage/settings.js` owns emission until a separate event replacement is approved. Preserve snapshot shape and timing. |
| `PUUK_SCROLL_TO_TOP_HOME` | `navigation/MainTabs.js` on repeated Home tab press | `features/catalog/HomeScreen.js` | none | Home screen subscription while mounted; cleanup removes it. | Navigation owns intent; Home owns scroll effect. Keep emitter in first slice. |
| `PUUK_SCROLL_TO_TOP_SEARCH` | `navigation/MainTabs.js` on repeated Search tab press | `features/search/SearchScreen.js` | none | Search screen subscription while mounted; cleanup removes it. | Navigation owns intent; Search owns scroll effect. |
| `PUUK_SCROLL_TO_TOP_LIBRARY` | `navigation/MainTabs.js` on repeated Library tab press | `features/library/LibraryScreen.js` | none | Library screen subscription while mounted; cleanup removes it. | Navigation owns intent; Library owns scroll effect. |
| `PUUK_CREATE_PLAYLIST` | `navigation/MainTabs.js` header callback | `features/library/LibraryScreen.js` | none | Library subscription is recreated when `handleCreatePlaylist` changes and removed on cleanup. | App/header navigation intent; Library owns prompt/API mutation. |
| `PUUK_TRACK_UPDATED` | `features/library/TrackEditScreen.js` after successful PATCH | `App.js`, `features/library/LibraryScreen.js` | `{ id, title, artist, album, coverArt }`; consumer merges by `id` | App/library listeners live for their mounted lifetime and clean up. | Track editor owns mutation event; App/player and Library own their projections. Do not normalize identity here. |
| `PUUK_TRACK_DELETED` | `features/library/TrackEditScreen.js` after successful DELETE | `App.js`, `features/library/LibraryScreen.js` | `{ id }` | App/library listeners live for mounted lifetime and clean up. | Track editor owns mutation event; consumers invalidate their own state/cache. |
| `PUUK_ALBUM_UPDATED` | `features/albums/AlbumEditScreen.js` after successful PATCH | No current consumer found | `{ previousAlbumId: Number(albumId), album: result.album }` | Producer emits once after response; no listener currently exists. | Keep as documented producer contract; do not remove or invent a consumer. Revisit only with an explicit product need. |

`DeviceEventEmitter` references in the Expo Audio patch and lock-screen test are native/player integration behavior and are excluded from this stage. They must not be folded into a shared app event service.

## Direct consumer and service fan-out

### API/auth service

Current direct import consumers (after Stage 4 moves) are `App.js`, `features/auth/LoginModal.js`, `features/catalog/HomeScreen.js`, `features/catalog/hooks/useTracksPagination.js`, `features/search/SearchScreen.js`, `features/library/LibraryScreen.js`, `features/library/TrackEditScreen.js`, `features/playlists/AddToPlaylistModal.js`, `features/playlists/PlaylistScreen.js`, `features/albums/AlbumScreen.js`, `features/albums/AlbumEditScreen.js`, `components/CoverImage.js`, `components/fullplayer/lyrics/AppleLyricsView.js`, `hooks/usePlayerController.js`, and their corresponding tests. The API module also owns the cache's `authFetch`, `SERVER_URL`, saved-user, and auth-listener dependencies.

Exports in active use include `authFetch`, `SERVER_URL`, `DEFAULT_SERVER_URL`, `setServerUrl`, `getAuthHeaders`, `getAuthToken`, `setAuthToken`, `getSavedUser`, `setSavedUser`, `logout`, `checkAuth`, `addAuthListener`, login operations, and `parseApiErrorMessage`; the full export surface and tests must be checked before moving.

### Settings/storage service

Current direct consumers are `App.js`, `navigation/MainTabs.js`, `components/AppHeader.js`, `features/auth/LoginModal.js`, `features/search/SearchScreen.js`, `features/library/LibraryScreen.js`, `features/library/TrackEditScreen.js`, `features/playlists/PlaylistScreen.js`, and `hooks/usePlayerController.js`, plus auth/library/player tests. Exports in active use include `DEFAULT_SETTINGS`, `TRANSLATIONS`, `t`, `getSettings`, `loadSettings`, `updateSetting`, `addSettingsListener`, `getSavedLastTrack`, `setSavedLastTrack`, and `clearSavedLastTrack`.

### Cache service

`utils/apiCache.js` is consumed by `features/catalog/HomeScreen.js`, `features/catalog/hooks/useTracksPagination.js`, `features/library/LibraryScreen.js`, and their tests. It imports `authFetch`, `SERVER_URL`, `getSavedUser`, and `addAuthListener`; its auth listener clears cache on logout. Its broad export surface must be inventoried from the file and cache tests before any split—do not reduce it to a forwarding module.

## Minimal prerequisites and exact implementation proposal

The report says Stage 4 batches 7–9 are pending, and the current tree verifies that `components/CoverImage.js`, `components/AppHeader.js`, `components/TrackContextMenuModal.js`, `utils/api.js`, `utils/apiCache.js`, and `utils/settings.js` still exist at their old paths. Therefore Stage 5 implementation must wait for these minimal prerequisites:

1. **Stage 4 batch 7 acceptance:** move `CoverImage` and its test/mocks to `shared/media`, updating only the approved import paths and default-cover asset relative path; preserve the asset and run focused/full Jest plus Expo export.
2. **Stage 4 batch 8 acceptance:** move `AppHeader` and `TrackContextMenuModal` to `shared/components`, after rechecking both consumers and preserving App/navigation imports and event behavior.
3. **Stage 4 batch 9 acceptance:** perform the path-only moves of API/cache/settings modules and tests to `shared/api` and `shared/storage`, updating all production/test imports. This is a structural prerequisite, not an ownership redesign; it must preserve exports and behavior exactly.

### One bounded Gemini junior task (dispatch only after prerequisites)

Copy the following complete Stage 5 contract into the junior dispatch. The junior task is deliberately limited to one service: the first API ownership slice after batch 9.

#### Target

`shared/api/api.js` and its direct import/test consumers, as listed in this senior-approved subtask. The module is already at `shared/api/api.js` only after accepted Stage 4 batch 9; do not move or edit settings, cache, events, player, navigation, or feature ownership in this task.

#### Change

Validate and accept the API transport/auth service boundary as one behavior-preserving slice. If the implementation needs a path-only import update left over from batch 9, update only the exact allowlisted consumers below; otherwise make no source changes. Keep HTTP transport, auth session/storage, login/logout, 401 handling, error parsing, retry, timeout, abort, offline, and server URL behavior byte-for-byte equivalent in observable behavior.

#### Constraints

- Do not replace all event usage in one pass. Inventory event names, producers, consumers, payloads, and lifetime first.
- Keep authentication, retry, timeout, cancellation, 401/logout, and offline semantics unchanged unless separately authorized.
- Keep settings persistence and listener timing unchanged.
- Do not add Zustand or a new event-bus library as a default solution.
- Do not create thin pass-through API modules that only rename imports.
- Preserve server endpoint/DTO contracts.
- Treat `id`/`track_id` normalization as Stage 8; do not mix it into service extraction.
- Do not edit `utils/settings.js`/`shared/storage/settings.js`, `apiCache`, event producers/consumers, player/audio/background files, `App.js` composition, navigation registration, package/native/workflow files, or add dependencies.
- Stop and report if any export, test mock, consumer, or behavior is ambiguous.

#### Ownership

Senior approves the API boundary and exact allowlist. Junior owns only the API file path/import surface listed below and must not overlap another shared API/settings task.

**Exact allowlist:** `app/ios/puuk-ios/shared/api/api.js`, `app/ios/puuk-ios/shared/api/__tests__/api.test.js`, `app/ios/puuk-ios/shared/api/__tests__/apiErrorMessage.test.js`, plus import specifiers in existing consumers/tests that directly reference `utils/api` (including `App.js`, feature screens/hooks, `components/CoverImage.js`, player lyrics, and their tests). No other file.

#### Observable acceptance

- Before edits, record the current API producers/consumers and expected equivalent behavior; API has no event producers beyond auth listeners and no consumer may observe changed timing.
- Existing API/auth tests pass; focused tests cover auth listener cleanup, SecureStore token/user persistence, login/logout, 401 handling, retry/timeout/abort, and error parsing using existing cases.
- No event listener leak or duplicate subscription is introduced.
- Retry/timeout/abort and auth-change behavior remain covered by existing or focused tests.
- Full Jest suite passes after the slice.
- No native dependency or IPA workflow change is introduced.

#### Report

Report old/new ownership contract, every migrated consumer/import, exact commands and outcomes, remaining old API imports, and any behavior ambiguity. Stop on ambiguity rather than guessing.

## Verification performed for this design

Commands/results from the read-only design audit:

- `git status --short && git diff -- docs/ios-refactor` — **PASS/inspected**: dirty feature moves and `App.js`/navigation changes are present; no source files were reset or cleaned. Only this design file is authorized for this dispatch.
- Tree inspection under `app/ios/puuk-ios/features/` — **PASS/confirmed**: accepted auth, catalog, search, library, playlists, and albums destinations exist; old shared modules remain in `utils/`.
- `grep` audit for `DeviceEventEmitter|addSettingsListener|PUUK_|emit\(` — **PASS/recorded**: settings event plus scroll/create/track/album event inventory above; Expo Audio/native event references excluded.
- Import audit for API/settings/cache — **PASS/recorded**: current fan-out and direct consumers are listed above; no Stage 5 source changes were made.
- `git diff --check` — **PASS as recorded by the accepted Stage 4 report**; this design dispatch does not alter source diffs.
- Baseline Jest/Expo checks — **not rerun** because this dispatch is documentation-only and must not interfere with concurrent coordinator work; accepted Stage 4 report records `npm test -- --runInBand` (26 suites, 299 tests) and Expo iOS export passing.

## Report

Old ownership is documented from `utils/api.js`, `utils/apiCache.js`, and `utils/settings.js`, with event production remaining in mutation/settings owners and projection/listener lifetimes remaining in App/navigation/screens. The proposed ownership is `shared/api` for transport/auth/cache and `shared/storage` for settings/last-track, while cross-screen event contracts remain explicitly documented on `DeviceEventEmitter` until separately approved. The only proposed junior implementation is the exact API service slice above, gated on accepted Stage 4 batches 7–9; no blockers remain for design, but implementation must stop on export/lifecycle ambiguity.

## Full Stage 5 task contract

The complete source stage contract is retained verbatim below for orchestration, as required by the refactoring workflow.

### Target

Current API/auth/settings/event code and its direct consumers, as listed in a senior-approved subtask.

### Change

Clarify ownership of HTTP transport, auth session/storage, app settings, last-track persistence, and cross-screen events. Replace hidden `DeviceEventEmitter` contracts only where the replacement makes ownership and payloads clearer.

### Constraints

- Do not replace all event usage in one pass. Inventory event names, producers, consumers, payloads, and lifetime first.
- Keep authentication, retry, timeout, cancellation, 401/logout, and offline semantics unchanged unless separately authorized.
- Keep settings persistence and listener timing unchanged.
- Do not add Zustand or a new event-bus library as a default solution.
- Do not create thin pass-through API modules that only rename imports.
- Preserve server endpoint/DTO contracts.
- Treat `id`/`track_id` normalization as Stage 8; do not mix it into service extraction.

### Ownership

Senior approves each boundary and migration slice. Junior receives an exact allowlist and one event/service at a time. Never run overlapping edits to shared API/settings files.

### Observable acceptance

- Before edits, each slice documents current producers/consumers and expected equivalent behavior.
- Existing relevant API/settings/auth tests pass; focused tests cover any changed event subscription lifecycle or service behavior.
- No event listener leak or duplicate subscription is introduced.
- Retry/timeout/abort and auth-change behavior remain covered by existing or focused tests.
- Full Jest suite passes after each accepted slice.
- No native dependency or IPA workflow change is introduced.

### Report

For each slice, report the old/new ownership contract, migrated producers/consumers, tests and outcomes, remaining emitter uses, and any behavior ambiguity. Stop on ambiguity rather than guessing.
