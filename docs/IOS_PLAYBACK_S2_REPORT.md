# S2 — final independent playback integration review

2026-11-05 Moscow / 2026-11-04 UTC evidence. Task `task_d0d31a741ac0`, final Dispatch `ctx_fef7e84a40a9`, Run `run_5c86d4feea71`.

**Local source/host review: PASSED. All five bounded S2 findings are addressed by separately authored corrections and independently verified. Final full suite: 59 suites / 931 tests passed; product/test lint, syntax, selected formatting, installed-patch idempotence and iOS export passed on unchanged source. Gate B native/device acceptance remains OPEN: no Swift compilation, identified installed binary, physical-device behavior or audible output was tested.**

## Scope and provenance

The coordinator narrowed the original S2 card to independent **read-only product/source/test review**; this reviewer owns this report and `/tmp/puuk-playback/S2/`; coordinator message `msg_e8af16435c53` additionally authorizes the three durable handoff documents linked below. The plan journal stays coordinator-owned. No product corrections, dependency upgrades, backend edits, commits/reset/push, deployment, build submission, service/provider changes, production requests, secrets collection, audio edits or nested workers were performed by this reviewer. Running the final producer was a verified hash-preserving no-op.

Root/iOS AGENTS, plan sections 2–4 and S2/J09, Gate A/S1, S0/J01–J08 including accepted senior J07/J08, native correction/review reports and the initial-intent decision govern acceptance. Orchestration and release-it guidance apply; earlier audit also applied the UX/design guidance recorded in the preserved draft. Checked exact [Expo 58 Audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) and [FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) docs; installed source, not the documentation's newer recommended patch version, determines the custom contract. No SDK upgrade occurred.

The prior S2 Dispatch `ctx_3d6a9d4d830e` completed the bounded source audit and reproduced five findings before process loss. Its draft is preserved as `report-before-recovery.md`; its input is preserved in `baseline-manifest.json`, `baseline/`, `baseline-status.txt` and `baseline.diff`. Recovery independently verified **112/112 original baseline copies**, all seven corrected JS/test hashes, three unchanged public probes, actual correction diffs and the final native delta. Lost evidence from older environment restarts was not reconstructed or claimed as fresh proof. Historical J07/J08 junior failed handoffs remain failed historical reports; their accepted senior replacements are separate revisions.

Freeze authorization `msg_a11de949f063` followed settlement of all authors; `msg_47372901bd6e` corrects the native author-manifest count to **19 paths**, independently parsed and matched here. No author was editing product files during final verification. Sandbox IPC returned `runtime_unavailable`; host IPC succeeded without opening/restarting Orca. Earlier subprocess `EPERM` failures are retained; the final full-suite invocation used host permission for the known fixture-spawn restriction.

## Five findings and final disposition

| Finding in the original S2 input | Separately authored correction | Independent final disposition |
|---|---|---|
| F1 P2: zero-position auto recovery called play before matching loaded/technical seek acknowledgement | Recovery holds seek-pending before installation at every position, waits matching loaded, issues a nonnull guarded technical seek and waits successful matching acknowledgement before resume | **Addressed at JS/source level.** Unchanged public probe passes; final suite retains zero/nonzero readiness, false/failed/timed-out seek, newer pause/seek/source and no premature progress/start cases. |
| F2 P2: immutable installation error captured with pause/revision 0 was lost when delivered FIFO after play admission | Error snapshots carry source failure without becoming new pause/resume instructions; explicit-install ownership survives command return until matching native intent delivery; revision/source fences remain | **Addressed at JS/source level.** Unchanged public probe passes; reviewed added loaded0 → error0 → play-intent1 regression and real-hook FIFO case, plus newer pause/seek and paused-error guards. No received ID/revision is rewritten. |
| F3 P2: cancel marked private attempt settled before its rejection callback; late native completion stranded the exact temporary file | One rejection owner settles the private await; native-pending state defers exact-file cleanup until native success/rejection; outer AbortError stays immediate and newer-generation publication remains fenced | **Addressed at source/host level.** Unchanged cancellation probe passes. Final 46 cache tests include 12 cancel/total/inactivity × late success/rejection × deletion-success/failure cases and preservation of a newer same-track publication. |
| F4 P3: connected=true/reachable=false lost offline policy metadata | Preserve either explicit disconnect condition as offline metadata | **Addressed.** Unchanged public reachability probe passes and final policy tests retain unknown/online tiers, dedup and reconnect. Installed iOS SDK mirrors reachable from connected, so the original split-input defect is a portable/injected contract gap, not evidence of the phone incident. |
| F5 P1 source blocker: independent `LockScreenPlayable` existential passed directly to a helper requiring `Playable` | Conditional `Playable` cast at both remote pause boundaries, unchanged locked helper for conformers, original generic pause fallback for other conformers | **Addressed at source-review level.** Exact independent comparison finds only these two generated MediaController changes; all other 15 installed Swift files and nine historical fixture/license files match input. Native Swift compile remains **not tested**. |

Correction evidence: [coordinator/network report](IOS_PLAYBACK_S2_COORDINATOR_FIX_REPORT.md), [cache report](IOS_PLAYBACK_S2_CACHE_FIX_REPORT.md), [native type report](IOS_PLAYBACK_S2_NATIVE_TYPE_FIX_REPORT.md). Review uses actual source, preserved before copies and reviewed diffs, not those reports' success claims alone. `recovery-source-review.json`, `reviewed-*.diff`, `recovery-native-review.json` and `reviewed-native-type.diff` bind the disposition to exact bytes.

The F3 fix preserves safe finite caller settlement and timer cleanup. If a synthetic native task never settles despite cancel/release, its captured file cannot safely be finally deleted while further native writes remain possible; existing startup cleanup is the later fallback. A genuine deletion failure emits a fixed sanitized diagnostic and may leave that file. This is an explicit limitation, not observed device storage exhaustion or permission to publish a cancelled generation.

## Integration and reliability assessment

The unchanged `public-probes.cjs` runs the real coordinator and scheduler through Babel/VM with narrow external-boundary doubles and a monotonic fake clock. Its final-JS recovery run passes **7/7**: zero-position readiness/seek admission, queued pre-play error, immutable A/B/A old error/finish rejection, native pause during pending loaded restoration, shared manual Retry with position and one-shot start ledger, global 30-second deadline/one replacement cap, and scheduler current/next shared two-slot budget with five-second current eligibility and cancellation-held slots. Cache/policy probes also pass. All three harness hashes match `independent-probes-manifest.json`; no harness weakening occurred. JS source hashes in these recovery runs match the frozen final candidate; the subsequent native-only change is checked separately.

Final Jest includes **143 coordinator tests, 29 real-coordinator hook integration cases, 46 cache cases and 56 native producer/static checks**, alongside scheduler, pressure, policy, URL, legacy-controller and UI regressions. Partial promises/fake timers cover delayed headers, obsolete catches/finally, cancellation, bounded loaded/seek waits, source/auth changes and current-vs-next isolation. Capability-absent/partial players retain legacy playback and explicit Retry, without attributed automatic recovery. Command return, loaded readiness and seek jumps do not establish playback; only qualifying advancing native progress confirms start, and sustainable proof releases pressure. Technical retry preserves logical request/history while creating a new source attempt.

Retry ownership remains layered and bounded: coordinator at most one automatic replacement per episode, cache at most three transient attempts inside its 180-second budget, scheduler no extra retry of failed cache jobs. Current-cache work and next/urgent jobs share scheduler accounting; startup/stall/recovery/suspension cancels background work once per pressure edge, never native playback, and a cancelled promise retains its slot through settlement. Existing stable ramp, offline veto and dynamic endpoint epochs remain covered. No backend retry/preflight layer was added.

The [accepted initial-intent decision](IOS_PLAYBACK_INITIAL_INTENT_REVIEW.md) remains binding: an inline initial error before native play admission may end terminal/paused when native guards veto recovery; explicit Retry prepares/restores a paused healthy source, followed by explicit Play. This meets the accepted safe minimum and is not guaranteed automatic recovery or one-tap playback restoration. Actual Expo bridge/AVFoundation timing is not proved by inline or queued fixtures.

Native source audit follows originating player/item/attempt contexts, old-observer rejection before subscription mutation, seek-generation invalidation before cancellation, guarded reset restoration, cause-specific lifecycle/system permission, no-resume/route/explicit-pause veto and R2 whole-module generation/first unducked volume. The type correction preserves the entire AudioPlayer/AudioModule and public native v1 registrations byte-for-byte, retaining shared recursive-lock/notification semantics. Historical migration/current idempotence, full-hash drift/partial-generation rejection, failed-transform and concurrent-disk-change rejection pass as **host producer/static Swift checks**. No Swift or AVFoundation was executed.

## Native background-task decision

Retain the existing finite background-task behavior; no evidence justifies extending its lifetime until progress. Native finish and remote next/previous can acquire the transition token; play ends it immediately, item failure/pause/release end it, and the OS-expiration callback also ends it. End invalidates the stored identifier before calling UIKit. Pre-install JS failure and successful previous-to-zero may rely on OS expiry rather than immediate explicit JS-outcome cleanup. Accordingly deterministic immediate cleanup for every JS outcome is **not** claimed; the inspected source has a finite expiration fallback. Actual expiration timing and concurrent UIKit token ownership are untested.

Extending this protection would need an independently specified source-scoped finite owner and device evidence. No speculative patch is included. Native stress remains necessary for AVFoundation/KVO/NotificationCenter cross-thread locks and reentry, module cleanup during volume restoration, same-item finish versus seek, source creation during active interruption, reset/seek cancellation, bridge delivery, background success/failure/cancel/expiry and real sound. These are retained runtime hypotheses, not reproduced new source failures.

## Frozen verification and source identity

All final child commands run from `/home/fish/projects/puuk/app/ios/puuk-ios`. `commands-recovery.jsonl` records **exact argv, cwd, UTC start/end, elapsed monotonic seconds, process exit, raw log SHA-256 and before/after hashes of all 163 app files, 16 installed native files and three public probes**, plus the source candidate and unknown native build ID. All final commands below exited 0 with no source drift. `commands.jsonl` separately preserves the previous Dispatch's intermediate failures/passes and the resumed unchanged public probes; evidence from those revisions is not relabelled as a final full-suite pass.

| Evidence log / command | Exit | Seconds | Result |
|---|---:|---:|---|
| `final-full-host.log`: `npm test -- --runInBand` | 0 | 8.010 | 59 suites / 931 passed |
| `final-lint.log`: `node node_modules/eslint/bin/eslint.js --no-ignore --no-config-lookup --config /tmp/puuk-playback/S2/eslint.config.cjs` + 19 explicit paths in ledger | 0 | 0.720 | Product, tests and producer passed |
| `final-syntax.log`: `node /tmp/puuk-playback/S2/recovery-syntax.cjs` | 0 | 0.150 | 20 JS/JSX/CJS files parsed |
| `final-format.log`: `node node_modules/prettier/bin/prettier.cjs --check` + 17 explicit paths in ledger | 0 | 0.709 | Selected formatting passed |
| `final-export.log`: `npx expo export --platform ios --output-dir /tmp/puuk-playback/S2/export-FINAL-ctx-fef7` | 0 | 8.669 | 1692 modules / Hermes export passed |
| `final-native-review.log`: `python /tmp/puuk-playback/S2/recovery-native-check.py` | 0 | 0.024 | Exact two-callsite transform; 24 other source/fixture files preserved |
| `final-source-review.log`: `python /tmp/puuk-playback/S2/recovery-source-check.py` | 0 | 0.038 | 10 corrected-source/probe pins; 112 preserved baseline copies; nine backend pins |
| `final-installed-idempotence.log`: `node scripts/patch-expo-audio.js` | 0 | 0.031 | Verified current full hashes; no byte changes |
| `final-evidence-seal.log`: `python /tmp/puuk-playback/S2/finalize-evidence.py` | 0 | 0.039 | Source/copies/logs/native-author pins/export verified |

Lint reuses the repository's enabled rules/JSX settings, explicitly checks tests despite normal ignores, and adds Node/Jest/performance globals without disabling undefined-variable checks. The immutable historical producer fixture is syntax-checked and hash/migration-tested, rather than reformatted. **Inherited whole-file formatting limitations remain:** hook artist-credit layout, original hook tests and unchanged FullPlayerModal were already unformatted in J08 input; their retained failed checks are not claimed green. No wholesale formatting of protected work occurred. The selected 17-file final formatting check passes.

Earlier S2 evidence remains separate: `baseline-full.log` exit 1 (46 fixture setup EPERM failures, 841 tests passed); `baseline-full-host.log` exit 0 (887 tests); `independent-public-first.log` exit 1 (5 passed / F1,F2 failed); cache/reachability first probes exit 1; intermediate lint/export pass. Author reports preserve their own failed/intermediate runs. Fresh final local behavioral checks have no remaining failure. `historical-log-recheck.json` confirms 25 available prior log hashes; it is not a claim to recover missing historical artifacts.

Source candidate: `sha256:798418c223c9836646ecba3fb4d0bde370bd42d4bd717d399c0a45c204239312`. This identifies source bytes, **not a compiled binary**. HEAD `35b34ca8c8d7b6e65953d7873d34f0c69605a0f4` alone does not describe the dirty candidate.

Artifacts in `/tmp/puuk-playback/S2/`: `candidate-manifest.json` and `candidate-source/` preserve all 163 app files (including lockfile, native producer and historical fixtures/license); `candidate-native-manifest.json` and `candidate-native/` preserve all 16 installed Swift sources; `export-manifest.json` pins 38 exported files. `final-evidence-seal.json` records source/native/export manifest hashes and 19/19 native-author pins. `BUILD_INSTALL.md` supplies the isolated Mac install/build, runtime capability and J09 instructions; those instructions were not executed here. Durable copies survive temporary-directory loss: [source candidate manifest](IOS_PLAYBACK_CANDIDATE_MANIFEST.json), [native source manifest](IOS_PLAYBACK_NATIVE_MANIFEST.json), and [build/install instructions](IOS_PLAYBACK_BUILD_INSTALL.md), including a self-contained hash verifier. The two manifest copies and instruction copy are byte-identical to their final temporary artifacts.

Key hashes (all SHA-256):

| Source | Final hash |
|---|---|
| `utils/playbackCoordinator.js` | `fecb15bcd225eac4a21e4bc0b007e431641633ca5b700af674a08484a46424c2` |
| `utils/audioCache.js` | `42b91fded6a56aad8a430d8ad0c49960f768fbfbdb53a34b342ea8802edc78e3` |
| `utils/networkPolicy.js` | `1e6493b1ea177505ab5870cd49743c518c2a6fb43dc6e5173ce359432964de50` |
| `hooks/usePlayerController.js` | `5484c7c64002f82cf963abf314af6beed27884475fa62f7779907e79c3b95fce` |
| `scripts/patch-expo-audio.js` | `d7c6085b16aaafd9bff698c256b67e6959ffc1435e27c2e74c0bcd2bfce0ad89` |
| `utils/__tests__/patchExpoAudio.test.js` | `aa88f517fecd76bc7781a4cff60f7378e897f2119678ea61f2423f602a6e11e0` |
| `package-lock.json` | `ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd` |
| `node_modules/expo-audio/ios/AudioPlayer.swift` | `016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746` |
| `node_modules/expo-audio/ios/AudioModule.swift` | `81577fb10c88206da394daa548379c64b6bce4dc833287352b5bb8fd74f8e43e` |
| `node_modules/expo-audio/ios/MediaController.swift` | `e270b82a708b56be4084ffd8dfa4e17dd16c3017f494aaccec793b3b254575b6` |
| `node_modules/expo-audio/ios/AudioComponentRegistry.swift` | `8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0` |
| `node_modules/expo-audio/ios/AudioUtils.swift` | `7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01` |

Fresh environment probe: Linux, Node 26.12.0, Expo 58.0.19, Audio 58.0.10, FileSystem 58.0.11 and Modules Core 58.0.26. No swift/swiftc/xcodebuild/xcrun/eas executable was found. `idevice_id -l` exits **255**, detects zero devices and reports unavailable device list; this does not prove a future builder/device cannot be supplied. Configured Puuk 1.0.0 / `com.fishtries.puuk` / build `1` is configuration only. **Actual native and installed-device build IDs remain unknown.**

All nine current backend paths pinned by J02 still match. No backend change or discrepant source evidence required new backend work, so targeted backend tests and production transport reprobes were not run. Historical server-originated Range/full-byte samples do not establish all tracks, times or the iPhone Wi-Fi/LTE/DNS/TLS path, and no latency SLO is inferred.

## Acceptance and remaining blockers

| Acceptance surface | Status |
|---|---|
| Five bounded findings, corrected-source independent review, full host suite/lint/syntax/selected format/export | **PASSED locally** |
| Swift compile/link and native method registration on the identified candidate | **NOT TESTED — native toolchain/build environment absent** |
| Installed build identity and actual `puukSourceIdentityVersion` / all guarded methods | **NOT TESTED — no identified installed binary** |
| J09 cold start/custom endpoint; local/remote Wi-Fi/LTE; slow/offline/reconnect/network switches; pause/seek during startup/recovery; A/B/A and rapid skips; corrupt-cache path; 401/404/5xx; lock-screen transitions; Bluetooth/system interruption | **ALL NOT TESTED on physical iPhone** |
| Audible output, VoiceOver/appearance, native lock/reentry/expiry behavior and startup median/p95 | **NOT TESTED** |
| Gate B native/device acceptance and playback incident closure | **OPEN / BLOCKED by missing native/device evidence** |

No confirmed critical source-invariant violation remains open among the five bounded findings in this reviewed candidate. This local result permits handoff for an authorized native build and physical-device acceptance; it does not certify compilation, AVFoundation scheduling, real mobile reliability or sound. The coordinator owns plan/gate bookkeeping and subsequent authorized native/device access; this reviewer performed no build delivery or deployment.
