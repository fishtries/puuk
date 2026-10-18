# iOS Refactor Baseline Report

## Worktree and player baseline

The starting worktree was clean at commit `c5aa41c` (`refactor(ios): player background simplification and refactoring plan docs`). That commit includes the accepted starting player-background implementation: `components/fullplayer/playerBackground.js` exports `PLAYER_BACKGROUND_COLOR`, consumed by `App.js`; `FullPlayerModal.js` no longer renders the former ambient cover/blur/gradient stack, and the mini-player and player styles use transparent backgrounds. This is recorded as baseline, not changed by this plan.

## Tooling and commands

- Node/npm available in this environment: Node `v26.12.0`, npm `12.2.1`. The iOS CI workflow uses Node 22.
- Dependencies were installed. `npm test -- --runInBand` passed: 25 suites, 297 tests.
- Existing package scripts: `npm test` (Jest), `npm run start`, `npm run ios`, `npm run android`, and `npm run web`.
- Before stage 1, no ESLint or Prettier executable was installed. `eslint.config.js` configured JSX parsing but no rules. Stage 1 adds `npm run lint -- <paths>`, `npm run format -- <paths>`, and `npm run format:check -- <paths>`; no CI lint gate is configured.
- CI IPA command sequence is in `.github/workflows/build-ios-unsigned.yml`: `npm ci`, `node scripts/patch-expo-audio.js`, `npx expo prebuild --platform ios --no-install --non-interactive`, CocoaPods install, then unsigned `xcodebuild archive` with code signing disabled. No local iOS archive or physical-device check was run.

## File and feature inventory

- Bootstrap/composition: `index.js`, `App.js`; `App.js` owns auth bootstrap, root-level player presentation, global events, and modal composition.
- Auth/API: `utils/api.js`, `components/LoginModal.js`, `components/AppHeader.js`.
- Player: `hooks/usePlayerController.js`, `utils/playbackCoordinator.js`, `utils/audioCache.js`, `utils/loudnessNormalization.js`, `utils/streamUrl.js`, `utils/preloadScheduler.js`, and `components/FullPlayerModal.js` plus `components/fullplayer/`.
- Catalog/home: `components/HomeScreen.js`, `hooks/useTracksPagination.js`.
- Search: `components/SearchScreen.js`.
- Library/playlists/albums: `components/LibraryScreen.js`, `components/PlaylistScreen.js`, `components/AlbumScreen.js`, `components/AlbumEditScreen.js`, and `components/TrackEditScreen.js`.
- Navigation: `navigation/RootNavigator.js`, `navigation/MainTabs.js`.
- Settings/storage: `utils/settings.js` uses SecureStore and DeviceEventEmitter; `utils/apiCache.js` and `utils/audioCache.js` own API/audio caches.
- Shared UI: `components/CoverImage.js`, `components/QueueItem.js`, modal components, and `components/fullplayer/` controls/banners.

## Contracts and structural risks

- Preserve `usePlayerController` ownership of Expo Audio player lifecycle, queue/history, wave requests, playback/network state, likes, audio mode, and lock-screen integration. Related tests are in `hooks/__tests__/usePlayerController.test.js` and `utils/__tests__/lockScreenControls.test.js`.
- Preserve full/mini-player presentation, lyrics/LRC behavior, swipe/gesture transitions, queue, progress and loading/network states. Existing component and lyrics tests live under `components/fullplayer/**/__tests__/`.
- Preserve loudness normalization in `utils/loudnessNormalization.js`, stream URL policy in `utils/streamUrl.js`, and cache/preload behavior in their respective `utils/__tests__/` suites.
- `App.js` is coupled to navigation through player shared values and callbacks passed via `RootNavigator`; composition changes must keep these props and transitions intact.
- `DeviceEventEmitter` events connect App, tabs, screens, settings and edit flows (`PUUK_TRACK_UPDATED`, `PUUK_TRACK_DELETED`, `PUUK_SETTINGS_CHANGED`, scroll-to-top, and create-playlist). Moving ownership requires an explicit event map and subscription cleanup.
- API and settings modules currently combine persistence, caches, listeners and transport/configuration. Avoid relocating them during basic feature moves without an approved ownership map.

## Build constraints and next slice

The GitHub Actions workflow uses Expo SDK 57 and builds an unsigned IPA on macOS 26; it installs from `package-lock.json`, applies the existing `expo-audio` patch, prebuilds, and uses CocoaPods. Do not add native dependencies or change signing/distribution. Any Expo API change requires consulting the exact SDK 57 documentation at https://docs.expo.dev/versions/v57.0.0/.

Recommended first source-structure slice after tool setup: stage 2, make an ownership map of `App.js` composition and identify one narrowly scoped responsibility to extract without moving navigation or player lifecycle. Stage 3 should approve the feature map before file moves. Physical iPhone verification remains required for background playback, lock-screen controls, gesture feel, animation equivalence and player appearance; automated tests do not establish those.

## Stage 1 outcome

JS-only dev dependencies: ESLint with Expo's flat config and Prettier. These do not add native modules and CI does not run the new lint/format commands. Lint remains advisory; baseline findings must be documented before considering it as a gate. Formatting commands require explicit file paths so they do not rewrite the tree by default.
