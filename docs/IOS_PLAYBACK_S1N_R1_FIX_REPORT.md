# S1N R1 resume-cause correction — 2026-11-02

Task `task_6a4ea7b36b0c`, Dispatch `ctx_9e7080276a17`, Run `run_5c86d4feea71`. Original native author's follow-up to the independent [S1N review](IOS_PLAYBACK_S1N_REVIEW_REPORT.md). **This is implementation for independent re-review, not Gate B acceptance.**

**Local result:** separated native lifecycle and system interruption permission, revoked automatic permission on non-resumable interruption/route loss/explicit pause/release, and fenced asynchronous system-end work with an interruption token. **36 focused patch tests passed**; syntax, focused lint, formatting, exact current-output migration and repeat application passed. **28/28 final owned/installed hashes match before and after verification.** Public native v1 signatures and full guarded method bodies are unchanged. Swift compilation, native concurrency/runtime/device behavior remain **not tested**; build/candidate ID **unknown**.

## Baseline, ownership and sources

Read `IOS_PLAYBACK_S1N_REVIEW_REPORT.md` in full, root/iOS AGENTS, relevant installed AudioPlayer/AudioModule/Playable/MediaController source and the already loaded reliability/software-design/orchestration instructions. Before editing, verified **27/27** hashes against `/tmp/puuk-playback/S1N-FIX/final-after.json` and copied every exact source to `/tmp/puuk-playback/S1N-R1/baseline/`; see `baseline-pins.json`. The new preserved first-corrective producer fixture brings final coverage to 28 files. No original fixture/history was rewritten.

HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5`; dirty/untracked working files are authoritative. Ownership was limited to the native patch producer, dedicated tests/necessary fixtures, applying that producer to installed Audio SDK source, this report and temporary artifacts. No J06 JS, hook/cache/scheduler/coordinator, backend or plan/journal edits occurred. `peer-drift.json` records no change to sampled peer hashes at the final checkpoint; this does not freeze later authorized peer work.

Checked the exact versioned [Expo 58 Audio docs](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) and [FileSystem docs](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/). Command acceptance remains distinct from loaded/progress confirmation, and constructing a download task is separate from starting it. Installed Swift determines this native boundary. Apple's interruption-guidance page was referenced by the independent review; direct web extraction returned its JavaScript-required shell, so no new claim is based on that extraction. The R1 policy follows the existing module's shouldResume/no-resume distinction.

Environment unchanged: Linux, Node 26.12.0/npm 12.2.1, Expo 58.0.19, Audio 58.0.10, FileSystem 58.0.11, Modules Core 58.0.26. No `swift`, `swiftc`, `xcodebuild`, `xcrun` or `eas` executable was found; no Mac/native builder/iPhone was used (`environment.json`).

## R1 correction

Previously, `interruptionResumePending` granted the same permission to system and foreground resume. A no-resume system end left that shared flag alive; later foreground resume could play. The new AudioPlayer state distinguishes **active blockers** from **eligible resume causes** in two small sets, with lifecycle/system causes and a no-resume veto. All admission, permission changes and command decisions remain under the existing source lock; no recursive-lock redesign was attempted.

- `pauseForInterruption()` admits a **system** cause through the locked owner; lifecycle/background uses `pauseForLifecycle()`. System entry records an active blocker even when a source is already explicitly paused or suspended by lifecycle. Eligible overlapping causes may carry the original intended play, but cannot revive an explicit pause or a no-resume veto.
- Foreground `resumePlayback()` first requires/removes an active **lifecycle** admission, then checks lifecycle eligibility. It cannot consume system-only permission. The common resume check requires its own eligible cause, no active blockers, no veto, current interrupted intent and a non-released player before play.
- A system end captures each current player's interruption token **before** queuing audio-session activation. If shouldResume is absent, the module synchronously removes that matching system cause, revokes pending automatic permission including overlapping lifecycle permission, and sets the veto. A later background/foreground cycle cannot re-create permission without explicit play.
- A resumable system end remains an active blocker until audio-session work completes. Successful activation may finish only the captured system token; activation failure finishes it without resume. A newer system begin increments the epoch, so an old queued completion cannot release a newer blocker or play its source. The generic interrupted-player resume path excludes AudioPlayer, whose system end is already handled by that token, preventing it from consuming lifecycle eligibility.
- Ducking registers the system blocker without changing play intent or adding a pause command; generic volume handling remains separate. Route loss calls a native pause path that **grants no automatic resume** and waits for explicit play. The existing `setIsAudioActive(false)` call site also uses explicit pause rather than granting a false lifecycle admission. Non-AudioPlayer generic handling is preserved.
- Explicit pause/release revoke every pending automatic eligibility. Explicit play clears old eligibility/veto for the new user action while retaining genuinely active system/lifecycle blockers; it does not pretend those events ended. The protocol compatibility property `wasPlaying` now refers only to lifecycle eligibility and cannot grant system permission.

The route and explicit-disable decisions are intentional fail-closed policy: reconnect or foreground alone cannot undo those stops. This is a native owner change; no JS capability or intent API extension is required.

### Source reasoning for overlap sequences

These rows are **static reasoning through the implementation**, not executed Swift/native interleaving results. The dedicated tests require the corresponding source guards and caller/cause mappings; they do not simulate AVFoundation.

| Sequence | Source-level outcome |
|---|---|
| Play → background → foreground, no other cause | Lifecycle admission/eligibility is released by foreground; one guarded resume is allowed. |
| Play → system begin → system end without shouldResume → background → foreground | No-resume revokes eligibility and sets the veto before session work; lifecycle admission cannot grant permission and foreground cannot play. |
| Play → system begin → background → foreground before system end | Foreground releases only lifecycle; the active system blocker prevents play. |
| Background pause → system begin → foreground → resumable system end | Eligibility is admitted separately for both causes; foreground alone cannot play, and the matching system end may resume only after both blockers are released. |
| System begin → background → resumable system end → foreground | System end cannot play while lifecycle is active; foreground later consumes its own permission and may resume. |
| Any overlapping causes → non-resumable system end | Pending automatic permission is revoked across the overlap; another cause cannot bypass the selected no-resume policy. |
| Explicit pause between admission and either resume path | Permission/veto changes are locked together with pause; no later automatic cause can revive play. |
| New system begin while older resumable end waits on session queue | The old token is rejected; the newer active blocker remains. |
| Route loss or explicit audio disable during any overlap | Automatic eligibility is revoked; foreground/system end cannot authorize play without a new explicit user action. |
| System begin while an already paused/lifecycle-suspended source is registered | Active system blocking is recorded before eligibility is evaluated; rejection of play eligibility does not erase the active interruption. |

Actual notification delivery, sources created during an OS interruption, audio-session behavior and hardware routing still require native integration/device probes; no static result is presented as a runtime timing guarantee.

## F1–F4 and public compatibility

F1 still performs admission and pause/resume bookkeeping under one source critical section; module bookkeeping uses the returned system admission rather than an earlier play-state snapshot. Explicit newer pause retains precedence. F2's successful-seek requirement, intent/context/seek-generation checks and pre-cancellation invalidation remain intact. F3 relative target calculation remains locked; F4 remains an intent-based toggle. Whole method bodies for reset restoration, relative skip and toggle compare byte-identically with the first corrective baseline.

`preserved-methods.json` also confirms the **whole bodies and signatures** of these public native methods remain unchanged:

```js
player.replaceWithAttempt({uri,headers}, attemptId, expectedIntentRevision, expectedOldAttemptId);
player.playForAttempt(attemptId, expectedIntentRevision);
player.seekForAttempt(attemptId, positionSeconds, expectedIntentRevision);
```

Native capability version remains **1**, with unchanged registrations. Source/item/player identity fencing, pause/seek intent revisions, fail-closed old-binary requirements and no-native-preload behavior are retained. This report does not accept the J07/J08 integration of those requirements.

## Reproducible patch and fixtures

The producer accepts full pinned hashes for pristine Audio 58.0.10, supported legacy patch, exact S1 output, **exact first corrective S1N output**, and exact R1 output. Canonical staged transformations converge on each pinned intermediate; exact first-corrective inputs enter the R1 stage directly. Every intermediate and final target is verified, and original disk contents are rechecked before any planned write. Full-output hashes, not substring markers, authorize repeat application.

The preserved `s1n-fix-patch.cjs` fixture is exactly the first corrective producer, SHA-256 `ee16991bacd62ab3baf89a9aa926cc08d59a715ec1b8c2a0b2a6ac28b4bcbe88`. It builds the real pre-R1 sources from the pristine fixtures for migration tests. Existing pristine/license/legacy/S1 history remains unchanged. Tests cover all four migration inputs, idempotency, missing/unknown/modified-marker input, failed original/corrective/R1 transformations and two unsupported partial old/R1 mixtures; all rejection cases preserve input bytes. MediaController is identical across the first-corrective/R1 revisions, so the actual R1 mixture cases concern AudioPlayer and AudioModule.

This remains validation-before-write rather than a multi-file filesystem transaction if the OS fails during final sequential writes. Node_modules was migrated by the produced script after its exact baseline hashes were checked; installed-source edits alone are not the deliverable.

## Fresh verification

All commands below ran from `/home/fish/projects/puuk/app/ios/puuk-ios`. `commands.jsonl` records exact argv, cwd, UTC start, true process exit and monotonic elapsed time; complete outputs have separate filenames. **Only the dedicated patch suite ran; no peer JS suites/full suite/export were run while J06 owns concurrent files.**

| Evidence / command | UTC start | Exit | Elapsed | Result |
|---|---|---:|---:|---|
| `format-owned.log`: `npx prettier --write scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:11:24.554219+00:00 | 0 | 310.18 ms | passed |
| `dedicated-initial.log`: `npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:11:24.883503+00:00 | 1 | 1042.22 ms | failed: sandbox EPERM |
| `dedicated-escalated.log`: `npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:11:32.079367+00:00 | 0 | 1728.6 ms | passed |
| `apply-installed.log`: `node scripts/patch-expo-audio.js` | 2026-11-02T17:12:23.657847+00:00 | 0 | 29.68 ms | passed |
| `installed-idempotency.log`: `node scripts/patch-expo-audio.js` | 2026-11-02T17:12:23.706995+00:00 | 0 | 26.76 ms | passed |
| `syntax-producer.log`: `node --check scripts/patch-expo-audio.js` | 2026-11-02T17:12:23.753936+00:00 | 0 | 19.17 ms | passed |
| `syntax-tests.log`: `node --check utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:12:23.792316+00:00 | 0 | 16.87 ms | passed |
| `format-check.log`: `npx prettier --check scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:13:17.398649+00:00 | 0 | 308.49 ms | passed |
| `final-dedicated.log`: `npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:13:20.356480+00:00 | 0 | 1724.91 ms | passed |
| `lint-owned.log`: `npx eslint --no-config-lookup --config /tmp/puuk-playback/S1N-R1/eslint.config.cjs scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-02T17:13:31.471274+00:00 | 0 | 312.01 ms | passed |


The first restricted dedicated invocation reported 36 failures because its beforeAll could not spawn Node (`EPERM`). `dedicated-initial.log` preserves the complete failed invocation. The scoped escalated rerun passed 36/36, and final pinned verification passed 36/36. That initial result is an environment failure, not 36 independently diagnosed product defects. No failure logs were overwritten.

The source/fixture tests are explicitly labelled static. They check R1's no-resume trace guards, own-cause foreground consumption, active entry before eligibility, async token/session-failure handling, route/disable revocation and ducking distinctions alongside F1–F4 and source drift. They are **not native execution, scheduling, audio or deadlock proof**.

## Hashes and preservation

Before edits, `baseline-pins.json` verified/copied all 27 first-corrective files. `final-before.json` and `final-after.json` pin **28 byte-identical final files** across the final tests/checks; `final-source/` preserves exact delivered bytes. `output-hashes.json` contains all migration/final native hashes. Native diffs are retained per target. Sampled peer JS, plan and lockfile hashes showed no drift at the final checkpoint; no peer file was written by this task. Future authorized J06 edits are independent.

| Source | First corrective SHA-256 | R1 SHA-256 |
|---|---|---|
| `app/ios/puuk-ios/scripts/patch-expo-audio.js` | `ee16991bacd62ab3baf89a9aa926cc08d59a715ec1b8c2a0b2a6ac28b4bcbe88` | `cb7535449e3c410af58eb6947a765d7da230c80be73e3f0dc9bb5e7f0c16e3a0` |
| `app/ios/puuk-ios/utils/__tests__/patchExpoAudio.test.js` | `0ec59ff9eadb5dd8742307cf89ec50f7d132cde5b644d01b32f754ddf97d1333` | `22bd215dcd738d8a7a60a8793b9e7f95981fa81e89ee8e33c82b5eb00d7b143c` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/AudioPlayer.swift` | `b42d76b1585f790c8fb15a6ca9a62ba41203a1a39f753cfa4f9cf904d69c7cd7` | `016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/AudioModule.swift` | `25e1dbae1b86d5b86755c1d1bc8fc4598a5146fa7416c5a7875258c8af896efd` | `07c2e437e9d99c44cc7b5c0500fb51d91d1e95283bbb93359890241037370b33` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/MediaController.swift` | `d59f4d3d13fd8546cd21dfd103718b3c573cf04554c8c59dcac029e6fd029e86` | `d59f4d3d13fd8546cd21dfd103718b3c573cf04554c8c59dcac029e6fd029e86` |


No plan edits, commit/reset/clean/deploy/restart/production requests/audio writes, secrets/raw playback URLs/headers/native-error diagnostics or nested workers occurred.

## Still open

Independent R1 re-review follows. This is **not Gate B**. Swift compilation/linking/registration, real native concurrency, interruption/lifecycle/route overlap timing, audible playback, hardware routing, installed-binary capability and the device matrix remain **not tested**; candidate/build ID is **unknown**. Existing lock-order/deadlock and same-item finish-versus-seek hypotheses remain open without a speculative lock redesign. Native/device testing must exercise the sequence table and F1–F4 with the actual JS integration after J08; passing source fixtures cannot close those gates.
