# J07 — PlaybackCoordinator: Confirmed Playback Start, Recovery and Native Source Identity (Junior Handoff Report)

Date: 2026-11-03.
Task: `task_9db4f503d3d3`, Dispatch: `ctx_3ccccfe05c2c`, Run: `run_5c86d4feea71`.
Author: Junior (dispatched worker in Orca).
Scope of ownership: `app/ios/puuk-ios/utils/playbackCoordinator.js`, `app/ios/puuk-ios/utils/__tests__/playbackCoordinator.test.js`, and this report.

Status: **FAILED (Junior pass concluded per coordinator msg_221522de04df / msg_45a0697ea55d; 13/14 scenarios in `final-public-check.cjs` passed, 87/87 unit tests passed; manual retry position restoration sequence handed off to senior integration).**

---

## 1. Executive Summary

1. **What was done:**
   - Completed junior implementation across Gate A Sections 4.1, 4.2, 4.6 in `PlaybackCoordinator`:
     - Defect 1 (`strict_nonprogress`, `native_text_stays_generic`): Strictly required `nativeEvent: 'progress'` with advancing finite `currentTime` and `nativeIntent: 'play'` for start confirmation; eliminated text-based auth/not-found guessing in `classifyPlaybackError` (only structured numeric HTTP statuses 401/403/404 classify as auth/not-found).
     - Defect 2 (`obsolete_header_failure_cannot_fail_new_track`): Guarded all asynchronous catch and timeout paths in `_performRecovery` with `isStale()`, preventing late header rejection on an obsolete track from terminating newly selected tracks.
     - Defect 3 (`obsolete_retry_cannot_seek_new_track`): Added `_retryGeneration` and generation revalidation in `_doRetryCurrent`, preventing old retry continuations from issuing seek commands to newly selected tracks.
     - Defect 4 (`hard_selection_deadline`, `budget-repro`): Enforced independent hard 30s global episode deadline with clamped startup watchdogs, terminating at exact 30,000 ms without overshoot.
     - Defect 5 (`equal_revision_progress_cannot_undo_pause`): Enforced that progress events cannot confirm playback or transition to playing while pause is intended.
     - Defect 6 (`healthy_resume_does_not_expire`): Reinitialized sustainable proof state on resume so healthy playback continuing past 30s does not falsely expire.
     - Defect 7 (`legacy_resume_no_false_timeout`): Completely disabled attributed watchdogs for legacy players without native identity capability.
   - Preserved all drafts and previous failure artifacts under `/tmp/puuk-playback/J07/`.

2. **What was found:**
   - On the coordinator's public acceptance harness (`/tmp/puuk-playback/J07/root-review/final-public-check.cjs`), 13 of 14 scenarios pass.
   - One scenario remains failing: `manual_retry_waits_loaded_seek_then_resume` (line 202: `manual retry did not seek after loaded (paused=true): 0 !== 1`). While `paused=false` successfully waits for loaded, issues seek, and resumes, the `paused=true` branch does not successfully execute the seek command following loaded emission in the harness.
   - Per coordinator instruction `msg_221522de04df` / `msg_45a0697ea55d` and user directive, the junior pass is concluded honestly as `failed` with exact state preserved for senior integration.

3. **What's left:**
   - Senior integration to complete the manual retry position restoration sequence for paused items (`_doRetryCurrent` handling of `loaded` before guarded technical seek).
   - J08 Hook integration (`usePlayerController.js`) and UI banner rendering (`PlayerNetworkBanner.js`).
   - Physical device acceptance and native streaming on iPhone (Linux host only).

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
| Scope Restriction | Changes strictly restricted to `playbackCoordinator.js` and `playbackCoordinator.test.js` |

---

## 3. SHA-256 Hashes of Owned Files

### Historical Baseline Hashes
```
332cd542d4e5dca5cb4748a05c223deee8a522d6c3363d5f94ee6cd41a6e9ae9  app/ios/puuk-ios/utils/playbackCoordinator.js (before task)
00be050e9b237f6e6fff15db303b2c1c9116714b89a4c06a13bca7edb39707a6  app/ios/puuk-ios/utils/__tests__/playbackCoordinator.test.js (before task)
ab81abf7a3e38775d83e03d3fd1be36eaf60d0d5d30c0a339b278f172b946ee5  app/ios/puuk-ios/utils/playbackCoordinator.js (round 1 rejected candidate)
ce95f96884d408648a9ef5ad77bc86ae3b9eb167e2eb93e207f2edbfa7dfed36  app/ios/puuk-ios/utils/playbackCoordinator.js (round 2 rejected candidate)
```

### Current Handoff Hashes
```
638fac291c02c63552c563c42d986658df7e26f87dd82dfa3c53eb0221b04bb4  app/ios/puuk-ios/utils/playbackCoordinator.js
3f79317c20a0b9856f8c6272c05dfe2fe66093b17382cd0b90959fe3db4266bd  app/ios/puuk-ios/utils/__tests__/playbackCoordinator.test.js
```

Backups preserved in `/tmp/puuk-playback/J07/junior-final-draft/` and `/tmp/puuk-playback/J07/round2-before/`.

---

## 4. Acceptance Harness Ledger (`final-public-check.cjs`)

| Check | Result | Detail |
|---|---|---|
| `strict_nonprogress` | **PASSED** | `loaded`, `snapshot`, `finish` events never confirm playback |
| `pause_during_initial_headers` | **PASSED** | User pause while initial headers are pending prevents autoplay |
| `stale_play_after_logout` | **PASSED** | Request cancelled by logout cannot be resumed by stale intent |
| `get_headers_binding` | **PASSED** | `options.getHeaders` provider alias invoked and passed to source |
| `distinct_selection_ids` | **PASSED** | A -> B -> A user selections allocate distinct globally unique `requestId`s |
| `legacy_resume_no_false_timeout` | **PASSED** | Capability-missing player plays past 40s without attributed watchdog error |
| `hard_selection_deadline` | **PASSED** | Unconfirmed source terminates at exact 30,000 ms global episode deadline |
| `native_text_stays_generic` | **PASSED** | Unstructured error strings without numeric HTTP status remain generic playback errors |
| `obsolete_header_failure_cannot_fail_new_track` | **PASSED** | Late header failure on obsolete Track A does not terminate active Track B |
| `obsolete_retry_cannot_seek_new_track` | **PASSED** | Delayed retry on Track A does not seek newly selected Track B |
| `equal_revision_progress_cannot_undo_pause` | **PASSED** | Stale equal-revision progress with play intent cannot undo active pause |
| `healthy_resume_does_not_expire` | **PASSED** | Resumed healthy playback re-evaluates sustainable proof and survives 30s |
| `recovery_seek_rejected_or_timedout_never_resumes` | **PASSED** | Rejected seek or seek timeout in recovery terminates without calling `playForAttempt` |
| `manual_retry_waits_loaded_seek_then_resume` | **FAILED** | Position restoration on paused retry did not execute seek after loaded (`0 !== 1`) |

---

## 5. Verification and Evidence Ledger

Working directory: `/home/fish/projects/puuk/app/ios/puuk-ios`. Logs recorded in `/tmp/puuk-playback/J07/logs/`.

| Command / Evidence | Exit | Duration | Result | Log File |
|---|---:|---:|---|---|
| `node --check utils/playbackCoordinator.js` | 0 | 20.83 ms | passed | `syntax-check-coordinator-round2.log` |
| `node --check utils/__tests__/playbackCoordinator.test.js` | 0 | 20.32 ms | passed | `syntax-check-tests-round2.log` |
| `npx prettier --check utils/playbackCoordinator.js utils/__tests__/playbackCoordinator.test.js` | 0 | 420.91 ms | passed | `prettier-check-round2.log` |
| `npm test -- --runInBand utils/__tests__/playbackCoordinator.test.js` | 0 | 1073.11 ms | passed (87/87 tests) | `test-coordinator-round2.log` |
| `npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js utils/__tests__/audioCache.test.js utils/__tests__/preloadScheduler.test.js utils/__tests__/networkPolicy.test.js utils/__tests__/streamUrl.test.js utils/__tests__/playbackCoordinator.test.js hooks/__tests__/usePlayerController.test.js components/fullplayer/__tests__/PlayerNetworkBanner.test.js` | 0 | 2698.06 ms | passed (278/278 tests) | `test-all-playback-round2.log` |
| `node /tmp/puuk-playback/J07/root-review/budget-repro-fixed.cjs` | 0 | 41.50 ms | passed (exact 30000ms termination) | `/tmp/puuk-playback/J07/root-review/budget-result-fixed.log` |
| `PLAYBACK_REVIEW_SOURCE=... node /tmp/puuk-playback/J07/root-review/final-public-check.cjs` | 1 | 47.44 ms | 13 passed / 1 failed | `final-public-check-round2.log` |

---

## 6. Honest Passed / Failed / Not Tested and Senior Handoff

- **Passed locally:**
  - 87/87 unit and contract tests in `playbackCoordinator.test.js`.
  - 278/278 combined playback tests across 8 test suites without regression.
  - 13/14 scenarios in coordinator public review harness (`final-public-check.cjs`).
  - Full JavaScript syntax and code formatting checks.

- **Failing invariant / Senior handoff:**
  - `manual_retry_waits_loaded_seek_then_resume` in `final-public-check.cjs` fails on paused retry seek restoration: when `paused=true`, `seekCalls` equals 0 instead of 1 after `loaded` emission. Senior integration will own the final repair for this item.

- **Not tested:**
  - Native Swift compilation and AVPlayer / AVQueuePlayer link-time validation (no Xcode on Linux).
  - Physical iPhone device acceptance and audible audio output (candidate device required for J09).
  - J08 Hook integration (`usePlayerController.js`) and UI banner rendering (`PlayerNetworkBanner.js`).
