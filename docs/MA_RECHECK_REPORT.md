# Independent multi-artist fix recheck

2026-10-28. Independent recheck completed without implementation changes. **The original two P1 findings are closed by executed differential regressions, including the inactive saved-track variant; one additional P2 concurrency finding remains open.** This report supplements, rather than replaces, the risk-based backend/CLI/DTO audit in [MA_REVIEW_REPORT.md](MA_REVIEW_REPORT.md). Completion of this review does not mean all release gates passed.

## Open P2: inactive saved-track concurrency resets across effect lifetimes

`app/ios/puuk-ios/hooks/useSavedCreditsSync.js:13` creates a fresh `running` counter inside each effect. Cleanup at line 65 clears pending work and disables application of results, but neither cancels nor accounts for outstanding requests in the next effect. The dependency list at line 66 includes `currentUser` and `currentTrack`.

Executed reproduction on the fixed implementation: keep saved A inactive, send four bulk-A events with deferred network responses, render the hook with user 2 while those four requests remain outstanding, then send four further bulk-A events. **Eight `authFetch` calls are outstanding concurrently; the expected total cap of four fails.** The test then resolves every response and verifies the latest user's value wins; no stale saved-track write was observed. This is a resource/concurrency defect, not evidence of cross-user metadata application. Further repeated effect replacement can add further outstanding groups until requests settle; the actual API has 10-second per-attempt timeouts and GET retries, so this is not a claim of indefinitely pending production requests.

Exact repro: `/tmp/puuk-ma-recheck-ios/hooks/__tests__/independentSavedCredits.test.js`, test `keeps total requests capped at four across user-context replacement`:

```sh
cd /tmp/puuk-ma-recheck-ios
npm test -- --runInBand hooks/__tests__/independentSavedCredits.test.js -t 'total requests capped'
```

Exit **1**, expected `<= 4`, received `8`. Receipt: `/tmp/puuk-ma-recheck-context-concurrency.log`. The implementation needs request accounting that survives effect replacement, or cleanup cancellation with a demonstrated total bound; no implementation change was made here.

The controller does **not** have the analogous user-change reset: its credit subscription effect has empty dependencies and retains its counter. Executed test `controller keeps four-request cap across user change while old requests settle` starts four requests, changes users and emits another bulk, verifies no fifth request starts before an old one settles, then drains old/new requests and verifies only newest data applies. It passes on the fixed controller; maximum outstanding requests is four. Cross-hook aggregation and unmount/remount of the entire controller are outside that assertion.

## Differential verification and scope

Read the original findings and [MA_FIXES_REPORT.md](MA_FIXES_REPORT.md). Compared the reviewed 96-path `/tmp/puuk-ma-baseline/feature-changes.json` hashes to current sources: only three already-inventoried files changed since the prior review: `App.js`, `hooks/usePlayerController.js`, and its test. The new `hooks/useSavedCreditsSync.js` and test were also reviewed. Inventory receipt: `/tmp/puuk-ma-recheck-inventory-drift.json`. All inventoried backend/bot paths still match the prior reviewed hashes; their previous risk-based audit stands without another broad backend run. The pre-feature dirty baseline under `/tmp/puuk-ma-baseline/tree` has neither credits-event subscription in App/controller nor the saved-sync hook: the reviewed P1 paths were feature additions, not independently reproduced baseline defects.

The original review copy remains at `/tmp/puuk-ma-review-ios`. A fixed-source copy is `/tmp/puuk-ma-recheck-ios` with existing node_modules linked. Original controller probes were copied unchanged. The original saved-track test now mounts the actual `useSavedCreditsSync` hook; its delayed bulk A, unrelated single B, resolve A, and expected saved A=`New` assertion are preserved. No test decides correctness from matching source text.

Extended probes use stable catalog setters, explicit React `act` turns, deferred responses, independent completion of each response, actual emitted credits events, and mocked network/storage/audio boundaries. The pre-fix comparator `/tmp/puuk-ma-recheck-prefix-ios` uses the original controller and the exact original App effect body/dependencies wrapped as a hook so the same extended saved-track behavior assertions can run. It does not contain a simulated corrected algorithm.

| Executed scenario | Fixed result |
|---|---|
| Original delayed bulk A then unrelated single B, controller and inactive saved A | PASS; A becomes New |
| Original user-1 response resolved after switch to user 2 | PASS; previous-user metadata rejected |
| Unrelated bulk B during delayed A | PASS on controller and saved path |
| Newer same-ID single or bulk, resolving older response last | PASS on both paths |
| Disjoint current-A / queued-B bulks, separate render turns, either response order | PASS; both update |
| History A and current B bulk, resolving A first | PASS; both update without subscription-loss race |
| Server, user, logout switch | PASS; stale results rejected on both paths; saved path tested auth events and user prop replacement |
| Queue replacement, current track replacement, dismiss | PASS; stale current/queue/history/catalog data rejected |
| Persisted saved A switches to B; inactive track becomes active | PASS; no stale storage write |
| Delayed persisted-state read, followed by saved-ID switch or newer same-ID event | PASS; second read/freshness guard exercised |
| Twelve controller IDs, two overlapping-in-time bulks, duplicate ID | PASS; deduplicated, all responses drained, maximum four outstanding |
| Twelve same-saved-ID bulk events within one effect | PASS; maximum four outstanding, superseded pending work coalesced, latest applies |
| Controller user switch with four old requests outstanding | PASS; total remains four |
| Saved hook user replacement with four old requests outstanding | **FAIL / P2 above; eight outstanding** |

Credit-operation probes snapshot coordinator play and player play/pause/seek/replace/load/unload/release call counts after intentional setup/switch actions and assert no additional operations during event processing and response application. They also assert current time stays 27, titles are preserved, and catalog/current/queue/history metadata changes as appropriate. This verifies the controller boundary with a mocked coordinator/player; it does not prove native audio behavior. Source inspection confirms credit patching only copies the seven credit fields; coordinator `updateQueue` synchronizes metadata/cache/scheduler state rather than issuing player load/replace.

## Reproduced commands and receipts

All commands below were executed during this recheck; failing pre-fix probes are expected evidence, not passing verification.

- In `/tmp/puuk-ma-review-ios`: `npm test -- --runInBand hooks/__tests__/usePlayerController.test.js -t 'review:'`: **exit 1**, two P1 failures and one passing newer-same-ID control. `/tmp/puuk-ma-recheck-original-controller-prefixed.log`.
- Same directory: `npm test -- --runInBand hooks/__tests__/reviewAppRace.test.js`: **exit 1**, one failure (zero saved writes after bulk A/unrelated B). `/tmp/puuk-ma-recheck-original-saved-prefix.log`.
- In `/tmp/puuk-ma-recheck-ios`: `npm test -- --runInBand hooks/__tests__/usePlayerController.test.js hooks/__tests__/reviewAppRace.test.js -t 'review:|inactive saved'`: **exit 0**, four passing original behavior probes. `/tmp/puuk-ma-recheck-original-fixed.log`.
- In `/tmp/puuk-ma-recheck-prefix-ios`: `npm test -- --runInBand hooks/__tests__/independentCredits.test.js hooks/__tests__/independentSavedCredits.test.js`: **exit 1**, 21 failed / 8 passed / 29 total. The final added cross-effect P2 test is only in the fixed copy; all 29 shared probes have identical test source. `/tmp/puuk-ma-recheck-independent-final-prefix.log`.
- Same command in `/tmp/puuk-ma-recheck-ios`: **exit 1**, **29 passed / 1 failed / 30 total**; sole failure is the newly reproduced P2. Thus the 29 shared probes pass fixed behavior while 21 detect pre-fix defects; eight controls already passed pre-fix. `/tmp/puuk-ma-recheck-independent-final-fixed.log`.
- In repository `app/ios/puuk-ios`: `npm test -- --runInBand`: **exit 0**, 50 suites / 603 tests passed. `/tmp/puuk-ma-recheck-full-jest.log`.
- Same directory: `npm run lint -- --no-cache`: **exit 0**. `/tmp/puuk-ma-recheck-lint.log`.
- Same directory: `npx expo export --platform ios --output-dir /tmp/puuk-ma-recheck-export`: **exit 0**, 1685 modules, one 4.6 MB iOS Hermes bundle plus metadata/assets exported. `/tmp/puuk-ma-recheck-export.log`. Export is not a device launch or signed build.
- Repository `git diff --check`: **exit 0** before writing these report-only changes; repeated after reports.

The committed regression tests pass but did not combine saved-hook context replacement with outstanding-request concurrency. Their within-effect concurrency evidence should not be read as a process-wide bound. All temporary diagnostic tests and comparator copies remain available under `/tmp`; no repository test or implementation file was edited by this review.

Reviewed fixed implementation SHA256: controller `7e6d24e5afc6d9d8c96941bc5fe062d608df31d6fe4ead83ff48b71e35d910d5`; saved hook `0c0ce0d251183397d47f97eeab09c4bf54b94968189a9b25b8674807b77369cf`; App `c0dd89903c957b157ff0579fd4ed833a4394d2dcb6137405505d075d6cb6b7b5`.

## Remaining gates and limits

Close the P2 with a targeted fix and fresh independent verification before claiming a universal four-request bound. Original P1 T19 closures stand; T19 remains partial for the new concurrency finding and native playback gate.

Physical iOS playback/no audible restart, seek position, queue order/position, background/lock-screen behavior, VoiceOver/accessibility and large-preview device performance remain **untested**. No physical device, production mutation, deployment, commits, live Qdrant, or real audio writes were used in this recheck. Prior partial migration/rollout, backup/writer-quiescence/rollback gates, ambiguous correction review, and listening-quality limits still apply as documented in the original review and rollout preparation. Mocked storage/network timing proves the executed ordering cases, not every storage write interleaving or all possible app lifecycle permutations.

## Subsequent P2 closure

2026-10-28: [MA_FINAL_REQUEST_REVIEW.md](MA_FINAL_REQUEST_REVIEW.md) independently reproduces the exact P2 on the hash-matched old hook (8 outstanding), passes the unchanged probe on the current hook (maximum 4), and passes all 30 independent races, four original probes, eight additional lifecycle probes, full iOS Jest (608 tests), lint and export. The P2 above is now **closed for a single mounted hook across effect restarts**, not a global bound across hooks/remounts; original P1 closures stand, and physical-device/rollout gates remain untested or partial as detailed there.
