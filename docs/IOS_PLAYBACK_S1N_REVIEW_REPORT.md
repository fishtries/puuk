# Independent S1N corrective review — 2026-11-02

Task `task_8f3457c01a94`, Dispatch `ctx_b9177dcfc184`, Run `run_5c86d4feea71`. Independent reviewer of the original S1 author's corrections. **This is not full S2 or Gate B acceptance.** No product or peer files were changed.

**Verdict:** the original **F1–F4 are addressed at source level**, but **one new P2 source regression R1 remains open**: foreground resume can consume eligibility granted by a system interruption, bypassing that interruption handler's no-resume decision. The corrective patch should receive that narrow follow-up before clean corrective acceptance. Compilation, actual native concurrency and device behavior remain not tested.

**Evidence:** independently verified **27/27 final pins**, independently passed **25/25 focused patch tests**, and ran all **six mixed S1/corrected combinations** of the three changing Swift targets: each rejected with exit 1 and preserved every input byte. Public native v1 methods and registration declarations match the original S1 baseline. Passing these host checks does not close R1 or native acceptance.

## Scope and provenance

Read root/component AGENTS, plan section 4, [S1N fix report](IOS_PLAYBACK_S1N_FIX_REPORT.md), reconstructed independent preflight at `/tmp/puuk-playback/S2/native-preflight.md`, fresh S1N-FIX diffs/baseline/final manifests, owned producer/test/fixtures and installed native targets. Applied the already loaded release-it, software-design and version-matched Orca orchestration instructions. Checked official versioned [Expo 58 Audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) and [FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) documentation; installed source is authoritative for the reviewed implementation.

HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5`; dirty/untracked files are the working baseline. Versions: Expo 58.0.19, Audio 58.0.10, FileSystem 58.0.11, Modules Core 58.0.26. New artifacts are only under `/tmp/puuk-playback/S1N-REVIEW/` plus this report. No J06 coordinator/scheduler/streamUrl files or tests were inspected/run. No full suite, hook suite, export, installation, service action, production request, audio write, commit or deployment occurred.

Fresh author baseline copies and diff manifests survived and were used directly; this review does not reconstruct missing historical logs. The independent preflight remains historical input, not a report of the corrected bytes.

## Original finding disposition

All paths in this section are relative to `app/ios/puuk-ios/`.

| Finding | Disposition | Independent source assessment |
|---|---|---|
| F1 P1: interruption overwrites a newer explicit pause | **Addressed for the reported race** | `node_modules/expo-audio/ios/AudioPlayer.swift:718` locks explicit pause, eligibility clearing and intent mutation together; `:726` locks interruption eligibility check, bookkeeping and mutation together and rejects current non-play/released state. AudioModule `:706` inserts only an admitted interruption, while pauseAll `:814` delegates admission without a prior intent snapshot. A pause before admission is rejected by admission; a pause afterward revokes pending resume. R1 below concerns a separate mismatch between the origins of eligible resumes. |
| F2 P1: reset seek ignores unsuccessful completion | **Addressed** | AudioPlayer `:550` captures context/intent/seek generation, publishes recovery seek metadata and requires current context/revisions plus `finished`, `shouldResume` and intended play before calling play (`:562`–`:567`). Teardown `:512`, item replacement `:623` and release `:761` invalidate the seek generation before cancellation. A synchronous cancellation callback therefore cannot pass the old generation. Paused reset may restore position but cannot autoplay. |
| F3 P2: relative skip applies A's target to B | **Addressed** | AudioPlayer `:325` holds sourceLock while reading concrete item time, deriving/clamping target and issuing the user seek. MediaController `:362`, `:382` supplies only the signed interval. The unlocked absolute-time calculation now exists only in the non-AudioPlayer fallback. |
| F4 P2: toggle repeats play while loading | **Addressed** | AudioPlayer `:734` chooses under sourceLock from native play intent, so intended-but-loading play takes pause. MediaController `:328` delegates to that method; other playable types retain their generic behavior. Actual headset command routing remains a device check. |

Reset resume eligibility is now sampled from native intent under the source lock (`AudioPlayer.swift:483`), rather than AudioModule writing a stale isPlaying snapshot. This addresses the earlier source-level eligibility distinction for loading playback. Actual loading-reset behavior and its integration with the JS restoration owner remain untested.

## New finding R1 — P2: foreground consumes system-interruption resume eligibility

**Confirmed source-level regression; actual native/audio reproduction not performed.**

**Locations:** `node_modules/expo-audio/ios/AudioPlayer.swift:22`, `:726`–`:731`, `:754`–`:758`; `node_modules/expo-audio/ios/AudioModule.swift:120`–`:123`, `:706`, `:725`–`:733`, `:810`–`:825`. Tracked producer: `scripts/patch-expo-audio.js:1265`, `:1287`, `:1435`, `:1457`.

**Cause:** one `interruptionResumePending` boolean now represents permission to resume from both system interruption and lifecycle/background pause. `resumeAllPlayers()` calls AudioPlayer.resumePlayback for every player without determining which event granted eligibility. The pending bit is therefore consumed by a different resume path from the one that granted it. Locking makes this sequence atomic but does not provide the missing provenance.

**Concrete source trace / native reproduction recipe:** use a fresh player, `shouldPlayInBackground=false`, non-ducking interruption mode and no explicit user play after interruption.

1. Explicit play sets native play intent and clears pending eligibility.
2. System interruption begins; `pauseForInterruption()` sets pending=true and intent=interrupted. The module records the admitted player.
3. Interruption ends **without** `.shouldResume`, with session activation succeeding. `handleInterruptionEnded` skips resume, but leaves the player pending=true and interrupted.
4. App enters background. `pauseAllPlayers()` invokes admission, which rejects interrupted intent and preserves pending=true.
5. App returns to foreground. Since background playback is disabled, foreground calls `resumeAllPlayers()`. Its direct call to AudioPlayer.resumePlayback passes the shared pending flag and issues play without user input or a system-resume decision.

The same shared flag also permits foreground to request play before the system interruption has ended. The fully ended trace above avoids depending on whether AVFoundation permits audible playback during an active interruption. `shouldPlayInBackground=false` is an actual supported/default native setting (`AudioModule.swift:14`); this review does not claim it is the active Puuk runtime configuration or that this path occurs with background playback enabled.

**Before/after proof:** in the fresh S1 baseline, system interruption did not set `wasPlaying`; background pause skipped a nonplaying/interrupted source, and foreground resume required `wasPlaying=true`. The correction makes `wasPlaying` alias the bit granted by every interruption and makes foreground invoke resume unconditionally for AudioPlayer. Thus this precise path is introduced by the correction rather than merely inherited from the SDK. The trace is retained in `/tmp/puuk-playback/S1N-REVIEW/R1-static-trace.json`, expressly labelled source reasoning rather than executed Swift.

**Consequence:** background/foreground can unexpectedly start playback that the system-interruption handler intentionally left stopped. This is a resume-policy/intent violation in the native boundary; JS attribution will see a legitimate newer play-intent event, so source identity filtering does not remove the unwanted start. [Apple's interruption guidance](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions) distinguishes the automatic-resume and no-resume branches. `.shouldResume` is a policy hint, not an OS enforcement mechanism; the defect here is bypassing this module's selected policy through a different path.

**Minimal correction:** preserve F1's locked admission, but keep lifecycle resume eligibility distinct from system interruption eligibility in the existing native owner. Foreground must consume only lifecycle eligibility, and must not authorize a still-active or non-resumable system interruption. An interruption-ended decision without automatic resume should revoke that cause's pending eligibility. Ensure explicit pause/release revoke every pending automatic cause. Verify overlapping lifecycle/system/route causes, ended with/without shouldResume and explicit pause between admission and resume. A single global pending boolean should not serve as permission for every resume entry point.

**Test gap:** the dedicated static test at `utils/__tests__/patchExpoAudio.test.js:477`–`:485` asserts the unconditional foreground AudioPlayer resume branch, but does not exercise the sequence above. The focused 25/25 result therefore coexists with R1; it is not runtime or policy acceptance.

## Compatibility, callback identity and patch delivery

- Independently compared the **whole bodies** of replaceWithAttempt/playForAttempt/seekForAttempt and all four v1 registration declarations against fresh S1 baseline copies: unchanged. Evidence: `public-api-independent.json`. The relative-seek/toggle helpers are native internal methods, not added JS capability requirements. API version remains 1; no JS fallback fabricates native identity on an old binary.
- Guarded commands retain one recursive critical section across validation and actual AVPlayer mutation. Concrete source context checks still fence item/player/attempt before event publication. New seek restoration captures its own origin/generation and emits `seekOrigin:recovery`, not a fabricated progress event. This does not establish behavior of J07/J08 capability checks, event acceptance or recovery budgets; those files remain outside this review.
- Producer `scripts/patch-expo-audio.js:1509`–`:1555` pins complete hashes. Pristine, legacy and exact S1 inputs converge on the pinned S1 intermediate; `patchNativeCorrections` checks all five intermediate hashes (`:1216`–`:1224`) before correction. Exact corrected outputs are accepted only after complete output hash verification. Final output hashes and original disk contents are validated before planned writes (`:1584`–`:1597`). Unknown drift and failed transformation do not leave staged writes on disk. Final sequential writes are still not a multi-file filesystem transaction.
- Pristine fixtures/license/legacy producer remain pinned; the preserved exact S1 producer fixture has SHA-256 `c4146f0c8d041b8d163ab5256b4a2f099296d6f72d3c7c8dff2ce8f897925f71`. Dedicated tests exercise all three migration entries, repeat application, drift, modified markers, missing file and failure before writes. An additional independent six-case experiment verifies mixed old/corrected targets fail without disk writes.

## Fresh checks and artifacts

Test cwd was `/tmp/puuk-playback/S1N-REVIEW/isolated`, a byte-identical copy of producer, dedicated test and fixtures. The installed Jest runner was used with isolated Node environment, no transform/cache/product setup, and TMPDIR confined to this review. This avoids reading J06-owned code or running unrelated suites.

Exact focused command, recorded with UTC start/cwd/argv/elapsed/real exit in the accompanying JSON files:

```sh
node /home/fish/projects/puuk/app/ios/puuk-ios/node_modules/jest/bin/jest.js --runInBand --runTestsByPath /tmp/puuk-playback/S1N-REVIEW/isolated/utils/__tests__/patchExpoAudio.test.js --config /tmp/puuk-playback/S1N-REVIEW/jest.config.json --json
```

| Evidence under `/tmp/puuk-playback/S1N-REVIEW/` | UTC timestamp (test rows: start) | Exit / result |
|---|---|---|
| `pins-before.json` | Embedded in artifact | 27/27 match author's final-after manifest |
| `dedicated-initial.json`, matching stdout/stderr logs | 2026-11-02T17:01:07.605078Z | **1**, 25 reported failures due to beforeAll `spawnSync EPERM`; 0.376 s |
| `dedicated-escalated.json`, matching stdout/stderr logs | 2026-11-02T17:01:33.972418Z | **0**, 1 suite / **25 passed**, 0 failed; 0.960 s |
| `mixed-generation-check.json`, six stdout/stderr pairs | Embedded in artifact | Six producer exits **1**, all expected rejection, all five source files byte-identical before/after each case |
| `public-api-independent.json` | Same review session | Three full method bodies and four registration declarations unchanged |
| `pins-after.json` | Embedded in artifact | Final pin and before/after comparison |

The initial failure output is preserved separately and was not overwritten. It is an environment failure, not 25 separately diagnosed product bugs. The escalated rerun is the passing evidence. These are **host transformation/static tests**; no Swift code was executed.

Reviewed final hashes include:

| Source | SHA-256 |
|---|---|
| `scripts/patch-expo-audio.js` | `ee16991bacd62ab3baf89a9aa926cc08d59a715ec1b8c2a0b2a6ac28b4bcbe88` |
| `utils/__tests__/patchExpoAudio.test.js` | `0ec59ff9eadb5dd8742307cf89ec50f7d132cde5b644d01b32f754ddf97d1333` |
| `node_modules/expo-audio/ios/AudioPlayer.swift` | `b42d76b1585f790c8fb15a6ca9a62ba41203a1a39f753cfa4f9cf904d69c7cd7` |
| `node_modules/expo-audio/ios/AudioModule.swift` | `25e1dbae1b86d5b86755c1d1bc8fc4598a5146fa7416c5a7875258c8af896efd` |
| `node_modules/expo-audio/ios/MediaController.swift` | `d59f4d3d13fd8546cd21dfd103718b3c573cf04554c8c59dcac029e6fd029e86` |

## Native hypotheses and remaining acceptance

The earlier **cross-thread framework lock inversion/deadlock** and **same-item finish versus seek** hypotheses remain unproven and open for native stress. Recursive locking addresses same-thread reentry, not internal Combine/AVFoundation lock ordering. No claim of a newly reproduced deadlock or finish race is made.

Also probe reset during startup/active playback/explicit pause; repeated reset during restoration; true/false seek completion; user pause/seek during restore; relative skips during replacement; and toggle across loading/playing/paused/interrupted states. Reset recovery events and resumed play must be exercised with the actual JS integration after J08. Confirm old-binary capability absence fails closed there.

Linux availability probe found no swift/swiftc/xcodebuild/xcrun/eas; no Mac, native builder or phone was used. Build ID remains unknown. Swift compile/link/registration, native interleaving/ordering, audible output, hardware routing, installed-binary capability and device matrix are **not tested**. Environment/source hashes and commands are retained in the review artifacts. R1 follow-up, full independent S2 after J08 and an identified native/device candidate remain necessary; this review does not replace those gates.
