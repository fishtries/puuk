# Multi-artist iOS race fixes

The controller now tracks event freshness per affected track and retains its subscription across metadata updates. Bulk refreshes deduplicate relevant current, queue and history IDs, limit concurrent requests to four, and reject stale responses after a newer event for that ID, authentication or server change, or a playback context change. Credit patches update metadata without issuing playback operations. The inactive saved-track path uses a narrowly scoped hook with the same per-ID freshness and bounded request behavior, checks authentication and server context, and re-reads persisted state before applying an update.

Deterministic deferred-response regressions cover unrelated single events, disjoint bulks, newer same-ID events, user and server changes, playback and persisted-track switches, request deduplication and concurrency; existing playback assertions cover no play or seek during credit refresh. These tests mock network, storage and playback; they do not exercise a physical device.

Commands run from `app/ios/puuk-ios`:

- `npm test -- --runInBand hooks/__tests__/usePlayerController.test.js hooks/__tests__/useSavedCreditsSync.test.js`: exit 0, 2 suites and 51 tests passed.
- `npm test -- --runInBand`: exit 0, 50 suites and 603 tests passed.
- `npm run lint -- --no-cache`: exit 0.
- `npx expo export --platform ios --output-dir /tmp/puuk-ma-fixes-export`: exit 0, iOS bundle exported; Node printed NO_COLOR/FORCE_COLOR warnings.

Physical iOS playback, queue-position and accessibility smoke remains an external pending check. No deployment, production data changes, backend or web changes were performed.
