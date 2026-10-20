# Stage 6: Player Boundary and Audio Invariants Report

**Owner:** Senior model (`nyxos-openai/gpt-6.1-sol`)
**Status:** Design and characterization review complete; no source changes.

## Scope and evidence

Reviewed `hooks/usePlayerController.js`, `utils/playbackCoordinator.js`, `utils/preloadScheduler.js`, `utils/audioCache.js`, `App.js`, and the focused player/audio tests. The hook is called only by `App.js`; its return value is the app-level player interface. The current source tree was already dirty before this stage, so no existing source changes were modified.

## Player contract consumed by UI

`usePlayerController({ setTracks })` returns:

- Native player and status: `player`, `status`, `isPlaying`, `currentTime`, `duration`.
- Current presentation/session state: `currentTrack`, `isLoading`, `isPlayerVisible`, `setIsPlayerVisible`, `playerExpandToken`, `requestExpandPlayer`.
- Queue/history projection: `upNextQueue`, `history`, `previousTrack`, `nextTrack`.
- User commands: `playPreviousTrack`, `fetchNextTrack`, `togglePlayPause`, `playTrack`, `playTrackList`, `handleToggleLike`, `startWave`, `dismissPlayer`.
- Settings and playback feedback: `soundCheck`, `isSoundCheckEnabled`, `networkStatus`, `nextTrackStatus`, `networkError`, `isBufferingSlow`, `retryPreload`, `skipToNext`.

`App.js` composes that interface into `FullPlayerModal`, `MiniPlayerBar`, navigation screens, and app-level gesture/animation state. It owns expansion/dismiss presentation progress and routes swipe completion to controller commands. The player background remains sourced from the accepted `PLAYER_BACKGROUND_COLOR` implementation and is outside this structural contract.

## Ownership and lifecycle

- **Current track, React queue/history, loading and visibility:** `usePlayerController`. It selects from the queue, records history, requests wave recommendations, handles likes, and exposes UI projections.
- **Audio engine and foreground/background audio session:** `expo-audio` player created by the hook. The hook configures `playsInSilentMode: true`, `shouldPlayInBackground: true`, and `interruptionMode: 'doNotMix'` once on mount. Audio session lifetime is not equivalent to the React player modal or navigation screen lifetime.
- **Track source selection and playback transition:** `PlaybackCoordinator.play()`. It selects cached local URI or remote stream, applies normalization, guards overlapping/out-of-order replacement with generation checks, reports classified errors, and updates Now Playing metadata.
- **Persistent media files:** `AudioCache`, initialized by `App.js`; it owns downloads, manifest, cancellation, and LRU protection. The coordinator protects current/queued IDs through cache integration.
- **Upcoming-track preparation:** `PreloadScheduler`, synchronized by `PlaybackCoordinator.updateQueue()`. It owns lookahead, concurrency/network-policy limits, task priority/cancellation, and preload status. The UI observes projected status through `subscribe()`.
- **Lock-screen and Control Center command path:** the Expo Audio native patch emits `nextTrack`/`previousTrack`; the hook subscribes to those player events and forwards them through refs to the current next/previous commands. The coordinator sets lock-screen metadata. `dismissPlayer()` pauses, disables lock-screen controls, resets normalization, clears the session projections and persisted last track.
- **Auth-scoped history and telemetry:** the hook owns deduplication, buffering and retry of background history/wave feedback requests. Auth changes invalidate the relevant state and abort pending work.
- **Loading/error/network feedback:** the hook owns `isLoading`; coordinator/scheduler own network, buffering, next-track preload status and playback error state; the hook subscribes and exposes those values to `App.js` and player presentation.

No cleanup of the shared default coordinator, scheduler, or audio cache is performed on React unmount in the reviewed flow. Their lifecycle must not be changed casually: audio/background behavior may outlive screen visibility, and the defaults are module-level shared instances. This is a characterization, not a recommendation to add teardown.

## Existing deterministic coverage

Focused tests already exercise the critical seams:

- `hooks/__tests__/usePlayerController.test.js`: player API and initial state; queue/history transitions; late queue response invalidation; playback-before-queue/telemetry ordering; auth-scoped history; background telemetry retry and cancellation on auth change; dismiss behavior; sound-check updates.
- `utils/__tests__/playbackCoordinator.test.js`: local-cache and remote fallback, ID zero and `track_id`, queue/preload synchronization, slow network, idempotence, generation races and stale replacement recovery, destroy invalidation, error classification, lock-screen metadata race protection, and normalization.
- `utils/__tests__/preloadScheduler.test.js`: queue scheduling, network policy, concurrency and cancellation behavior.
- `utils/__tests__/audioCache.test.js`: cache initialization, manifest validation, atomic download, cancellation and cache behavior.
- `utils/__tests__/lockScreenControls.test.js`: native patch wiring for next/previous commands, command cleanup, and artwork update/cache behavior.
- `utils/__tests__/networkPolicy.test.js`: safe baseline and policy subscription behavior.

No new characterization test was added: the reviewed critical contracts already have deterministic coverage, and adding a duplicate test would not materially reduce risk.

## Verification

Executed in `app/ios/puuk-ios`:

```bash
npm test -- --runInBand hooks/__tests__/usePlayerController.test.js utils/__tests__/playbackCoordinator.test.js utils/__tests__/preloadScheduler.test.js utils/__tests__/audioCache.test.js utils/__tests__/lockScreenControls.test.js utils/__tests__/networkPolicy.test.js
```

**Result:** PASS, 6 suites and 126 tests. The existing AudioCache legacy-format warning was emitted by its negative-case test.

`git diff --check` also passed. No source, test, Expo API, native patch, dependency, or workflow files were changed in Stage 6.

## Manual device checks

Automated tests do not prove actual background audio, Control Center/lock-screen behavior, interruptions, gesture feel, or animation equivalence. Before any Stage 7 task touching playback lifecycle, lock-screen integration, player presentation or gestures, verify on a physical iPhone:

- Start a track, background the app, and confirm playback continues.
- Use lock-screen and Control Center play/pause, next, and previous commands; confirm the active track and metadata stay in sync.
- Verify artwork and metadata update across rapid track changes without stale content.
- Exercise audio interruption/resumption and dismiss the player; confirm existing behavior and lock-screen cleanup.
- Compare mini/full-player transitions, horizontal track changes, queue/history, lyrics, loading/network/error feedback, and the current artwork/ambient background wherever the touched surface applies.

No physical device check was run as part of this design-only stage.

## Stage 7 decomposition order

The smallest safe next step is a senior-led, single-responsibility decomposition proposal against a named player file, with no concurrent player edits. The player boundary is sufficiently characterized to begin reviewing candidate pure helpers, but track identity is explicitly dependent on the Stage 8 contract; defer any `id`/`track_id` helper until that contract is approved. Do not split lifecycle, gesture/animation coordination, or audio/runtime ownership as part of the first extraction. Any candidate must identify a concrete consumer, preserve the returned hook interface, have focused tests, pass the relevant player tests and Expo export/build validation, and receive the applicable physical-iPhone checks above.

## Report

The UI/runtime responsibilities and lifecycle boundary are documented above. No tests or implementation were added because the existing deterministic tests cover the reviewed contracts. Remaining manual verification is physical-iPhone playback, lock-screen/Control Center, interruption, gesture, animation and visual comparison; these checks are required when a later change touches their behavior.
