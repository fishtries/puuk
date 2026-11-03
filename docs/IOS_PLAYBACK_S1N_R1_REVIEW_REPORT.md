# Independent R1 corrective review — 2026-11-02

Task `task_9f017ec01ea2`, Dispatch `ctx_7cc9c6c3959b`, Run `run_5c86d4feea71`. Independent reviewer of the original author's [R1 implementation](IOS_PLAYBACK_S1N_R1_FIX_REPORT.md). **This is not full S2 or Gate B acceptance.**

**R1 disposition: addressed at source level.** Foreground can no longer consume system-only resume permission, active system blocking prevents lifecycle autoplay, and a matching no-resume decision revokes overlapping eligibility before asynchronous session work. Explicit pause/release revoke automatic permission. The original F1–F4 fixes and public native v1 method bodies/registrations are preserved.

**One additional P2 source finding R2 remains in the retained module-level path:** an older queued system-end completion can still restore/clear newer ducking bookkeeping despite the per-player token rejection. This is not a recurrence of R1 and is not established as a regression introduced by this correction; the unversioned generic helper and volume dictionary behavior existed in the reviewed baseline. It should remain explicit for native-boundary follow-up/full S2 rather than be hidden by the successful R1 source correction.

Fresh evidence: **28/28 pins match**, **36/36 focused host patch tests passed** after a separately retained sandbox failure, and independent comparison confirms six important native method bodies plus four v1 registration declarations are unchanged. **No Swift/native/device execution or identified build exists.**

## Scope, baseline and evidence

Read the complete R1 fix report and fresh `/tmp/puuk-playback/S1N-R1/` native diffs/manifests, prior independent S1N review, current producer/test/fixtures and installed native targets. Root/iOS AGENTS and plan section 4 govern the boundary; release-it/software-design and version-matched Orca worker instructions remain applicable. The exact versioned [Expo 58 Audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) and [FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) documentation were read during this continuous review session. Command acceptance, ready state and actual progress remain distinct facts; installed source is authoritative for the patch contract.

HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5`; dirty/untracked files are the baseline. Installed versions: Expo 58.0.19, Audio 58.0.10, FileSystem 58.0.11, Modules Core 58.0.26. Author's final-after manifest was compared independently against every current file. Exact reviewed native source copies, independent API comparisons, fresh test output and pins are under `/tmp/puuk-playback/S1N-R1-REVIEW/`.

Only this report and that new temporary directory were written. No product/peer files, J06 coordinator/scheduler/streamUrl implementations or tests, full suite, hook suite, export, backend, service, production endpoint, audio file, commit or deployment was touched. No nested workers or stale lifecycle IDs were used.

## R1 source assessment

Paths below are relative to `app/ios/puuk-ios/`.

- `node_modules/expo-audio/ios/AudioPlayer.swift:22`–`:26` separates active blockers from eligible resume causes and a no-resume veto. `admitAutomaticPause` at `:743` records a system/lifecycle blocker before checking eligibility, including an already paused source, while keeping the admission and intent mutation under sourceLock. A newer explicit pause cannot be overwritten into resumable play eligibility.
- `resumePlayback` at `:817` removes only an actually admitted lifecycle blocker. `resumeIfPermitted` at `:788` requires the matching eligible cause, no active blockers, no veto, current interrupted intent and a non-released player before play. It does not allow foreground to release system blocking.
- `finishSystemInterruption` at `:774` accepts only the captured epoch and a current system blocker. Its non-resumable branch removes all automatic eligibility and sets the veto under the same lock. Background/foreground alone cannot recreate eligibility without a new explicit play action.
- `AudioModule.swift:726` captures player tokens before scheduling session work. No-resume is applied synchronously; resumable work finishes only matching tokens after activation, with activation failure treated as no-resume. `AudioModule.swift:815` excludes AudioPlayer from the generic non-ducking resume command, so that helper cannot consume its lifecycle permission. R2 below concerns the remaining generic volume/bookkeeping effects.
- Route loss uses `pauseForRouteChange` (`AudioModule.swift:760`, `AudioPlayer.swift:769`), and explicit audio disable invokes pause (`AudioModule.swift:880`), revoking permission rather than creating lifecycle eligibility. Explicit pause clears all eligibility and sets the veto (`AudioPlayer.swift:735`); release additionally clears active causes and invalidates source/seek work (`:824`). Explicit play clears old eligibility/veto while retaining genuinely active blockers (`:225`). It is an explicit user command; this does not prove AVFoundation will produce sound during an active interruption.

The route policy is deliberately conservative: route loss requires explicit play. It uses the explicit pause event path rather than granting automatic system/lifecycle resume. This is documented by the author; downstream presentation of route interruption versus pause remains part of the later integration review.

### Checked overlap sequences

These outcomes are **static reasoning over the actual Swift branches, not executed native tests**.

| Sequence | Source outcome |
|---|---|
| Play → background → foreground | Lifecycle eligibility may resume once after its blocker is released. |
| Play → system begin → no-resume end → background → foreground | Veto and cleared eligibility prevent automatic play. This closes the reported R1 trace. |
| Play → system begin → background → foreground before system end | System blocker remains; foreground cannot play. |
| Background → system begin → foreground → matching resumable system end | Foreground releases lifecycle only; system end may resume after the last blocker is removed. |
| System begin → background → matching resumable system end → foreground | System completion cannot play while lifecycle is active; foreground later may consume its own eligibility. |
| Either overlap order → no-resume end / activation failure | Automatic permission is revoked across both causes. |
| Explicit pause during overlap, then any automatic end/foreground | No automatic play; pause clears eligibility and sets veto under the same lock. |
| Release while an end is queued | Released guard rejects player completion; source/seek state is invalidated. |
| New system begin before an older captured end finishes | Player epoch mismatch rejects the old completion and preserves the newer blocker. Module-level duck cleanup still has R2. |
| Route loss / explicit audio disable during overlap | Explicit pause revokes eligibility; reconnect/foreground/system end alone cannot authorize play. |
| Ducking plus lifecycle pause | Ducking records system blocking without itself changing play intent; a lifecycle pause cannot resume through an active system cause. Volume restoration is separately reviewed below. |

No additional newly introduced foreground-autoplay regression was established from these source paths. Sources created after a begin notification, actual OS ordering and runtime session behavior remain integration/device probes.

## R2 — P2: stale system-end work mutates newer ducking state

**Confirmed conditional source behavior, not an observed native/device failure. Retained gap; not claimed to be newly introduced by R1.**

**Locations:** `node_modules/expo-audio/ios/AudioModule.swift:691`–`:703` clears and rewrites interruption/volume collections; `:729` captures only per-player tokens; `:743`–`:744` calls the generic helper without a module-generation check; `:806`–`:827` restores current collection values and clears them. Per-player rejection at `AudioPlayer.swift:776` does not stop that module helper. Tracked producer `scripts/patch-expo-audio.js:1679`–`:1698` retains this completion call.

**Concrete trace / native reproduction recipe:** configure duckOthers, begin with player volume 1, and arrange that the player satisfies the existing `isPlaying` guards at both begin handlers. Hold the first end's session work until after a new begin. Both end activations succeed and both ends request resume.

1. Ducking interruption D1 begins. The module stores volume 1 and sets volume 0.5. Player epoch becomes 1.
2. D1 ends; it captures epoch 1 and queues its session work.
3. Before that work runs, D2 begins. The begin handler clears the collections, stores the currently ducked 0.5 as its new original volume and ducks again to 0.25. Player epoch becomes 2.
4. D1's queued block executes. AudioPlayer correctly rejects token 1, so D2's player blocker stays intact. The same old block nevertheless calls `resumeInterruptedPlayers()` unconditionally after `canResume && shouldResume`.
5. That helper reads **D2's** current collections, restores volume 0.5 and clears D2's membership/saved volume.
6. D2's matching end can release its player blocker, but its generic restore finds no saved membership/volume. The player remains at 0.5 instead of the original 1.

The preconditions are material: this numerical trace assumes both begin handlers enter their actual-playing duck branch. Real AVFoundation notification order and isPlaying values have not been measured here. Under the stated source inputs, however, the old callback's unversioned mutation and lost baseline follow directly from the implementation; no OS behavior is needed to establish that control-flow defect. Structured trace: `/tmp/puuk-playback/S1N-R1-REVIEW/R2-static-trace.json`, explicitly not executed Swift.

**Consequence:** an old end can consume newer interruption bookkeeping and leave incorrect persistent player volume. The generic non-AudioPlayer branch can also be reached by the stale helper, but its native playback effects were not reviewed or reproduced here. The AudioPlayer cause fence works; the module's remaining mutation is the gap.

**Minimal correction proposal:** extend generation ownership to the **whole module end completion**, including volume restoration and collection cleanup, and retain the unducked baseline across an older queued end/new begin. Merely adding a player token check or skipping the stale cleanup is insufficient if the newer begin has already replaced the original volume with a ducked value. Keep this within the existing native module; do not redesign unrelated playback ownership. Verify old-end/new-begin with original volume, stale cleanup rejection, matching new end, mode changes and explicit pause/route stop. The original author should implement any chosen correction; this independent reviewer made no fix.

The 36 static tests require token capture and the generic helper separation, but do not execute this begin/end/volume sequence or fence its module-level collections. This explains why they pass alongside R2. This retained finding does not reopen the original R1 trace, but must remain visible for targeted follow-up/full S2.

## F1–F4, API and reproducibility

F1 admission/pause bookkeeping still shares the recursive source lock. F2 successful-reset-seek and source/intent/generation checks plus invalidation before cancellation remain in place. F3 relative target calculation and F4 intent-based toggle remain intact. Independently compared whole bodies for replaceWithAttempt, playForAttempt, seekForAttempt, restorePlaybackState, seekByFromRemote and togglePlayback against fresh first-corrective baseline copies: **all six unchanged**. All four capability/method registration declarations are also unchanged (`preserved-api-and-fixes.json`). MediaController is byte-identical to the first corrective revision.

Public v1 capability/signatures remain binding; the cause/token helpers are internal native methods. Source/item/player/attempt fences are preserved, with no invented identity or added preload. This review does not accept J07/J08 old-binary fail-closed behavior, total budgets or event integration; those peer files were not read/run.

The producer accepts complete pinned inputs for **pristine 58.0.10, legacy Puuk, exact S1, exact first correction and exact current R1** (`scripts/patch-expo-audio.js:1744`). Inputs converge through checked intermediate stages; each stage checks complete intermediate hashes. Exact current output is recognized by full hashes. Final output and original disk bytes are checked before staged writes (`:1782`–`:1844`). Drift/missing/marker-only/failed transforms and unsupported partial generations fail without planned input mutations. Final sequential writes are not an OS-failure-safe multi-file transaction.

The preserved first-corrective producer fixture is exactly `ee16991bacd62ab3baf89a9aa926cc08d59a715ec1b8c2a0b2a6ac28b4bcbe88`. Dedicated tests passed all four migration entries, current repeat application, drift/missing/modified marker, original/corrective/R1 transform-failure preservation, and both actual two-target partial R1 combinations. These are real host producer invocations plus static Swift assertions, not native behavior tests.

## Fresh commands, pins and limits

The producer/test/fixtures were copied byte-for-byte to `/tmp/puuk-playback/S1N-R1-REVIEW/isolated`; the dedicated suite used the installed Jest runner, Node environment with no product transforms/setup/cache, and TMPDIR under this task. No concurrent J06 code was imported. Exact runner command:

```sh
node /home/fish/projects/puuk/app/ios/puuk-ios/node_modules/jest/bin/jest.js --runInBand --runTestsByPath /tmp/puuk-playback/S1N-R1-REVIEW/isolated/utils/__tests__/patchExpoAudio.test.js --config /tmp/puuk-playback/S1N-R1-REVIEW/jest.config.json --json
```

Cwd: `/tmp/puuk-playback/S1N-R1-REVIEW/isolated`. Test JSON records include exact argv/cwd, UTC start, monotonic elapsed time, real process exit and build ID null. Separate stdout/stderr files preserve failures without overwriting them.

| Artifact under `/tmp/puuk-playback/S1N-R1-REVIEW/` | Result |
|---|---|
| `pins-before.json` | Independently matched **28/28** current hashes against author's final-after manifest. |
| `dedicated-initial.json` and stdout/stderr logs | Start **17:17:25.569033Z**, exit **1**, 0.397 s; beforeAll spawnSync EPERM caused 36 reported failures. Environment restriction, not 36 product defects. |
| `dedicated-escalated.json` and stdout/stderr logs | Start **17:19:07.615270Z**, exit **0**, 1.294 s; **1 suite / 36 passed**, 0 failed. Scoped escalation permitted Node subprocesses. |
| `preserved-api-and-fixes.json` | Six method bodies and four registration declarations unchanged. |
| `reviewed-source/` | Exact AudioPlayer/AudioModule/MediaController bytes used for this review. |
| `pins-after.json` | Final current-versus-manifest and before/after comparison. |

Final reviewed SHA-256 values:

| Source under `app/ios/puuk-ios/` | SHA-256 |
|---|---|
| `scripts/patch-expo-audio.js` | `cb7535449e3c410af58eb6947a765d7da230c80be73e3f0dc9bb5e7f0c16e3a0` |
| `utils/__tests__/patchExpoAudio.test.js` | `22bd215dcd738d8a7a60a8793b9e7f95981fa81e89ee8e33c82b5eb00d7b143c` |
| `node_modules/expo-audio/ios/AudioPlayer.swift` | `016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746` |
| `node_modules/expo-audio/ios/AudioModule.swift` | `07c2e437e9d99c44cc7b5c0500fb51d91d1e95283bbb93359890241037370b33` |
| `node_modules/expo-audio/ios/MediaController.swift` | `d59f4d3d13fd8546cd21dfd103718b3c573cf04554c8c59dcac029e6fd029e86` |

**Not tested:** Swift compile/link/registration; actual OS callback and isPlaying timing; audible playback/volume; native lock ordering/concurrency; Bluetooth/hardware controls; installed-binary capability; full integration/device matrix. Environment probe still found no swift/swiftc/xcodebuild/xcrun/eas, no native builder/phone was used, and build ID is unknown. Existing cross-thread framework-lock/deadlock and same-item finish-versus-seek hypotheses remain separate unproven runtime probes.

Original R1 is closed **only at source-review level**. R2 remains an explicit retained native-boundary finding, with no newly introduced regression established in the checked R1 cause paths. Full independent S2 after J08 and an identified native/device candidate remain required; host tests and this limited re-review cannot close Gate B.
