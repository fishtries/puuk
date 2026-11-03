# iOS credits request bound fix

2026-10-28. The independently reproduced P2 is closed for the same mounted `useSavedCreditsSync` hook across user/current-track effect cleanup and restart. The exact independent probe first failed with eight outstanding requests, then passed after updating only its implementation copy. All 30 independent probes, 56 focused hook tests, full iOS Jest, lint and iOS export passed.

## Implementation and preserved behavior

`hooks/useSavedCreditsSync.js` now retains its running-request counter and current queue pump in a hook ref. Each effect still owns its pending map, per-ID versions, authentication epoch and application guards. Old work keeps its slot until its asynchronous chain reaches `finally`; cleanup does not decrement the counter. The completion calls the current effect's pump, so newly queued work starts as slots become available even when no further event arrives. Intermediate obsolete queues are discarded, and repeated pending work for the same saved ID remains coalesced.

Each request passes an `AbortSignal` through the existing `authFetch` options. Effect cleanup and authentication events abort obsolete requests; authentication events also clear obsolete pending work. Abort never releases a slot directly. Tests deliberately ignore abort or deliver its rejection later, so the bound does not depend on immediate network cancellation. Existing API timeout/retry behavior was inspected and retained without shared API changes.

Per-ID freshness, authentication/server checks, effect liveness, saved-ID re-read and the seven-field credit patch remain in place. A response from an obsolete effect cannot apply even if its ID/version matches a newer effect. Newer same-ID events still win, and disjoint events still survive. No playback code was changed.

Inspected the analogous controller path in `hooks/usePlayerController.js`: its credit subscription has empty dependencies, so user/current-track changes do not reset its existing counter. No controller implementation change was needed. A persistent regression now holds four old requests, changes users twice, replaces the queue/current track, queues six current IDs and drains all requests individually without more events. It observes maximum outstanding four, rejects stale current/queue/history/catalog updates, applies all six current results, preserves titles and time 27, and observes no extra coordinator play or player play/pause/seek/replace calls after setup.

Files changed by this task only:

- `app/ios/puuk-ios/hooks/useSavedCreditsSync.js`
- `app/ios/puuk-ios/hooks/__tests__/useSavedCreditsSync.test.js`
- `app/ios/puuk-ios/hooks/__tests__/usePlayerController.test.js`
- `docs/MA_REQUEST_BOUND_FIX_REPORT.md`

Existing unrelated work in this shared dirty tree was preserved. The controller implementation SHA256 remains `7e6d24e5afc6d9d8c96941bc5fe062d608df31d6fe4ead83ff48b71e35d910d5`, matching the recheck report. The saved hook's final SHA256 is `946dbcb26b76cc3a5b0ed26cd8ec184636061a7193ff048eff5116c2f2488379`.

## Persistent regressions

The existing 51 focused tests remain passing, with five additional cases:

- Repeated user and active/inactive current-track effect restarts with four requests outstanding, ignored abort, multiple obsolete queues, current queue waking from stale completion, maximum outstanding four, eventual drain and exactly one newest saved write.
- The same lifecycle with delayed abort rejection, retaining slots until actual settlement.
- Authentication events cancel old requests without freeing slots; current bulk drains and a newer same-ID single event supersedes it.
- Unmount aborts all outstanding requests, never starts obsolete pending work, and never writes stale results.
- Controller user/queue replacement overlap described above.

Saved-hook restart tests also hold a new-context request, restart effects again, and settle that obsolete request before the original requests. This exercises wake-up through more than one generation, without relying on completion order or an additional event to release the latest queue.

## Exact executed commands and receipts

Before changing implementation, in `/tmp/puuk-ma-recheck-ios`:

```sh
npm test -- --runInBand hooks/__tests__/independentSavedCredits.test.js -t 'total requests capped'
```

Exit **1**, expected <=4, received **8**; `/tmp/puuk-ma-request-bound-before.log`.

Copied only the corrected hook into that existing independent harness from the repository root:

```sh
cp app/ios/puuk-ios/hooks/useSavedCreditsSync.js /tmp/puuk-ma-recheck-ios/hooks/useSavedCreditsSync.js
```

The independent test source was not modified (SHA256 `e2c8ed886a83a3cd0e07b3fe3c9d16106d7c81c5b54918a308f5ee7194e244df`). In `/tmp/puuk-ma-recheck-ios`:

```sh
npm test -- --runInBand hooks/__tests__/independentSavedCredits.test.js -t 'total requests capped'
npm test -- --runInBand hooks/__tests__/independentCredits.test.js hooks/__tests__/independentSavedCredits.test.js
```

Both exit **0**. Exact P2 probe: **1 passed / 14 skipped**, `/tmp/puuk-ma-request-bound-exact.log`. Entire independent pair: **30 passed / 2 suites**, `/tmp/puuk-ma-request-bound-independent.log`. These rerun the existing P1 and context/freshness/playback boundary probes as well as P2.

In repository `app/ios/puuk-ios`, after all implementation and test changes:

```sh
npm test -- --runInBand hooks/__tests__/usePlayerController.test.js hooks/__tests__/useSavedCreditsSync.test.js
npm test -- --runInBand
npm run lint -- --no-cache
npx expo export --platform ios --output-dir /tmp/puuk-ma-request-bound-export
```

- Focused: exit **0**, **56 tests / 2 suites**; `/tmp/puuk-ma-request-bound-focused.log`.
- Full Jest, run once after final code/tests: exit **0**, **608 tests / 50 suites**; `/tmp/puuk-ma-request-bound-full-jest.log`.
- Lint, run once after final code/tests: exit **0**; `/tmp/puuk-ma-request-bound-lint.log`.
- Export, run once after final code/tests: exit **0**, **1685 modules**, one **4.6 MB** iOS Hermes bundle and metadata/assets; `/tmp/puuk-ma-request-bound-export.log`. Node emitted its existing `NO_COLOR`/`FORCE_COLOR` warning.
- Repository `git diff --check`: exit **0**; repeated after adding this report.

## Limits

The resource bound is per mounted hook lifetime across effect restarts, not across distinct hook instances or a complete unmount/remount. Cancellation remains best effort: if a dependency ignores cancellation and never settles, its slot stays occupied; eventual queue progress requires eventual settlement. Deferred tests demonstrate finite delayed/ignored abort, rejection, stale completion ordering and current queue drain, not every possible storage-write interleaving or app lifecycle permutation.

Network, storage and audio boundaries are mocked. Physical iOS playback/no audible restart, background/lock-screen behavior, queue position and accessibility smoke remain external checks; export is not a native device launch or signed build. No commits, deployment, production actions, backend/App/shared API changes or other documentation edits were performed by this task.
