# S1N corrective implementation — 2026-11-02

Task `task_5ec6e96a6592`, active Dispatch `ctx_a45a2f392a47`, Run `run_5c86d4feea71`. This is the original S1 author's corrective implementation after independent native preflight, **not Gate B or independent S2 acceptance**.

**Local result:** implemented source corrections for F1/F2 (P1) and F3/F4 (P2), applied the produced patch to installed Audio 58.0.10, and passed **25 dedicated fixture/static tests plus 53 existing hook tests: 2 suites / 78 tests**. Syntax, focused lint, formatting and repeat patch application passed. All **27/27 final owned/installed pins match before and after checks**. Native compilation/runtime/device acceptance remain **not tested**; candidate/build ID is **unknown**.

## Baseline and evidence provenance

HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5`; current dirty/untracked working files are authoritative. The older `/tmp/puuk-playback/S1/pinned-after.json` and original correction-baseline directory did not survive the environment restart. Their old logs/reports were not recreated or presented as original evidence. The Nov 2 independent reconstructed preflight (`/tmp/puuk-playback/S2/native-preflight.md`, read in full) and its fresh `recheck-2026-11-02.json` establish the original 26 source hashes. This task verified **26/26 current bytes against that fresh manifest** and made fresh exact backups under `/tmp/puuk-playback/S1N-FIX/baseline/` before edits. `before-pins.json` records that baseline.

Read root/iOS AGENTS and the release-it/software-design/orchestration skills. The exact [Expo 58 Audio documentation](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) was checked: replace/play command return does not confirm native readiness or audible playback. The exact [Expo 58 FileSystem documentation](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) separates task construction from download start. Installed source remains authoritative for actual callback fields/threading. Reviewed AudioPlayer, AudioModule, MediaController, Playable and relevant Expo Modules synchronous/event code; no cache/scheduler/hook/coordinator implementation review is claimed here.

Environment: Linux, Node 26.12.0, npm 12.2.1, Expo 58.0.19, Audio 58.0.10, FileSystem 58.0.11, Modules Core 58.0.26. `swiftc`, `xcodebuild`, `xcrun` and `eas` are absent from PATH (`environment.json`); no Mac/native builder or iPhone was used.

## Corrections and behavior

| Finding | Before | Corrected source behavior | Local verification |
|---|---|---|---|
| F1 P1: stale interruption admission | AudioModule read actual/intended play, then later unconditionally changed intent to interrupted; explicit pause could lose between the two operations | `AudioPlayer.pauseForInterruption():Bool` locks eligibility check, resume bookkeeping and intent mutation together; rejects non-play/released state. Explicit pause holds the same lock while clearing eligibility and setting pause. AudioModule inserts into its interruption set only on returned admission, and route/background pause delegates ownership directly to the player. Resume checks both interrupted intent and pending eligibility under the lock and consumes eligibility before play. | Two static regression checks require lock/check/mutation order, explicit-pause bookkeeping, module returned-result use and generic fallback. |
| F2 P1: failed/reset-cancelled restoration autoplay | Reset seek discarded `finished`; teardown could cancel seeks before invalidating their generation | Reset restoration increments seek revision, captures origin/revisions, publishes recovery seekIntent/seek metadata and requires **finished=true**, current context/revisions, resume eligibility and play intent before play. Teardown, item replacement and release advance the pending seek generation **before** cancelling old seeks. | Separate static checks cover unsuccessful versus successful restore guard/observable outcome and reset/source teardown cancellation order. |
| F3 P2: source A relative target applied to B | MediaController read A's time and passed an absolute target after B could install | `seekByFromRemote(deltaSeconds)` holds the source lock while reading the concrete installed item position, deriving/clamping the finite target, publishing user seek intent through `performSeek`, and issuing the seek. Forward/back handlers pass only their relative delta; non-AudioPlayer behavior keeps the generic calculation in its fallback branch. | Static check requires locked read/derive/clamp/seek ordering and no AudioPlayer target calculation outside that branch. |
| F4 P2: loading play toggle repeats play | `isPlaying=false` while loading selected play again | `togglePlayback()` chooses under the source lock from native play intent: intended play pauses even during loading; paused/interrupted state takes an explicit play path. MediaController delegates AudioPlayer toggle to it and preserves generic `isPlaying` behavior for other playable types. | Static check requires intent-based decision under lock and generic fallback. |

`wasPlaying` remains compatible with the native Playable protocol but now reads/writes locked interruption bookkeeping. AudioModule no longer writes AudioPlayer reset eligibility from an earlier `isPlaying` snapshot; `handleMediaServicesReset` samples native play intent under the source lock. This removes split bookkeeping and preserves intended loading playback through reset, but actual reset-while-loading behavior remains a native/device probe. Ducking retains generic volume behavior and does not grant a play/resume intent.

Reset restoration emits existing `nativeEvent:seekIntent` and `nativeEvent:seek` with `seekOrigin:recovery` and `seekCompleted:finished`; it never emits the seek jump as a progress event or advances user intent revision. A newer explicit pause/seek or teardown invalidates the restoration callback. A matching false completion is observable as `seekCompleted:false` and cannot call play. No callback receives a guessed current attempt ID.

## Compatibility and patch delivery

Public native version **1** and these signatures/registrations are unchanged, confirmed against the fresh exact baseline (`public-api-check.json`):

```js
player.replaceWithAttempt({uri,headers}, attemptId, expectedIntentRevision, expectedOldAttemptId);
player.playForAttempt(attemptId, expectedIntentRevision);
player.seekForAttempt(attemptId, positionSeconds, expectedIntentRevision);
```

The new relative-seek and toggle helpers are native internal methods, not new JS API requirements. Originating player/item/attempt fencing, guarded command preconditions, user pause/seek revisions and existing fail-closed requirements for capability-absent binaries remain intact. No native preload or AudioPlaylist path is added. This task does not accept J07/J08 old-binary integration behavior or change their modules.

Deliverable is the tracked `scripts/patch-expo-audio.js` producer plus dedicated tests/fixtures, not node_modules edits alone. The producer retains the exact S1 transformation as a canonical intermediate and applies one corrective transform after it. Full input SHA-256 lists accept:

1. pristine official Audio **58.0.10**;
2. the existing supported legacy Puuk patch;
3. the **exact pre-correction S1 output**;
4. the exact corrected output for byte-identical repeat application.

Pristine/legacy inputs reach the pinned S1 intermediate; exact S1 trees enter the corrective stage directly. The corrective stage checks all five intermediate hashes, stages replacements in memory, validates all corrected output hashes, and checks concurrent disk modifications before its first planned write. Unknown drift, missing source, marker tampering and failures of either the original or corrective transform fail nonzero before writes; this is not a multi-file filesystem transaction in the event of OS write failure/process death. Mixing partially corrected trees is not silently accepted as a supported migration.

`s1-patch.cjs` preserves the byte-exact S1 producer (`c4146f0c8d041b8d163ab5256b4a2f099296d6f72d3c7c8dff2ce8f897925f71`) and reproducibly builds pre-correction sources from the existing pristine fixtures. Its presence was recovered from the durable workspace, not the missing temporary directory; provenance is documented in fixture README. Existing pristine Swift fixtures, MIT LICENSE and legacy producer are unchanged. Migration tests require pristine/legacy/S1 to produce the same corrected bytes and verify repeat application, pre-S1 drift rejection, and failed corrective transformation without disk mutation.

## Verification ledger

All fresh commands below ran from `/home/fish/projects/puuk/app/ios/puuk-ios`. `commands.jsonl` records exact argv, cwd, UTC start, true process exit and monotonic elapsed time; separate logs retain complete stdout/stderr. Child-process failure is thrown rather than inferred from an apparent exit field.

| Evidence / command | UTC start | Exit | Elapsed | Result |
|---|---|---:|---:|---|
| `dedicated-initial.log`: `npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T16:54:29.180281+00:00 | 1 | 1037.02 ms | failed: sandbox subprocess restriction |
| `dedicated-escalated.log`: `npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T16:54:36.253718+00:00 | 0 | 1425.38 ms | passed |
| `format-owned.log`: `npx prettier --write scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T16:55:54.169056+00:00 | 0 | 321.28 ms | passed |
| `apply-installed.log`: `node scripts/patch-expo-audio.js` | 2026-11-02T16:55:54.527768+00:00 | 0 | 30.59 ms | passed |
| `installed-idempotency.log`: `node scripts/patch-expo-audio.js` | 2026-11-02T16:55:54.578373+00:00 | 0 | 29.0 ms | passed |
| `syntax-producer.log`: `node --check scripts/patch-expo-audio.js` | 2026-11-02T16:56:05.215947+00:00 | 0 | 19.27 ms | passed |
| `syntax-tests.log`: `node --check utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T16:56:05.256882+00:00 | 0 | 21.37 ms | passed |
| `final-focused.log`: `npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js hooks/__tests__/usePlayerController.test.js` | 2026-11-02T16:56:08.166823+00:00 | 0 | 2175.49 ms | passed |
| `format-check.log`: `npx prettier --check scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T16:56:19.663557+00:00 | 0 | 303.55 ms | passed |
| `lint-owned.log`: `npx eslint --no-config-lookup --config /tmp/puuk-playback/S1N-FIX/eslint.config.cjs scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T16:56:41.284243+00:00 | 0 | 344.82 ms | passed |


The first dedicated invocation failed in beforeAll because the sandbox blocked Node subprocesses with `spawnSync EPERM`; all 25 tests were reported failed as a result. Its unfiltered failure log is retained as `dedicated-initial.log`. The scoped escalated rerun passed 25/25 and the final combined run passed 78/78. This was an environment restriction, not 25 separately diagnosed native defects. No failed test log was overwritten. Earlier source-reading commands used an incorrect relative cwd and were corrected; they were not verification passes.

Final focused command:

```sh
npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js hooks/__tests__/usePlayerController.test.js
```

J06 owns concurrent URL/coordinator/scheduler changes. Accordingly no cache/scheduler/coordinator/streamUrl suites, full suite or Expo export were run. The existing hook suite mocks `playbackCoordinator`, so it does not read J06's active implementation. These JS checks establish regression/source transformation results, **not native interleaving proof**. The dedicated test suite labels its F1–F4 checks static; it does not execute Swift/AVFoundation or prove race timing, deadlock freedom, audio output or actual headset routing.

## Hashes, preservation and artifacts

`final-before.json` and `final-after.json` cover 27 identical owned/installed files (the original 26 plus the preserved S1 producer fixture). Exact final source copies are in `final-source/`; fresh baseline copies are in `baseline/`. `output-hashes.json` pins each pristine/legacy/S1/corrected native target. `AudioPlayer.swift.diff`, `AudioModule.swift.diff`, `MediaController.swift.diff` and `producer-diff.patch` isolate the correction from the already dirty S1 baseline. File presence and all final pin hashes were rechecked after tests/lint/format.

| Source | Before SHA-256 | Corrected SHA-256 |
|---|---|---|
| `app/ios/puuk-ios/scripts/patch-expo-audio.js` | `c4146f0c8d041b8d163ab5256b4a2f099296d6f72d3c7c8dff2ce8f897925f71` | `ee16991bacd62ab3baf89a9aa926cc08d59a715ec1b8c2a0b2a6ac28b4bcbe88` |
| `app/ios/puuk-ios/utils/__tests__/patchExpoAudio.test.js` | `2c4210efbe11eb7ddd235a9cd0c0bd5ee3a673398360d7fba24b848a6e0ca3db` | `0ec59ff9eadb5dd8742307cf89ec50f7d132cde5b644d01b32f754ddf97d1333` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/AudioPlayer.swift` | `7618a05d110f31624073f91e2be9c40ad60229cfb8a22f40a8fd425b9346bd04` | `b42d76b1585f790c8fb15a6ca9a62ba41203a1a39f753cfa4f9cf904d69c7cd7` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/AudioModule.swift` | `27a51ef0c2d6d52938f6f078b12aa38f32cc68d8b9d3ac6303373ea28267707b` | `25e1dbae1b86d5b86755c1d1bc8fc4598a5146fa7416c5a7875258c8af896efd` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/MediaController.swift` | `fe5b7b908f98632f6deb3efc71712ac9ee4489bde0ecb90fcdc1b9be33acf830` | `d59f4d3d13fd8546cd21dfd103718b3c573cf04554c8c59dcac029e6fd029e86` |


135 peer JS/plan/lockfile hashes were sampled before and after; `peer-drift.json` is empty at that checkpoint. That observation does not freeze J06's later authorized changes. No peer files were written by this task. Plan journal remains coordinator-owned; all existing dirty/untracked app/backend work was preserved. No reset/clean, commit, deployment, restart, audio writes, production requests, nested workers or non-Orca messaging occurred. Diagnostics contain no tokens, raw playback URLs, auth headers or raw native errors.

## Remaining acceptance and runtime hypotheses

**Passed locally:** F1–F4 source corrections, pristine/legacy/pre-S1 migration, idempotency, full source drift/failure rejection checks, 25 patch tests + 53 hook tests, syntax/lint/format, unchanged public API signature/registration comparison and 27 final pins. These are implementation artifacts for independent re-review.

**Not tested:** Swift compilation/linking/native method registration, native concurrency/interleaving, hardware routing, interruption and pause/seek/reset behavior, audible playback, installed-phone capability and device acceptance. Build/candidate ID remains **unknown**. The independent preflight's potential cross-thread lock inversion/deadlock and same-item finish-versus-seek hypotheses remain open; the recursive locking design was not speculatively redesigned. Native stress must also exercise repeated reset during pending restoration, false/successful seek completion, user pause and seek during restore, loading/playing/paused/interrupted toggle, and relative skip during replacement, with bounded completion checks and suitable thread diagnostics.

Independent S2 integration/native review still follows J08. This report neither closes Gate B nor creates a device candidate; Linux source/fixture tests cannot substitute for the missing native build and device evidence.
