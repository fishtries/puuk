# J07 senior corrective integration

2026-11-03 · Run `run_5c86d4feea71` · Task `task_cdf0a64145f7` · Dispatch `ctx_da03373dd25f`.

Local scoped correction completed; coordinator acceptance and Gate 813/J08 remain pending. No native build/runtime, device audio or Gate B acceptance is claimed.

## Trigger and correction

Received source `638fac...` failed the root public paused-Retry scenario, and fresh Jest baseline actually returned **exit 1: 86 passed / 1 timed out**. The junior report's 87/278 results predate its last manual-Retry edits; its report and historical rejected-snapshot review remain byte-identical and are not final-source proof.

Previously Retry called the general selection path and then waited with mutable shared callbacks. Paused loaded/seek presentation was treated as another pause, cancelling restoration; early loaded acknowledgements could disappear, and a null seek revision meant a new user seek in native.

Retry now owns one cancellable, bounded sequence for the existing logical request: fresh headers (at most 5 seconds), fresh remote installation, matching loaded readiness, technical seek with a real native revision, matching successful seek acknowledgement, then guarded resume only for the retained play intent. Zero-position and paused retries follow the same acknowledgement sequence. Concurrent taps return the same promise. All waits fit a fresh 30-second episode, timers are cleared locally, and cancellation/new source/auth/new pause/new user seek fences continuations and stale finally handlers. The latest accepted position and one-shot start/finish ledgers survive technical replacement. Pause does not autoplay; false, thrown, failed or timed-out restoration cannot resume.

Installed source identity remains authoritative during headers and changes in the synchronous installation boundary; per-attempt loaded readiness survives callbacks before command resolution. Automatic recovery also registers seek acknowledgement before issuing seek, accepts only matching recovery origin/revision, retains synchronous loaded events, and refuses replacement without a known revision. The automatic replacement cap and sustainable-progress/global-budget distinction remain covered. Structured numeric native HTTP statuses alone trigger auth/not-found handling; raw 404 message guessing was removed. Ad hoc console logging routes safe categories into the existing dev-only 200-entry ring. Late capable-player command completion cannot reinstall/resume a newer logical selection; legacy stale repair rechecks ownership around asynchronous operations.

## Scope and hashes

Only these repository files were authored:

- `app/ios/puuk-ios/utils/playbackCoordinator.js`
- `app/ios/puuk-ios/utils/__tests__/playbackCoordinator.test.js`
- `docs/IOS_PLAYBACK_J07_SENIOR_FIX_REPORT.md`

Exact received copies, junior report, historical review, root harness, hashes and dirty/untracked status are under `/tmp/puuk-playback/J07/senior-before/20261103T144212501193Z/`. Senior-only source/test diffs and raw verification artifacts are under `/tmp/puuk-playback/J07/senior-ctx-da033/`. No hook/cache/scheduler/native/lockfile changes, reset/clean, commits, deploys, service restarts, provider changes or audio writes were performed. The large foreign baseline was preserved.

| File | Received SHA-256 | Final SHA-256 |
|---|---|---|
| coordinator | `638fac291c02c63552c563c42d986658df7e26f87dd82dfa3c53eb0221b04bb4` | `65741867e211b5f8677e454a5ceb29bcbe72204701a0e0621d6707c29dd47f03` |
| tests | `3f79317c20a0b9856f8c6272c05dfe2fe66093b17382cd0b90959fe3db4266bd` | `39a58cbd217bab29db27e68707eb8bca52785e714cf89446a472b2b0637500c5` |
| junior report, unchanged | `e17a858c877bb7cbaea4d2dc6c9742ef9ee4c960d2d7a5090fbca767eeef8ed1` | same |
| historical review, unchanged | `f0de781bc4f18a5cb51ed5677e9050f66b1d27a576e03c11868f95d80b485919` | same |
| root harness, unchanged | `d6d904ed2b914edb3aa3b3ff91ab506eaa9955c1ab1fc368f4c19544de7537f3` | same |

The report's own final hash is recorded in `final-manifest.json` outside this document to avoid a self-referential hash.

## Verification

Final source: **123/123 focused tests; 339/339 combined playback tests in 9 suites; 14/14 root public cases, completed, real Node exit 0**. Both touched files pass syntax, formatting and ESLint. The repository normally ignores tests in ESLint, so test lint explicitly uses `--no-ignore` and declares the Jest/performance globals; no rules were weakened or repository lint configuration changed.

The 36 added cases use a direct event listener and stateful native-style boolean source/revision acceptance for the critical guards. Coverage includes active/paused/zero-position restoration, matching readiness/acknowledgement and synchronous events, rejection/throw/failure/timeouts, latest seek/pause/interruption, A→B and logout/auth/unmount/dismiss, deduplication and stale finally/settlement, no duplicate didStart, healthy resume/later stall, finite blip/replacement budgets and legacy explicit Retry. Old paused/concurrent Retry tests now emit real ready/seek acknowledgements; old recovery fixtures provide native revisions instead of relying on null technical guards.

The combined command selects `patchExpoAudio`, `audioCache`, `preloadScheduler`, `preloadSchedulerPressure`, `networkPolicy`, `streamUrl`, `playbackCoordinator`, `usePlayerController` and `PlayerNetworkBanner` suites. Exact command argv, cwd, UTC start, monotonic duration, actual exit, source hash and raw log SHA-256 for every run are in `/tmp/puuk-playback/J07/senior-ctx-da033/ledger.jsonl`; each run has a unique log.

| Evidence | Exit | Seconds | Result / log |
|---|---:|---:|---|
| `baseline-public` | 1 | 0.050 | `/tmp/puuk-playback/J07/senior-ctx-da033/baseline-public.log` |
| `baseline-jest` | 1 | 6.491 | `/tmp/puuk-playback/J07/senior-ctx-da033/baseline-jest.log` |
| `final-focused-3` | 0 | 1.686 | `/tmp/puuk-playback/J07/senior-ctx-da033/final-focused-3.log` |
| `final-syntax-product` | 0 | 0.022 | `/tmp/puuk-playback/J07/senior-ctx-da033/final-syntax-product.log` |
| `final-syntax-tests` | 0 | 0.022 | `/tmp/puuk-playback/J07/senior-ctx-da033/final-syntax-tests.log` |
| `final-public` | 0 | 0.053 | `/tmp/puuk-playback/J07/senior-ctx-da033/final-public.log` |
| `final-lint-tests` | 0 | 0.483 | `/tmp/puuk-playback/J07/senior-ctx-da033/final-lint-tests.log` |
| `final-lint-product` | 0 | 0.484 | `/tmp/puuk-playback/J07/senior-ctx-da033/final-lint-product.log` |
| `final-format-check` | 0 | 0.507 | `/tmp/puuk-playback/J07/senior-ctx-da033/final-format-check.log` |
| `final-combined` | 0 | 2.794 | `/tmp/puuk-playback/J07/senior-ctx-da033/final-combined.log` |

All failed runs remain preserved: `baseline-public.log`, `baseline-jest.log`, `retry-jest.log`, `early-auto-jest.log`, `precise-jest.log`, `expanded-jest.log`, `lint.log`, `combined-playback.log`, `boundary-focused.log`. The initial combined failure was `spawnSync /usr/bin/node EPERM` in 44 native-patch fixture cases (8 suites / 291 tests passed); the same combined argv passed after sandbox escalation, then the final revised-source run passed 339 tests. Earlier ESLint failure exposed existing missing globals and an undefined `options` reference in legacy stale repair; these were corrected in the owned module. Intermediate unit failures during correction are retained separately; none are presented as final passes.

## Remaining limits and next owner

This is synthetic JS/native-contract evidence, not actual AVPlayer scheduling, sound, Swift compilation or an installed binary/build ID. Linux has no Xcode or attached iPhone. The root harness uses synthetic boolean acceptance and monotonic timers; no root harness edit or weakening was made. Broader full-suite/export is reserved for independent S2 after J08 and was not run here.

No remaining failure in the scoped local acceptance checks is known. Coordinator must independently accept the final hashes before Gate 813/J08 proceeds; the hook/direct-listener/UI migration and independent S2/native/device verification remain with their assigned owners. Legacy playback is retained without attributed watchdogs, so its native completion ordering cannot gain v1 guarantees from these JS tests.
