# Stage 6: Player Boundary and Audio Invariants

**Owner:** Senior model  
**Dependencies:** Stages 0 and 2 accepted.

## Target

`usePlayerController`, audio coordinator/cache/preload utilities, `App` player composition, and existing player tests. This stage is a design/characterization stage; implementation is limited to missing focused tests explicitly approved by the coordinator.

## Change

Document the current public player interface and audio lifecycle before decomposition. Establish what the UI may request and what the playback runtime owns. The aim is a stable boundary that supports future transition modes without implementing them now.

## Constraints

- Preserve the current player’s appearance and behavior exactly, including ambient/color background, queue, history, lyrics, gestures, loading/network feedback, mini/full transitions, lock-screen controls, and like actions.
- Background playback already works. Do not replace/reconfigure it as part of this stage.
- Do not change `expo-audio`, audio mode, lock-screen metadata, preload timing, transition timing, cache behavior, normalization, or server calls.
- Do not design speculative DJ APIs. Record only the seam where a future transition strategy could be added without coupling it to presentation; leave implementation for a feature task with concrete requirements.
- Read exact Expo SDK 57 documentation before any Expo API change.
- Preserve current dirty player files, including the accepted background implementation.

## Ownership

Senior owns player design and all audio lifecycle decisions. Junior may inspect and report, but must not independently edit player control flow.

## Observable acceptance

Produce a concise contract covering:

- player commands/state consumed by UI;
- queue/history and current-track ownership;
- playback coordinator/cache/preload responsibilities;
- app/React lifecycle vs native/background audio lifecycle;
- lock-screen command path;
- error/loading/network state ownership;
- future transition extension point and explicitly deferred requirements.

Add characterization tests only for uncovered critical contracts that can be tested deterministically. State manual iPhone checks for background audio and lock-screen controls; note these are already-working behaviors, not new features.

## Report

Return contract, tests added/run, uncertainties and the smallest safe Stage 7 decomposition order. No broad player refactor in this stage.
