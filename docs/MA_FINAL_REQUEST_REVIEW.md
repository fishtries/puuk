# Independent final iOS credits request review

2026-10-28. **The saved-hook context-concurrency P2 is independently closed for one mounted hook across effect restarts; the original P1 closures remain valid. No additional in-scope correctness finding was identified.** This completes the requested source and automated review, not physical-device or rollout acceptance. Read with [MA_RECHECK_REPORT.md](MA_RECHECK_REPORT.md), [MA_REQUEST_BOUND_FIX_REPORT.md](MA_REQUEST_BOUND_FIX_REPORT.md), and the earlier [MA_REVIEW_REPORT.md](MA_REVIEW_REPORT.md).

## Exact differential reproduction

The prerequisite fix task `task_af916cdf3800` was already settled successfully before testing. The fixer had replaced the implementation in `/tmp/puuk-ma-recheck-ios`; that directory was not treated as an untouched pre-fix copy. Recovered the exact original hook from the Jest transform source map `/tmp/jest_rs/jest-transform-cache-9b933ecc1c4ea9646d7fcbd494774a7a-33e9a252a52783adb262261baf4dff05/c8/useSavedCreditsSync_c8bd4ccfba9bb7e4fc1787c9c4f881d1.map` (`sourcesContent`). Its SHA256 is `0c0ce0d251183397d47f97eeab09c4bf54b94968189a9b25b8674807b77369cf`, exactly the pre-P2 hash recorded in the recheck report. Preserved that source at `/tmp/puuk-ma-recheck-ios/hooks/useSavedCreditsSync.pre-request-bound.js` and temporarily installed it as the harness hook.

Executed the original, unchanged independent test:

```sh
cd /tmp/puuk-ma-recheck-ios
npm test -- --runInBand hooks/__tests__/independentSavedCredits.test.js -t 'total requests capped'
```

**Old hook: exit 1, expected <=4, received 8.** The test starts four deferred saved-A requests, replaces the user prop, emits four further A events, drains all responses and checks the newest saved value as well as the observed concurrency. Receipt: `/tmp/puuk-ma-final-request-before.log`.

Copied the actual repository hook into that same harness, then repeated the identical command:

```sh
cp app/ios/puuk-ios/hooks/useSavedCreditsSync.js /tmp/puuk-ma-recheck-ios/hooks/useSavedCreditsSync.js
```

**Current hook: exit 0, 1 passed / 14 skipped; maximum four.** Receipt: `/tmp/puuk-ma-final-request-exact.log`. The original independent test SHA256 remained `e2c8ed886a83a3cd0e07b3fe3c9d16106d7c81c5b54918a308f5ee7194e244df`; no assertion was weakened or rewritten. Also copied the current controller into the harness before running the full independent probes.

## Source review and additional behavioral coverage

`useSavedCreditsSync.js:11` stores running-request accounting and the current pump in a hook ref. User/current-track cleanup marks that effect dead, drops its queue, removes event/auth subscriptions and aborts its request controllers. Cleanup does not free slots. Each request retains its slot through fetch, body parsing and saved-state application; `finally` releases exactly one slot and calls the ref's latest pump. Thus obsolete completions wake current pending work without another event. Versions, auth epochs, server checks and effect liveness still prevent obsolete results from applying; the final saved-ID read prevents the tested persisted-track replacement races. Only the seven credit fields are copied.

The controller's credits subscription remains mounted with `[]` dependencies and its original accounting survives user/current-track changes. Its implementation hash is unchanged. Persistent regression tests cover repeated user/active/inactive restarts, obsolete queues, current-queue drain, ignored/delayed abort, auth changes, unmount and controller user/queue replacement. The 56 focused tests in the fix owner's receipt were inspected; all are also included in the independently rerun full suite below.

Added a separate temporary behavioral suite, `/tmp/puuk-ma-recheck-ios/hooks/__tests__/finalRequestLifetime.test.js`, without modifying the original independent tests or repository tests. **All eight cases passed**:

- Ignored abort and delayed abort rejection across repeated user/active/inactive restarts: no fifth request until old settlement; only the latest pending generation starts, without a new event; newest data survives remaining stale completions.
- Deferred response body: a resolved fetch with unfinished JSON retains its slot across cleanup; settling the body wakes the latest queue and cannot write obsolete metadata.
- Unmount during the second persisted-state read: late read/response completion causes no saved write, no stranded pending request starts, and the auth subscription is removed.
- Fetch rejection, non-OK HTTP response and JSON rejection each release their slot and start queued work without an additional event; latest metadata eventually applies.
- Complete unmount/remount with ignored abort observes eight combined outstanding transports, four belonging to each hook lifetime; obsolete results still do not write.

These use deferred network/storage boundaries and real emitted credits events, not source-text assertions. Saved title and position remain intact. The original controller probes additionally assert current/queue/history/catalog behavior, time 27 and no additional mocked audio/coordinator operations.

## Executed verification

All commands in this table were executed independently in this final review. Exit codes were captured from the commands, not inferred from log text.

| Directory / command | Result | Receipt under `/tmp/` |
|---|---|---|
| Harness: exact P2 command above, old hook | Expected exit 1; 8 outstanding | `puuk-ma-final-request-before.log` |
| Harness: exact P2 command above, current hook | Exit 0; 1 pass | `puuk-ma-final-request-exact.log` |
| Harness: `npm test -- --runInBand hooks/__tests__/independentCredits.test.js hooks/__tests__/independentSavedCredits.test.js` | Exit 0; **30 passed / 2 suites** | `puuk-ma-final-request-independent.log` |
| Harness: `npm test -- --runInBand hooks/__tests__/usePlayerController.test.js hooks/__tests__/reviewAppRace.test.js -t 'review:|inactive saved'` | Exit 0; **4 original probes passed** | `puuk-ma-final-request-original4.log` |
| Harness: `npm test -- --runInBand hooks/__tests__/finalRequestLifetime.test.js` | Exit 0; **8 passed** | `puuk-ma-final-request-lifetime.log` |
| Repository iOS: `npm test -- --runInBand` | Exit 0; **608 passed / 50 suites** | `puuk-ma-final-request-full-jest.log` |
| Repository iOS: `npm run lint -- --no-cache` | Exit 0 | `puuk-ma-final-request-lint.log` |
| Repository iOS: `npx expo export --platform ios --output-dir /tmp/puuk-ma-final-request-export` | Exit 0; **1685 modules**, one **4.6 MB** iOS Hermes bundle plus assets/metadata | `puuk-ma-final-request-export.log` |
| Repository: `git diff --check` | Exit 0 before and after report edits | Final invocation captured in `puuk-ma-final-request-diff-check.log` |

The fix owner's existing final receipts were also checked: focused **56/2**, full **608/50**, clean lint and successful iOS export, all produced after its final source/test edits. They agree with this review's rerun. Export produced the same bundle filename, `index-b65c5a609aa9a852ef57ae824cc026fc.hbc`. The existing Node color-environment warning was nonfatal.

Compared all **49** backend/bot source paths in `/tmp/puuk-ma-baseline/feature-changes-final.json` against their recorded current hashes: **zero drift**, receipt `/tmp/puuk-ma-final-request-backend-inventory.json`. No backend implementation was unexpectedly affected; broad backend suites were not repeated.

Reviewed current SHA256 values:

- Saved hook: `946dbcb26b76cc3a5b0ed26cd8ec184636061a7193ff048eff5116c2f2488379`.
- Controller: `7e6d24e5afc6d9d8c96941bc5fe062d608df31d6fe4ead83ff48b71e35d910d5`.
- Persistent saved-hook tests: `b7226c539412e2b27ef954a5b4d83444551382ac0a47f934a20bd84e7388962b`.
- Persistent controller tests: `2730db225c5057db429f06814faea8188a59c3dd093449a25b92da98d8a6b97f`.
- Additional independent lifetime suite: `fbdfbd800b8052cf8a195462683afa43de15bbe90ca7822100e2a35282603517`.

## Acceptance boundary and remaining gates

The proven bound is **four hook-owned asynchronous credit request chains per mounted saved-hook lifetime, including requests from obsolete effects**. The controller has its own four-request budget. This is **not a shared transport pool or a global process bound across hooks, concurrent hook instances or complete remounts**. The explicit remount probe observes eight outstanding when old cancellation is ignored; this is outside the fix's accepted bound and is not presented as another in-scope P2. Sequential retries and the existing API signal/timeout handling were inspected; cancellation remains best effort. A dependency that never settles retains its slot, so queue progress requires eventual settlement.

For the tested delayed responses/reads, unmount prevents subsequent write initiation. It cannot undo an asynchronous storage write already initiated before cleanup; arbitrary storage-write commit interleavings are not proven. The harness mocks storage, network and audio. Export is neither a signed native build nor a device launch.

**Final acceptance: original automated P1 regressions closed; saved-hook P2 closed within the stated mounted-lifetime scope; no open finding from this final review. T19 remains partial for physical-device acceptance.** Physical iOS playback/no audible restart, actual seek position, queue order/position, background/lock-screen behavior, VoiceOver/accessibility and large-preview device performance remain untested. Prior migration/rollout, backup, writer-quiescence, rollback, ambiguous correction and listening-quality gates remain as documented in the earlier review and rollout preparation.

This review changed only this document and appended a closure reference to `MA_RECHECK_REPORT.md`. All diagnostic probes/source substitutions were confined to `/tmp`; no implementation edits, subworkers, commits, deployment or production operations were performed.
