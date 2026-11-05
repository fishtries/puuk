# J09 — physical iPhone acceptance disposition

2026-11-05 Moscow / 2026-11-04 UTC evidence. Task `task_ed096f21f5d4`, Dispatch `ctx_ca01c7da2dd5`, Run `run_5c86d4feea71`.

**Report-only disposition: COMPLETE. Physical acceptance: BLOCKED / NOT TESTED. All 11 device scenarios remain not tested; zero baseline/candidate playback starts, latency measurements or audible-output observations were collected. Gate B native/device acceptance and playback incident closure remain open.** This is an honest unavailable-device disposition, not successful physical J09 execution.

## Scope, prerequisites and evidence

Read root/iOS AGENTS, the complete J09 card, plan sections 2–4 including accepted Gate A, [S1 report](IOS_PLAYBACK_S1_REPORT.md), [final S2 report](IOS_PLAYBACK_S2_REPORT.md), final source/native manifests and build/install instructions. Continued the previously loaded orchestration and release-it guidance. Coordinator supplement `msg_8ffb05243580` reuses the independent senior for this **report-only** task; it does not claim the planned junior ran device tests. Ownership is this report and `/tmp/puuk-playback/J09/` only; the plan and product are unchanged.

Fresh bounded availability evidence (`availability.json`, `availability-host.log`, `commands.jsonl`): Linux; swift/swiftc/xcodebuild/xcrun/eas/devicectl are absent from PATH. idevice_id and ideviceinfo are installed, but **one** `idevice_id -l` invocation exited **255**, returned no enumerated devices and was classified as device enumeration unavailable. This establishes no usable physical-device session here; it does not prove no phone exists elsewhere. No raw stdout/stderr or device identifiers were retained. No identified native binary or installed candidate was supplied, so the mandatory physical-device + identified-build prerequisite is unsatisfied independently of tool availability. No simulator, Expo Go, mock, JS test or export was substituted.

| Fresh evidence command | Cwd | UTC start | Exit | Seconds | Result |
|---|---|---|---:|---:|---|
| `python /tmp/puuk-playback/J09/probe.py` | `/home/fish/projects/puuk` | 2026-11-04T21:36:19.804936+00:00 | 0 | 0.068131 | Availability/source inspection completed; **not a device test pass** |
| Nested `idevice_id -l` (10-second bound) | `/home/fish/projects/puuk` | 2026-11-04T21:36:19.835989+00:00 | 255 | 0.002080 | Device enumeration unavailable; no identifiers retained |

The parent ledger records exact argv/cwd/start/end/elapsed/exit/log hash and before/after hashes of all candidate app/native paths plus governing manifests/reports/plan. The nested child has its own sanitized command/timing/exit record. Source hashes are unchanged during this inspection. Probe exit 0 means the inspection/reporting code completed; the child failure is explicitly retained and does not become passed device acceptance.

## Candidate identity

Accepted **source-only** candidate: `sha256:798418c223c9836646ecba3fb4d0bde370bd42d4bd717d399c0a45c204239312`. Fresh read-only comparison matches **163/163 app files and 16/16 installed native Swift sources**. This is not compiled or installed build identity.

Durable handoff: [source manifest](IOS_PLAYBACK_CANDIDATE_MANIFEST.json), [native manifest](IOS_PLAYBACK_NATIVE_MANIFEST.json), [build/install instructions and standalone verifier](IOS_PLAYBACK_BUILD_INSTALL.md). Final S2's 931 host tests and Hermes export remain historical local evidence for this candidate, not iPhone results; neither was rerun in J09.

| Identity field | Value / evidence |
|---|---|
| Device model / iOS version / physical network / cache state | **unknown / not observed** |
| Native compiled binary / installed build ID / runtime capability | **unknown / not tested** |
| Configured version / bundle / build number | 1.0.0 / `com.fishtries.puuk` / 1; configuration only |
| Baseline installed binary identity | **unknown**; no comparable baseline device run available |
| Source manifest SHA-256 | `3d09fcaafba5b3165415982b42677a81ffc32d9f48356711ddd256daf0720055` |
| Native manifest SHA-256 | `b573778aeaba375a301b4827b053622815e89144a93e27eefb51bfc3eb60b380` |
| Lockfile SHA-256 | `ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd` |
| Native producer SHA-256 | `d7c6085b16aaafd9bff698c256b67e6959ffc1435e27c2e74c0bcd2bfce0ad89` |
| Expected MediaController source SHA-256 | `e270b82a708b56be4084ffd8dfa4e17dd16c3017f494aaccec793b3b254575b6` |

## Required physical matrix

Every row is blocked by the missing physical session and identified installed build. Device/iOS/build, network/cache, first progress, recovery and sound are explicitly unobserved per row; no synthetic result or zero-duration latency is inserted. `matrix.json` preserves these same fields as null with `status: not tested` and zero observed samples. The availability log supports the common blocker; there are **no scenario execution logs**.

| # / scenario | Required behavior | Device / iOS / installed build | Network / cache state | First confirmed progress | Recovery outcome | Audible sound | Result |
|---|---|---|---|---|---|---|---|
| 1. Cold start with saved custom endpoint | Catalog, stream and preload use the saved endpoint | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 2. Cached and uncached track on Wi-Fi and LTE | Local hit starts locally; remote starts without waiting for full download | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 3. Slow network and limited bandwidth | Current playback retains priority over speculative downloads; record real delay | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 4. Complete disconnection, then reconnect | Finite error/recovery; no endless spinner or retry storm | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 5. Wi-Fi ↔ LTE during startup and mid-track | Preserve current intent and latest position through transition | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 6. Pause/seek during loading and recovery | No spontaneous resume or jump to zero | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 7. A → B → A and 10 rapid skips | Latest selection owns sound/metadata; background jobs remain bounded | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 8. Faulty cached source in a test environment | Exact-copy invalidation, remote fallback, healthy subsequent selection | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 9. 401, 404 and transient 5xx in a test environment | Distinct outcomes and permitted retries; production token remains valid | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 10. Lock screen: five transitions, next track uncached | Background transition confirmed; pause/next work; measure inter-track gap | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |
| 11. Bluetooth disconnect/reconnect and system interruption | Stop/resume respects intent and does not masquerade as buffering | unknown / unknown / unknown | unknown / unknown | not measured | not observed | not tested | **not tested** |

## Startup samples and transport comparison

| Revision | Source class | Required starts on stable network | Collected n | Median | p95 | Result |
|---|---|---:|---:|---|---|---|
| Baseline | Local cache | ≥10 | 0 | not measured | not measured | not tested |
| Baseline | Remote uncached | ≥10 | 0 | not measured | not measured | not tested |
| Candidate | Local cache | ≥10 | 0 | not measured | not measured | not tested |
| Candidate | Remote uncached | ≥10 | 0 | not measured | not measured | not tested |

No baseline/candidate performance difference or startup SLO can be calculated from n=0. When observations exist, retain each monotonic selection-to-first-matching-advancing-progress value; report sample size, median and nearest-rank p95 (`ceil(0.95*n)` in sorted one-based samples), failures/timeouts separately, and whether audio was actually heard. Keep Wi-Fi/LTE and differing cache/device/build conditions separate; do not mix incompatible samples to manufacture a comparison. Senior accepts an eventual SLO from actual measurements, not the diagnostic budgets alone.

No production/network request or new transport comparison was performed. Gate A interprets J02's 58 historical server-originated requests and 36 exact body comparisons for three files as bounded server diagnostics only. They cannot serve as current iPhone-path, identified-binary, latency or audible-output evidence. No discrepant candidate transport observation exists to justify repeating production queries in this report-only task.

## Concrete handoff to the authorized builder/device operator

1. Obtain authorized Mac/Xcode/signing and a physical iPhone session. Use the linked build/install document to verify every app/lockfile/native producer/output hash before and after dependency installation. Build the matching candidate and record Xcode/SDK versions, build command/result, app-bundle SHA-256, Mach-O/dSYM UUID, bundle ID and actual version/build. Record model and iOS version with a nonidentifying device label; do not place signing material or device identifiers in reports. If source changes, assign a new candidate and obtain corresponding review. Existing simulator-oriented build profiles, configured build number, Expo Go and older binaries do not establish installation of this custom native patch.
2. Identify the actual installed binary and verify native runtime `puukSourceIdentityVersion === 1` plus synchronous boolean `replaceWithAttempt`, `playForAttempt`, `seekForAttempt`. Observe actual source-attributed events for real selections, including distinct attempts for same-URI retry and A/B/A. An old/partial-capability binary must retain legacy playback with automatic attributed recovery disabled, and cannot be accepted as this candidate. Record any baseline binary separately before attempting a before/after comparison.
3. Prepare designated fixture tracks and an isolated fault/network environment. Record exact network class and cache state per start without SSID/IP/tokens. Preserve the user's full cache; use known cached fixtures or address only the relevant fixture copy. Do not corrupt original audio, clear the full cache, revoke a production token or alter production services to induce failures. Fault responses 401/404/5xx belong in the test environment.
4. Execute every matrix row on that installed candidate. Record monotonic selection time, first **matching source** progress with `isLoaded:true`, `playing:true`, native play intent and finite advancing position, and separately observe audible output. Replace/play acceptance, loaded, seek jumps and metadata are not proof of audio. Keep logical request/attempt, intent/seek revisions, safe error category, cancellation/recovery outcome, native replacements, background task count and inter-track gaps without raw URL/query/header/native-error text.
5. Explicitly probe queued immutable loaded0/error0/play-intent1 delivery and initial-error guard veto; native/user pause or seek during headers/loaded/seek restoration; latest-source A/B/A/rapid skip; paused Retry followed by explicit Play where native play intent was never admitted; failed/false/timed-out seek; no-resume and overlapping lifecycle/system/route interruptions; first unducked volume retention; and lock-screen background success/failure/cancel/expiry. The accepted terminal/paused → Retry prepares paused source → explicit Play edge is safe degradation, not guaranteed automatic recovery.
6. Verify finite budgets and ownership against the accepted contract: 15-second startup, 10-second no-progress stall, at most one automatic replacement after 800 ms and 30-second episode ceiling; paused time is not stall. Cache has 20-second inactivity/180-second overall and at most three transient attempts with 800/2000 ms backoff; scheduler adds no retry amplification. Background current-cache/next work shares the network cap, suspends under pressure, ramps after stable proof and delays current-cache eligibility five seconds. Observe actual native interruption/locking/expiry behavior; host fixtures cannot close it.
7. Collect ≥10 local and ≥10 remote starts for each identifiable baseline/candidate under comparable stable conditions, plus the complete Wi-Fi/LTE scenario matrix. Attach sanitized per-run logs, latency samples, recovery outcome and audible observation, flag failures separately, then obtain senior native/device disposition. If baseline/device/build remains unavailable, retain the corresponding rows as not tested rather than inventing a delta.

## Final disposition

**Passed locally:** report-only matrix/blocker disposition; fresh source-manifest comparison and bounded availability inspection. **Failed availability check:** device enumeration exit 255, retained as environment/access evidence rather than a playback regression. **Not tested:** all 11 physical scenarios, every startup/sample/transport comparison, native compile/link/registration, installed capability/build identity, real background/interruption/route behavior, and audible output.

Only this report and J09 temporary evidence were written. No app/native/build-profile/plan edits, full tests/export repeats, device installation, cloud build, deployment, production queries, service/provider/signing changes, user-cache mutations, audio writes or nested workers occurred. Missing physical access and identified installed binary remain the concrete blockers; local report completion does not achieve physical acceptance or close Gate B.
