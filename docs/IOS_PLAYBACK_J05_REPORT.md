# J05 — PreloadScheduler and NetworkPolicy Gate A Implementation

Date: 2026-10-31.
Task: `task_8088a983f297`, Dispatch: `ctx_33c3bb81c8c9`, Run: `run_5c86d4feea71`.
Historical context: Follow-up to initial J05 dispatch `ctx_a4b2c048c94c` under `task_719aedb0700d`.
Author: Junior Gemini (assigned by coordinator after provider checkpoint).
Scope of ownership: `app/ios/puuk-ios/utils/preloadScheduler.js`, `app/ios/puuk-ios/utils/networkPolicy.js`, `app/ios/puuk-ios/utils/__tests__/preloadScheduler.test.js`, `app/ios/puuk-ios/utils/__tests__/preloadSchedulerPressure.test.js`, `app/ios/puuk-ios/utils/__tests__/networkPolicy.test.js`, and this report.

Status: **Gate A PreloadScheduler and NetworkPolicy contract fully implemented, queue bounding enforced, and verified locally; 8 test suites / 194 tests passed (64 scheduler/network targeted + 130 integration regressions). Swift compilation, iOS native runtime, and physical device acceptance remain NOT tested (Linux host only, build ID unknown).**

---

## 1. Executive Summary

1. **What was done:** Implemented Section 4.4 bounded queue admission and cleanup (`_trimDesiredQueue`) keeping latest desired current + lookahead + urgent requests $\le 3$ (`MAX_DESIRED_JOBS`), with older urgent requests settling their promises with `AbortError`. Eliminated silent dropping of settling tasks at size cap, ensuring all active cancelled tasks remain counted against `_capacity()` until their concrete `getOrFetch` download promise settles. Enforced the stable resume ramp constraint allowing strictly one job start before 1000 ms even if that job finishes early.
2. **What was found:** The coordinator's diagnostic harness (`/tmp/puuk-playback/J05/review-urgent-bound.cjs`) proved that 10 consecutive `preloadImmediate` calls under startup pressure previously queued all 10 items without bounding, because `MAX_DESIRED_JOBS` was only checked against `syncQueue` lookahead. With desirability ordering (`_compareDesirability`), the latest urgent requests are retained while older superseded urgent requests are cancelled with `AbortError`, reducing queued jobs from 10 to exactly 3.
3. **What's left:** J06 dynamic URL resolution and J07 PlaybackCoordinator integration to drive playback pressure and handle native stream status transitions. Physical device testing remains not tested.

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

---

## 3. SHA-256 Hashes of Owned Files

| File | SHA-256 |
|---|---|
| `app/ios/puuk-ios/utils/preloadScheduler.js` | `6874022b77061337fc2eb618cc8282026feaf565dd1af0bffadfaa17371d6791` |
| `app/ios/puuk-ios/utils/networkPolicy.js` | `360d5bd95c61f223fe498f527871d84c2487ebfce8820cbc9b2fbe86eca91b46` |
| `app/ios/puuk-ios/utils/__tests__/preloadScheduler.test.js` | `911ad73c015f85f6697b86bb03fdbf3c6412f5f595b12dbc65233ec7d1db4b67` |
| `app/ios/puuk-ios/utils/__tests__/preloadSchedulerPressure.test.js` | `6788598e567061b25e2bca161446c33135b3cb71c1c96097f45e31122a1eb225` |
| `app/ios/puuk-ios/utils/__tests__/networkPolicy.test.js` | `1958076c0bdaa722ff7dffb983372d0be34c88af3208c4fa0708e446db27ac14` |

Backups preserved in `/tmp/puuk-playback/J05/final-source/`.

---

## 4. Historical Failed-Checkpoint Provenance & Defect Resolutions

1. **Initial Inferhold turn interruption & unhandled rejections:** Early iterations had unhandled rejections when tasks were aborted during `cancelAll` before handlers were registered. Fixed by registering `.catch(() => {})` on underlying task promises and catching cancel rejections gracefully.
2. **Coordinator-proven unbounded queue defect (`review-urgent-bound.cjs`):** 10 rapid `preloadImmediate` requests under startup pressure produced `queue.length = 10` (stored in `/tmp/puuk-playback/J05/review-urgent-bound.json`). Resolved via `_trimDesiredQueue()` and monotonic sequence tracking (`_itemSeq`), keeping only the latest $\le 3$ desired items and rejecting obsolete requests with `AbortError`. Re-running the harness now outputs `{"scenario":"10 rapid urgent requests under startup pressure","queued":3,"active":0,"networkStarts":0,"desiredLimit":3}`.
3. **Silent dropping of `settlingTasks` entries:** `_holdSlotUntilSettled` previously returned if `this.settlingTasks.size >= MAX_ACTIVE_TASKS`, dropping truthful slot occupancy. Fixed by removing the cap check; admission is bounded at `_capacity()` via `_occupiedSlots()` (`activeTasks.size + settlingTasks.size`).
4. **Stable ramp early-completion bypass:** If job 1 completed at 300 ms, job 2 previously started before the 1000 ms ramp interval. Fixed via `this.rampStartedCount >= 1 => capacity = 0` during the ramp timer, ensuring strictly 1 job start occurs before 1000 ms.
5. **Universal cancellation slot holding:** Preemption of background tasks for urgent jobs, `syncQueue` force cancellation, and `cancelAll` all route through `_holdSlotUntilSettled`, preventing new jobs from starting while underlying concrete cache downloads abort.

---

## 5. Contract Implementation Ledger (Gate A §4.4)

| Contract Requirement | Implementation Detail | Test Verification |
|---|---|---|
| `setPlaybackPressure({ requestId, phase })` | Edge-triggered and idempotent per `requestId` + `phase`. Phases `startup`, `stalled`, `recovering`, `suspended` cancel active and queued background jobs once. Repeated status ticks do not trigger restart or repeated cancels. | `preloadSchedulerPressure.test.js` (`startup edge cancels active background jobs once...`) |
| Queue Bounding ($\le 3$ Desired Jobs) | `_trimDesiredQueue()` bounds desired queued jobs to `Math.max(1, MAX_DESIRED_JOBS - activeTasks.size)`. Obsolete urgent/lookahead jobs are cancelled with `AbortError`. | `preloadSchedulerPressure.test.js` (`rapid urgent requests under pressure bound queue to MAX_DESIRED_JOBS...`) |
| Bounded Cancellation Accounting | Cancelled active tasks are registered in `this.settlingTasks` and retain their slot against `maxConcurrent` until `task.downloadPromise` settles (resolves/rejects). Queued or urgent tasks wait until underlying teardown completes before launching. | `preloadSchedulerPressure.test.js` (`cancelled task holds slot until underlying cache promise settles; urgent queue waits`) |
| Active Cancel-Ignoring Promise Under Rapid Skips | When active task cancellation is deferred/ignored by cache, the slot remains occupied in `settlingTasks`. 10 rapid urgent skips queue at most 3 items and reject the older 7 with `AbortError`. The newest urgent request starts only after the cancel-ignoring task settles. | `preloadSchedulerPressure.test.js` (`rapid skips with active cancel-ignoring promise hold slot and bound queue until settlement`) |
| Stable Resume Ramp | On transition to `phase: 'stable'`, ramp timer (`stableRampMs = 1000`) is armed BEFORE first `_pump()`, permitting only 1 start before 1000 ms even if first job completes early. Second slot opens after 1000 ms. A new pressure edge clears the ramp timer. | `preloadSchedulerPressure.test.js` (`stable ramp allows only one start before 1000ms even if first job completes early`) |
| `cacheCurrent(track, options)` | Unified queue entry with `priority: 0.5` (`PRIORITY_CURRENT`), dedup per track, cancellable with `AbortError`. Eligibility delayed 5,000 ms after entering stable. Fits into the same bounded concurrency budget (max 2). | `preloadSchedulerPressure.test.js` (`cacheCurrent › enters the unified priority queue...`, `combined budget...`) |
| Native Stream Isolation | Native current audio stream is never registered as a scheduler task and is never cancelled by scheduler operations. | Code audit & invariant verification |
| Network Policy Clamping | `classifyNetworkPolicy` and `buildNetworkPolicy` provide safe clamping: unknown/cellular at most 1/1, Wi-Fi/Ethernet at most 2/2. Offline (`isConnected: false`) starts 0 jobs. Reconnect pumps once subject to pressure. | `networkPolicy.test.js` + `preloadSchedulerPressure.test.js` (`network constraints`) |

---

## 6. Verification and Evidence Ledger

Working directory: `/home/fish/projects/puuk/app/ios/puuk-ios`. Logs recorded in `/tmp/puuk-playback/J05/`.

| Command / Evidence | Exit | Duration | Result |
|---|---:|---:|---|
| `npx prettier --check utils/preloadScheduler.js utils/networkPolicy.js utils/__tests__/preloadScheduler.test.js utils/__tests__/preloadSchedulerPressure.test.js utils/__tests__/networkPolicy.test.js` (`format-check.log`) | 0 | 444.50 ms | passed |
| `npx eslint --no-config-lookup --config /tmp/puuk-playback/J05/eslint.config.cjs utils/preloadScheduler.js utils/networkPolicy.js utils/__tests__/preloadScheduler.test.js utils/__tests__/preloadSchedulerPressure.test.js utils/__tests__/networkPolicy.test.js` (`lint.log`) | 0 | 390.81 ms | passed |
| `npm test -- --runInBand utils/__tests__/preloadScheduler.test.js utils/__tests__/preloadSchedulerPressure.test.js utils/__tests__/networkPolicy.test.js` (`targeted-tests.log`) | 0 | 1172.33 ms | passed (3 suites, 64 tests) |
| `npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js utils/__tests__/preloadScheduler.test.js utils/__tests__/preloadSchedulerPressure.test.js utils/__tests__/networkPolicy.test.js utils/__tests__/playbackCoordinator.test.js hooks/__tests__/usePlayerController.test.js components/fullplayer/__tests__/PlayerNetworkBanner.test.js utils/__tests__/streamUrl.test.js` (`combined-tests.log`) | 0 | 2095.51 ms | passed (8 suites, 194 tests) |

---

## 7. Status Classification

- **Passed (Local):**
  - Edge-triggered playback pressure suspension and cancellation.
  - Strict bounded queue enforcement ($\le 3$ desired jobs) with `_trimDesiredQueue` across all admission paths.
  - Obsolete urgent promises settle with `AbortError`.
  - Truthful cancellation slot holding until underlying concrete cache promises settle without size-cap dropping.
  - Stable resume ramp strictly permitting 1 start before 1000 ms even with early completion.
  - Unified queue integration of `cacheCurrent` with priority 0.5 and 5 s eligibility delay.
  - Safe network policy clamping (unknown/LTE 1/1, Wi-Fi 2/2, offline 0).
  - Code formatting (Prettier) and linting (ESLint) zero warnings/errors.
  - 194 tests across 8 suites passing on the exact final revision.
- **Failed:** None in owned scope.
- **Not Tested:**
  - Swift compilation / Xcode linking (Linux host).
  - Native iOS device execution / audible output on physical iPhone (no connected device).
  - Gate B end-to-end device integration (pending J06, J07, J08, S2).
