# J06 — Dynamic Server URL, Server Switch Policy and Scheduler Pressure Regressions

Date: 2026-11-02.
Task: `task_7e3c5e365d56`, Dispatch: `ctx_3e913bf83daa`, Run: `run_5c86d4feea71`.
Author: Junior (dispatched worker in Orca).
Scope of ownership: `app/ios/puuk-ios/utils/streamUrl.js`, URL-only changes in `app/ios/puuk-ios/utils/playbackCoordinator.js` and `app/ios/puuk-ios/utils/preloadScheduler.js`, their test suites `utils/__tests__/streamUrl.test.js`, `utils/__tests__/playbackCoordinator.test.js`, `utils/__tests__/preloadScheduler.test.js`, `utils/__tests__/preloadSchedulerPressure.test.js` (explicit ownership extension per coordinator instruction `msg_dee1a7f74e76`), and this report.

Status: **Gate A Section 4.5 Dynamic URL and Server Switch contract + Section 4.4 scheduler pressure regressions fully implemented and verified locally; 8 playback test suites / 227 tests passed (123 targeted URL/coordinator/scheduler tests + 104 playback regressions). Physical iOS device acceptance and native AVPlayer streaming remain NOT tested (Linux host only, build ID unknown).**

---

## 1. Executive Summary

1. **What was done:**
   - Eliminated static singleton capture of `SERVER_URL` in `PlaybackCoordinator` and `PreloadScheduler`. Both modules now accept `{ serverUrl?, getServerUrl? }` (and `getStreamUrl?` in `PreloadScheduler`), preserving explicit URL injection for tests while dynamically resolving the current server configuration via live binding at new source installation and background task start boundaries.
   - Implemented the server switch policy: when an effective server change is detected at play/sync/start boundaries, incompatible queued/in-flight background tasks are cancelled, epochs (`this.epoch` in scheduler, `this.serverEpoch` in coordinator) are incremented/invalidated, and late old-origin results are fenced from publishing or altering state.
   - Maintained rerender safety so that an already-playing healthy native source is not interrupted or replaced on rerender, while genuine new track selections or force retries install from the updated server.
   - Resolved two scheduler contract 4.4 regressions confirmed by coordinator repro (`repro.cjs`):
     (1) On transition to `stable`, retained desired queue metadata (`lastCurrentTrack`, `lastUpNextQueue`) is re-synced so preloading resumes under the stable ramp;
     (2) `cacheCurrent` requested during pressure enforces the required 5 s eligibility delay after entering `stable` before download starts.
2. **What was found:**
   - Previously, `new PlaybackCoordinator()` and `new PreloadScheduler()` captured `SERVER_URL` at module evaluation/import time in their constructors. When `App.js` subsequently loaded settings from storage during cold start and invoked `setServerUrl(customUrl)`, the coordinator and scheduler remained permanently pinned to the default `DEFAULT_SERVER_URL` (`https://web.puuk.fun`). With the getter/resolver abstraction and invocation-time live binding, custom servers loaded after singleton construction immediately govern all subsequent stream creations, preloads, and queue synchronizations.
   - Furthermore, coordinator repro (`/tmp/puuk-playback/S2/scheduler-review/repro.cjs`) revealed that `stalled` pressure previously cleared `this.queue` without re-populating it upon `stable`, leaving 0 starts, and that `cacheCurrent` during pressure failed to arm the 5 s eligibility timer when entering `stable`. Both defects were verified and fixed.
3. **What's left:** J07 PlaybackCoordinator state/watchdog integration and J08 hook error handling. Physical device acceptance and native streaming on iPhone remain not tested.

---

## 2. Environment & Constraints

| Parameter | Value |
|---|---|
| OS | Linux 6.6 (x86_64) |
| Runtime | Node.js v26.12.0 / npm 12.2.1 |
| SDK Packages | expo ~58.0.19, expo-audio ~58.0.10, expo-file-system ~58.0.11 |
| iOS Build Environment | Xcode / xcrun absent on Linux host; build ID **unknown** |
| Physical Devices | None connected; device acceptance **not tested** |
| Shared Tree Policy | Baseline dirty/untracked files preserved; no clean/reset/commit/push |
| Scope Restriction | No App/auth API edits; changes strictly restricted to URL resolution and scoped scheduler fixes |

---

## 3. SHA-256 Hashes of Owned Files

### Baseline Hashes (Before Task Changes)
```
38e7bdd9312cd98679fca42d20498033aa421eecae6f7c3d2c006dfde352ad44  utils/streamUrl.js
13bf73b56db900bd733d5bc03f29f50f5f71bad644790ba694cb21851b5c29d5  utils/playbackCoordinator.js
6874022b77061337fc2eb618cc8282026feaf565dd1af0bffadfaa17371d6791  utils/preloadScheduler.js
156dc4e724c9673771bb1783ddf44c6ec6f11b3a1b63aeaa6313a0f70900d1e7  utils/__tests__/streamUrl.test.js
731ee3b86ec4a75a26d7774810e386394dcc030b10e363f36149948a5df448bb  utils/__tests__/playbackCoordinator.test.js
911ad73c015f85f6697b86bb03fdbf3c6412f5f595b12dbc65233ec7d1db4b67  utils/__tests__/preloadScheduler.test.js
6788598e567061b25e2bca161446c33135b3cb71c1c96097f45e31122a1eb225  utils/__tests__/preloadSchedulerPressure.test.js
```

### Final Hashes (After Task Changes)
```
16a8ad190c72d2e1ac3e820fb1134afb4767fcbc99bb239d71cf896ae3852c36  utils/streamUrl.js
332cd542d4e5dca5cb4748a05c223deee8a522d6c3363d5f94ee6cd41a6e9ae9  utils/playbackCoordinator.js
a7f25f10e838613f264e21481fabe61871cbf57e9bbbc3510b9b114795ac93d8  utils/preloadScheduler.js
3522fa18783ec4309102250f8d669c005d49ee7f3575b87be2d4dc071041900b  utils/__tests__/streamUrl.test.js
00be050e9b237f6e6fff15db303b2c1c9116714b89a4c06a13bca7edb39707a6  utils/__tests__/playbackCoordinator.test.js
5dd7ca08a3eb418aa7121bfc5db97a88d83ebbcf7395a07aeb42ba0384444611  utils/__tests__/preloadScheduler.test.js
d487a034da012836f434f4cf4795af792cafe14acfcf75f5c4288aa5546bb66a  utils/__tests__/preloadSchedulerPressure.test.js
```

Backups preserved in `/tmp/puuk-playback/J06/final-source/`.

---

## 4. Contract Implementation Ledger (Gate A §4.5 & §4.4)

| Requirement | Implementation Detail | Test Verification |
|---|---|---|
| `normalizeStreamUrl(track, serverUrl = SERVER_URL)` | Uses live imported binding `SERVER_URL` by default at invocation time. Cleans and trims trailing slashes and quotes. Normalizes relative stream paths (`/api/stream/:id`) and default paths (`/api/stream/:id`) under the resolved host. Falls back to `SERVER_URL` if `serverUrl` is empty or null. | `streamUrl.test.js` (`dynamically evaluates live SERVER_URL binding...`, `normalizes relative stream URL`, `strips trailing slashes...`) |
| `new PlaybackCoordinator({ serverUrl?, getServerUrl? })` | Fixed `_explicitServerUrl` for dependency injection when provided. Otherwise delegates dynamically to `_getServerUrl` (defaults to `() => (this._explicitServerUrl || SERVER_URL)`). Getter/setter `serverUrl` and `_resolveServerUrl()`. | `playbackCoordinator.test.js` (`explicit serverUrl option stays fixed...`, `getServerUrl option is called dynamically...`, `default coordinator instance resolves updated SERVER_URL...`) |
| `new PreloadScheduler({ serverUrl?, getServerUrl?, getStreamUrl? })` | Fixed `_explicitServerUrl` when provided. Explicit `getStreamUrl` remains authoritative in scheduler tests. Otherwise default closure dynamically evaluates `normalizeStreamUrl(t, this.serverUrl)`. | `preloadScheduler.test.js` (`explicit serverUrl option stays fixed...`, `explicit getStreamUrl remains authoritative...`, `getServerUrl option is called dynamically...`) |
| Server Switch Boundary Policy | Edge detection at `play()`, `syncQueue()`, `preloadImmediate()`, `cacheCurrent()`, and `_startDownload()` boundaries. Incompatible in-flight and queued FileSystem work is cancelled once (`_cancelAllBackgroundWork('server_change')`), background cache timers are cleared, and `epoch` is incremented. | `playbackCoordinator.test.js` (`server change at play boundary cancels background cache timers...`), `preloadScheduler.test.js` (`server switch cancels incompatible queued/in-flight tasks, bumps epoch...`) |
| Late Old-Origin Result Fencing | In `PreloadScheduler`, task attempt tokens are bumped upon cancellation and `item.epoch` is checked against pre-download epoch. In `PlaybackCoordinator`, `serverEpoch` is incremented on server switch and checked in `isCurrent()`, ensuring deferred replaces or cache callbacks cannot install or alter state. | `playbackCoordinator.test.js` (`deferred replace completing after server switch cannot install or alter new source state`), `preloadScheduler.test.js` (`server switch cancels incompatible queued/in-flight tasks, bumps epoch and fences late results`) |
| Healthy Playback Rerender Safety | "A healthy already-playing native source stays installed until a genuine user selection/retry or eligible recovery; rerender does not replace it." In `play()`, if `!options.force && !options.isUserSelection && this.currentTrackId === trackIdStr && this.currentPlayUri`, the healthy source is preserved across rerender and returns `reused: true`. Genuine selection or `force: true` retry installs from the new server. | `playbackCoordinator.test.js` (`already-playing healthy source is preserved across rerender without audio replacement, while new selection uses new server`) |
| Content-ID Cache Semantics | Persistent cache keys retain content-ID semantics (`trackId`). On server change, existing cached files on disk are immediately marked `READY` via `getCachedUri(item.trackId)` without re-downloading. | `preloadScheduler.test.js` (`persistent cache keys retain content-ID semantics across server change`) |
| Reschedule Retained Metadata on Stable (§4.4) | On transition to `phase === 'stable'`, if `this.lastCurrentTrack !== undefined`, scheduler calls `this.syncQueue(this.lastCurrentTrack, this.lastUpNextQueue, syncOpts)`, populating the queue from retained metadata so preloading resumes under the stable ramp. | `preloadSchedulerPressure.test.js` (`retained next queue reschedules and starts on transition to stable after pressure cancellation`), verified via `repro.cjs` |
| 5 s Cache Current Eligibility Delay (§4.4) | When entering `stable`, if a `current` cache job is queued or active, `this.currentCacheTimer` is armed for `currentCacheDelayMs` (5000 ms), guaranteeing 0 starts before 5 s. | `preloadSchedulerPressure.test.js` (`cacheCurrent requested during pressure observes 5s eligibility delay after entering stable`), verified via `repro.cjs` |

---

## 5. Verification and Evidence Ledger

Working directory: `/home/fish/projects/puuk/app/ios/puuk-ios`. Logs recorded in `/tmp/puuk-playback/J06/`.

| Command / Evidence | Exit | Duration | Result | Log File |
|---|---:|---:|---|---|
| `node --check utils/streamUrl.js` | 0 | 18.16 ms | passed | `syntax-check-streamUrl.log` |
| `node --check utils/playbackCoordinator.js` | 0 | 18.53 ms | passed | `syntax-check-coordinator.log` |
| `node --check utils/preloadScheduler.js` | 0 | 18.39 ms | passed | `syntax-check-scheduler.log` |
| `node --check utils/__tests__/streamUrl.test.js` | 0 | 17.33 ms | passed | `syntax-check-test-streamUrl.log` |
| `node --check utils/__tests__/playbackCoordinator.test.js` | 0 | 17.09 ms | passed | `syntax-check-test-coordinator.log` |
| `node --check utils/__tests__/preloadScheduler.test.js` | 0 | 17.71 ms | passed | `syntax-check-test-scheduler.log` |
| `node --check utils/__tests__/preloadSchedulerPressure.test.js` | 0 | 18.36 ms | passed | `syntax-check-test-pressure.log` |
| `npx prettier --check <7 owned files>` | 0 | 439.04 ms | passed | `prettier-check.log` |
| `npx eslint utils/streamUrl.js utils/playbackCoordinator.js utils/preloadScheduler.js` | 0 | 415.57 ms | passed | `eslint-check.log` |
| `npm test -- --runInBand <4 targeted suites>` | 0 | 1171.60 ms | passed (4 suites, 123 tests) | `jest-targeted.log` |
| `npm test -- --runInBand <8 playback suites>` | 0 | 1435.93 ms | passed (8 suites, 227 tests) | `jest-playback-suites.log` |

*Note on concurrent native R1 run:* Per coordinator message `msg_dfe997de163e`, an earlier full test run including `patchExpoAudio.test.js` failed on 3 native patch fixture assertions (`jest-combined.log`, exit 1) due to concurrent authorized native R1 edits underway by the native author. Final J06 verification was narrowed to owned suites and the 8 JS playback suites, all 227 tests passing.

### Test Breakdown (123 Targeted Tests)
- `utils/__tests__/streamUrl.test.js`: 10 passed (9 baseline + 1 live binding & fallback test).
- `utils/__tests__/playbackCoordinator.test.js`: 55 passed (49 baseline + 6 dynamic URL, server switch, rerender safety & stale replace fencing tests).
- `utils/__tests__/preloadScheduler.test.js`: 33 passed (27 baseline + 6 dynamic URL, server switch, authoritative stream URL & cache retention tests).
- `utils/__tests__/preloadSchedulerPressure.test.js`: 25 passed (23 baseline + 2 coordinator repro regression tests).
- Combined Playback Regression: 227 passed across 8 suites (`audioCache.test.js`, `preloadScheduler.test.js`, `preloadSchedulerPressure.test.js`, `networkPolicy.test.js`, `streamUrl.test.js`, `playbackCoordinator.test.js`, `usePlayerController.test.js`, `PlayerNetworkBanner.test.js`).

---

## 6. Status Classification

- **Passed (Local):**
  - Elimination of static `SERVER_URL` capture across coordinator and scheduler singletons.
  - Live binding evaluation of `SERVER_URL` for `normalizeStreamUrl`.
  - Dynamic server resolution at `play()` new source installation and background task start boundaries.
  - Stable explicit dependency injection for `{ serverUrl, getServerUrl, getStreamUrl }` in tests.
  - Server switch detection at play, sync, and start boundaries.
  - Cancellation of incompatible queued/in-flight background tasks and epoch invalidation on server switch.
  - Fencing of late old-origin results and errors in both coordinator (`serverEpoch`) and scheduler (`epoch`).
  - Rerender safety preserving already-playing healthy native audio streams without replacement.
  - Retention of content-ID persistent cache semantics across server changes.
  - Rescheduling of retained queue metadata on transition to `stable`.
  - Enforced 5 s cache current eligibility delay after entering `stable`.
  - Syntax check, Prettier formatting, and ESLint check exit 0 with zero warnings.
  - 123 targeted tests passed, 227 playback tests passed.
- **Failed:** None in owned scope.
- **Not Tested:**
  - Physical device verification on iPhone (Linux host only, build ID unknown).
  - Native AVPlayer streaming over Wi-Fi/LTE network interfaces.
