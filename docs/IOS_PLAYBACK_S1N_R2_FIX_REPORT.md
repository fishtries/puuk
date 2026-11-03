# S1N R2 module interruption correction — 2026-11-03

Task `task_ce7c5d44060e`, Dispatch `ctx_82d3cc73e2f1`, Run `run_5c86d4feea71`. Native author follow-up to the full [independent R1 review and retained R2 trace](IOS_PLAYBACK_S1N_R1_REVIEW_REPORT.md). **R2 correction is implemented and locally verified at source/host level; independent re-review remains required. This is not full S2, a native candidate acceptance, or Gate B.**

The producer now retains the original unducked volume across overlapping system begins and fences the whole queued end completion with module generation ownership. All **44 focused host patch checks passed**, plus focused syntax/lint/format and installed-source application/idempotence. No Swift/native/device execution exists; candidate/build ID remains **unknown**.

## Scope, baseline and governing sources

Before edits, the exact current R1 **28/28 pins** were matched and copied to `/tmp/puuk-playback/S1N-R2/baseline/` with their full repo-relative paths. `baseline-pins.json` preserves the original manifest. All 16 installed native source pins were checked again immediately before applying the producer. Dirty/untracked changes were the baseline and were preserved. No reset, clean, commit, deployment, restart, production call, audio-file write or nested worker was used.

Owned deliverables are the existing `app/ios/puuk-ios/scripts/patch-expo-audio.js`, its dedicated `utils/__tests__/patchExpoAudio.test.js`, fixture README and new historical `s1n-r1-patch.cjs`, this report, and producer-applied installed SDK output. No plan, cache, scheduler, coordinator, hook, URL, backend or other peer implementation/test was edited. The plan changed concurrently under coordinator ownership; `peer-drift-observed.json` records that difference without restoring it. The other 12 sampled peer paths matched their initial hashes at the source audit.

Root/component AGENTS and the existing release-it/software-design skills govern this work. The exact versioned [Expo 58 Audio documentation](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) and [FileSystem documentation](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) were checked in this continuous session and reopened for this correction. The versioned pages currently recommend newer patch releases; this patch deliberately targets the installed/pinned **expo-audio 58.0.10** source, not inferred bytes from a newer release. Installed versions are Expo 58.0.19, FileSystem 58.0.11 and Modules Core 58.0.26. No dependency was upgraded. The docs describe interruption modes and route-stop behavior; the custom generation/identity contract comes from the inspected installed Swift and producer, not a documented Expo guarantee.

## Concrete correction

Changes below refer to the generated installed `node_modules/expo-audio/ios/` source.

- `AudioModule.swift:719`: system begin holds a module-owned recursive lock while advancing `interruptionGeneration`, setting pending state and recording actions. It inherits unresolved collections instead of clearing them. A playable's volume is saved and multiplied by 0.5 only if no baseline is already recorded. A second begin therefore keeps the first unducked baseline and does not duck again.
- `AudioModule.swift:759`: end captures the module generation and existing per-player system tokens under that same lock. An end without shouldResume revokes matching player permission synchronously and performs matching volume/bookkeeping cleanup with playback permission false; it does not queue speculative session activation. A resumable end checks module ownership before queued activation and again after activation returns, before any player completion, volume restoration, generic resume, recorder resume or collection cleanup. A stale success **or failure** returns without consuming a newer interruption's state.
- `AudioModule.swift:852`: cleanup independently requires pending state and matching module generation, restores saved volume, and resumes only actually paused generic members when activation permits. AudioPlayer remains excluded from this generic play command; its existing cause/token/intent checks own permission. Matching no-resume or activation-failure cleanup restores volume and clears the matching module state without automatic player/recorder playback. Duplicate completions see pending false and cannot consume a completed episode twice.
- Mode assignment (`AudioModule.swift:955`) shares the module lock with begin. Cleanup restores the **recorded actions**, not a switch on the mode at completion. Duck volume records and actual-pause membership are separate: duck-only state never grants a generic play command, and a mode change cannot turn a saved duck action into resume admission. Changing the mode alone does not invent an interruption epoch or discard an outstanding baseline.
- Explicit generic stops need the same ownership boundary as cleanup. Internal `AudioModule.pauseExplicitly` (`:704`) holds the shared module lock across synchronous native notification delivery, generic resume-membership revocation and the actual pause. Each live module removes its matching membership; non-AudioPlayer lifecycle bookkeeping is also cleared. JS player/playlist pause, explicit audio disable and the existing MediaController pause/generic-toggle pause arm use this boundary. Route loss removes membership even for an already system-paused generic playable and stops it without creating fresh resume permission. AudioPlayer still uses its existing pause/route intent fence. This prevents a matching cleanup from restarting a generic playable after an explicit or route stop. Saved volume can still be restored without authorizing play.

The internal synchronous notification lets the existing remote controller reach its owning module bookkeeping without a new public JS API, static registry map or changes to AudioPlaylist/Playable. Existing `NotificationCenter.default.removeObserver(self)` cleanup removes this additional selector observer. The shared recursive module lock is limited to the required interruption/explicit-stop bookkeeping boundary; the player source-lock implementation was not redesigned. AVAudioSession activation remains outside the module bookkeeping lock and is revalidated afterwards. This is source reasoning, not proof of framework lock ordering or callback behavior.

### Checked R2 sequences

These outcomes describe static branches/fixtures, **not executed Swift or measured sound**.

| Sequence | Expected source result |
|---|---|
| D1 begin at volume 1 → D1 end queued → D2 begin | Baseline remains 1, current volume remains 0.5; D2 advances module and player tokens. |
| Old D1 work starts after D2 begin | Pre-activation ownership check rejects it before completion effects. |
| D2 begins while D1 activation is in flight | Post-activation ownership check rejects D1's player/volume/collection/recorder effects, whether activation succeeded or failed. |
| Matching resumable D2 end | Restores volume 1, finishes only matching player tokens, and clears the matching collections once. |
| Matching no-resume end / failed activation | Restores original volume; revokes automatic AudioPlayer eligibility; no generic/recorder automatic resume. |
| Duck begin → mode changes → matching end | Restores saved duck volume without inferring playback admission from the new mode. |
| Pause-mode begin → mode changes → matching end | Actual paused generic membership remains distinct from duck state; normal matching permission may resume only retained members. |
| Explicit pause / route stop while end queued | Generic membership is revoked atomically with stop; AudioPlayer pause/cause fences still reject automatic play. Volume restoration cannot itself play. |
| Duplicate end after cleanup | Pending=false rejects repeated mutation/resume. |

An already executing OS session activation cannot be cancelled by the later generation check; the code prevents its stale module completion effects. Real notification/session ordering, reentrant framework callbacks and sources created after begin remain runtime probes. No stronger runtime claim is made.

## Preservation and reproducible migration

The entire installed **AudioPlayer.swift is byte-identical to the exact R1 baseline**. That preserves F1 atomic admission/newer pause precedence, F2 finished=true and seek-generation/cancel ordering, F3 locked relative skip, F4 intent-based toggle, R1 cause separation, source/item/player callback origin fencing, pause/seek revisions and all six previously reviewed important method bodies. Four native v1 registration declarations also match byte-for-byte (`preservation.json`). Public source identity v1 and replaceWithAttempt/playForAttempt/seekForAttempt signatures are unchanged. No native preload or AudioPlaylist feature was introduced and no unconditional recovery play was added. Existing binaries still lack the new native implementation until rebuilt; this work does not claim or alter peer JS fail-closed acceptance.

The producer adds one checked R2 stage after R1. All five target files are fully hashed before staging, the R2 input stage requires exact R1 hashes, complete final hashes are verified, and original disk bytes are compared before the first write. Unknown drift, missing files, marker-only tampering, failed transforms and unsupported mixed generations fail before planned writes. Sequential output writes remain subject to ordinary OS write failures; this is not a multi-file filesystem transaction.

Supported complete inputs converge byte-identically: pristine 58.0.10, supported legacy patch, exact S1, exact first correction, exact R1, and final R2 repeat application. Each existing historical fixture is unchanged. New `s1n-r1-patch.cjs` is an exact copy of the prior delivered producer, SHA-256 `cb7535449e3c410af58eb6947a765d7da230c80be73e3f0dc9bb5e7f0c16e3a0`; it reproducibly builds the real migration input from pristine fixtures. Final hashes for all five generated targets are pinned in the deliverable's acceptedInputs map and `/tmp/puuk-playback/S1N-R2/output-hashes.json`.

## Verification, failures and evidence

The focused suite contains 36 retained checks plus 8 R2 checks. These execute real host producers against isolated Swift fixtures and assert static source invariants; they do **not** execute native interleavings. Added coverage checks exact R1 migration/repeat, whole AudioPlayer preservation, R2 failed-transform no-write behavior, partly migrated tree rejection, original-volume retention, stale whole-completion guards before/after activation, matching denied/failed cleanup, mode-independent recorded actions, and explicit/route stop revocation. No peer JS or broad suite was run while J07 owns its JS work.

Failures were retained under unique log names:

1. `focused-tests-sandbox.log`: exit 1; beforeAll Node spawnSync EPERM caused 44 reported failures. The exact focused command was rerun with a scoped sandbox exception.
2. `focused-tests-host.log`: exit 1; 43 passed and one test failed because its injected transform-breaker string no longer matched Prettier's whitespace. The producer was not changed by this failed injection. The test uses a whitespace-tolerant match now, and all 44 then passed.
3. `final-source-audit.log`: exit 1; the audit helper incorrectly looked for AsyncFunction(seekForAttempt), although both real sources register Function(seekForAttempt). Correcting the helper made the four-declaration comparison pass. No native/API change was needed.

All commands below ran with cwd `/home/fish/projects/puuk/app/ios/puuk-ios`. `run-check.py` captures exact argv, UTC start, monotonic elapsed duration, unfiltered process exit and full combined output in `commands.jsonl` and the named `.log`; no output filtering determines pass/fail. Editing and initial backup operations were not separately timed. Initial output generation used `python /tmp/puuk-playback/S1N-R2/pin-outputs.py` (exit 0), with its temporary candidate/log kept in the artifact directory; only that temporary candidate bypassed final-output validation to derive pins, while the deliverable always retains full output validation. The applied producer is the pinned deliverable.

| Log label | Exact child command | UTC start | Exit | Elapsed ms |
|---|---|---|---:|---:|
| `format-owned` | `node node_modules/prettier/bin/prettier.cjs --write scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:31:16.026324+00:00 | 0 | 156.79 |
| `focused-tests-sandbox` | `npm test -- --runInBand --watchman=false --runTestsByPath utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:31:16.201900+00:00 | 1 | 1063.49 |
| `focused-tests-host` | `npm test -- --runInBand --watchman=false --runTestsByPath utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:31:31.437116+00:00 | 1 | 1940.42 |
| `format-tests-fix` | `node node_modules/prettier/bin/prettier.cjs --write utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:31:56.145766+00:00 | 0 | 137.54 |
| `focused-tests-host-final` | `npm test -- --runInBand --watchman=false --runTestsByPath utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:31:56.302597+00:00 | 0 | 2171.94 |
| `syntax` | `node --check scripts/patch-expo-audio.js` | 2026-11-02T17:32:07.350513+00:00 | 0 | 18.74 |
| `lint` | `node node_modules/eslint/bin/eslint.js --no-ignore --config /tmp/puuk-playback/S1N-R2/eslint.config.cjs scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:32:07.388511+00:00 | 0 | 169.57 |
| `format-check` | `node node_modules/prettier/bin/prettier.cjs --check scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:32:07.577627+00:00 | 0 | 163.41 |
| `verify-before-apply` | `python /tmp/puuk-playback/S1N-R2/verify-before-apply.py` | 2026-11-02T17:33:01.028887+00:00 | 0 | 26.85 |
| `apply-installed` | `node scripts/patch-expo-audio.js` | 2026-11-02T17:33:01.076037+00:00 | 0 | 30.4 |
| `idempotence-installed` | `node scripts/patch-expo-audio.js` | 2026-11-02T17:33:01.127766+00:00 | 0 | 28.09 |
| `final-source-audit` | `python /tmp/puuk-playback/S1N-R2/audit-final.py` | 2026-11-02T17:33:23.827317+00:00 | 1 | 43.2 |
| `final-source-audit-corrected` | `python /tmp/puuk-playback/S1N-R2/audit-final.py` | 2026-11-03T05:17:24.272042+00:00 | 0 | 29.53 |

The final source sealing/comparison after report creation is also recorded in `commands.jsonl`. No test was broadened or repeated after its final passing run because no tested producer/test bytes changed.

Full SHA-256 pins below are relative to `app/ios/puuk-ios/`; complete before/after manifests cover all baseline sources plus the new historical fixture/report:

| Source | Final SHA-256 |
|---|---|
| `scripts/patch-expo-audio.js` | `0923ad325ded9385e0bc6c95afad478a1ff2bff6453fb403201eed5d408a8d6c` |
| `utils/__tests__/patchExpoAudio.test.js` | `9538fdf66697549469f400c948961e18cadedbafd789d10920435ed540814970` |
| `utils/__tests__/fixtures/expo-audio-58.0.10/s1n-r1-patch.cjs` | `cb7535449e3c410af58eb6947a765d7da230c80be73e3f0dc9bb5e7f0c16e3a0` |
| `node_modules/expo-audio/ios/AudioPlayer.swift` | `016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746` |
| `node_modules/expo-audio/ios/AudioModule.swift` | `81577fb10c88206da394daa548379c64b6bce4dc833287352b5bb8fd74f8e43e` |
| `node_modules/expo-audio/ios/MediaController.swift` | `2e90e151ddbbc9d696e7fade169d37c5ba5c12d9e7d0b9f7893302c619dcc3cd` |
| `node_modules/expo-audio/ios/AudioComponentRegistry.swift` | `8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0` |
| `node_modules/expo-audio/ios/AudioUtils.swift` | `7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01` |

Artifacts under `/tmp/puuk-playback/S1N-R2/`: `baseline/` and `baseline-pins.json` (exact original 28), `installed-before-apply.json` (all 16 installed native files), `final-source/` (exact final copies), `final-before.json`/`final-after.json` (full final pins), `changed-from-baseline.json`, native `.swift.diff` files against exact R1, `preservation.json`, `peer-before.json`/`peer-drift-observed.json`, `environment.json`, `output-hashes.json`, all failure/pass logs and exact command metadata. Backups are evidence, not a request to restore peer state.

**Passed:** source-level R2 correction, 44 focused host checks, complete historical migration/current idempotence, focused syntax/lint/format, exact installed baseline checks, producer application/repeat, unchanged AudioPlayer and four v1 registration declarations. Lint uses a task-local CommonJS/Jest safety config for these two files; it is not an app-wide lint claim.

**Not tested:** Swift compile/link/Expo registration, OS interruption ordering, real volume/audible playback, framework/module/player lock ordering, activation reentrancy, Bluetooth/hardware routing, application/device matrix, identified installed-binary capability or full integration. Environment is Linux; swift/swiftc/xcodebuild/xcrun/eas were absent and no Mac/Xcode/iPhone/native builder was used. Existing deadlock and finish-versus-seek runtime hypotheses remain unproven; the additional module boundary also needs native lock/callback review. Candidate/build ID is unknown. Independent re-review and full S2 after J08, followed by native/device acceptance on an identified rebuilt candidate, remain outstanding.
