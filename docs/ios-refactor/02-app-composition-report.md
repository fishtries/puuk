# Stage 2: App Composition Report

**Status: accepted after user-reported device checks.**

## Changes

- Extracted the startup loading and mandatory signed-out screens into `components/AppAuthGate.js`.
- `App.js` retains initialization and authenticated composition. Startup ordering remains settings load, server URL setup, last-track restoration, audio-cache initialization, auth check, then auth-check completion. The auth listener is still registered alongside initialization and removed on unmount.
- Extracted only the loading and signed-out gate UI; `App.js` still owns bootstrap/lifecycle and authenticated composition. This is a partial reduction toward top-level composition, with no broader extraction in this stage.
- Player, navigation, modal composition, and player background were not moved or changed.

## Verification

- `npm test -- --runInBand`: passed, 25 suites and 297 tests.
- `npm test -- --runInBand components/__tests__/AppAuthGate.test.js`: verifies loading, mandatory signed-out login, and `onLoginSuccess` forwarding.
- `npm run lint -- App.js components/AppAuthGate.js`: passed.
- `npx expo export --platform ios --output-dir /tmp/puuk-ios-stage2-export`: passed; iOS bundle generated.
- `git diff --check`: passed.
- `npm run format:check -- App.js components/AppAuthGate.js`: reports existing `App.js` formatting mismatch. Only the new `components/AppAuthGate.js` was formatted to avoid whole-file formatting churn.

## Manual Device Checks

- User confirmed all listed checks on an iPhone 11 Pro running iOS 18.6.2.
- Startup loading, signed-out login gate, startup restoration, main navigation, global modals, and mini-player/full-player layer order: confirmed.
- Player appearance, gestures, animations, controls, and playback states: confirmed in Expo Go.
- Background playback and lock-screen/Control Center controls: confirmed in Expo Go.
- Evidence is user-reported; no video or automated device-test artifact was provided.

## Open Concerns

- No known functional concerns reported. The device checks were performed in Expo Go; no standalone IPA/device build was reported.
