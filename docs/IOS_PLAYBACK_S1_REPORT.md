# S1 / Gate A and conditional S1N — 2026-10-30

Task `task_d362cc8f824d`, Dispatch `ctx_2ef17f633ee2`, Run `run_5c86d4feea71`. HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5`; the dirty working tree is the baseline, not HEAD. Build ID **unknown**. Linux only, no Xcode/Swift compiler/iPhone and no connected Mac/remote builder (`S0/native-environment.json`).

**Local result: contract and reproducible native source patch implemented; final targeted run 8 suites / 183 tests passed (167 existing + 16 dedicated patch tests). Native compilation, native runtime correctness, installed-binary provenance and device acceptance remain not tested and block Gate B/device acceptance.** The coordinator decides Gate A dispatch acceptance from these artifacts. This is not a claim that the playback incident is fixed.

## Accepted diagnostic interpretation

Read the complete plan, root/component AGENTS, S0/J01/J02/J03, coordinator review and transport summary, release-it and software-design skill rules. S0's 7/167 baseline passes. J01 localizes absent late-error recovery, finite watchdogs, current/next isolation, background budget and dynamic URL binding; its mocks do not measure audible startup. J03 establishes absent source identity and stale deferred-native-play risk, but its proposed default-active-attempt tagging/status-equality and pause-created identity were rejected. Identity must bind a JS request at native installation, with originating callback guards; pause changes intent, not source identity.

J02 is accepted only for its checked sample: 58 server-originated requests, three files, 36 exact body comparisons, appropriate checked HTTP/Range responses and fresh 53-test backend rerun. It does not exclude backend behavior at other times, the unidentified incident track or mobile DNS/TLS/Wi-Fi/LTE path. Public throughput around 9.5 MB/s is not labelled slow without an accepted SLO. The initial reused-DB `2 failed / 51 passed` and incorrect green JSON were observed by the coordinator; that first log was overwritten, its cause is unknown, and a later fresh run is separate passed evidence. Historical diagnostic reports remain unchanged.

Exact versioned [Expo 58 Audio docs](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) and [FileSystem docs](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) were fetched/read through the web tool, supplementing `S0/sdk58-docs.md`. Audio replace returns a command, not readiness. FileSystem tasks start explicitly and expose progress/cancellation; installed source determines actual HTTP error shape. Installed versions: Expo 58.0.19, Audio 58.0.10, FileSystem 58.0.11; node v26.12.0/npm 12.2.1. Installed `FileSystemDownloadTask.swift` embeds HTTP failure in exception text, without a numeric HTTP-status field; unknown errors must not acquire invented auth/status semantics.

## Binding implementation contracts

The authoritative signatures, event payload, budgets and compatibility rules are in [plan section 4.1–4.6](IOS_PLAYBACK_RELIABILITY_PLAN.md#41-identity-and-the-supplied-native-boundary-s1n). They target existing modules, without another service/wrapper layer:

- J04: `invalidate(trackId,expectedUri):Promise<boolean>` compare-and-removes only the exact published copy; 20 s inactivity, 180 s overall, at most three transient attempts with 800/2000 ms delays; cancellation/backoff/init cleanup and existing dedup/atomic publication remain binding. Unknown native exceptions are terminal rather than guessed HTTP errors.
- J05: `setPlaybackPressure({requestId,phase})`, `cacheCurrent(track,options)` and existing queue APIs share the same bounded active budget, including current-cache work; pressure cancels FileSystem work once per edge, never native playback. Stable proof spans >=1 s with >=0.25 s advancing progress, resume starts one slot then ramps another after 1 s; current-cache eligibility is 5 s after stable. Offline starts none; unknown/cellular at most 1/1, Wi-Fi at most 2/2.
- J06: resolve current server at source/task start; preserve explicit constructor URL/provider injection. Cancel incompatible network epochs on server changes without replacing healthy native playback or clearing the full persistent cache.
- J07/J08: coordinator owns `handleNativeStatus`, `setIntent`, `retryCurrent`, `cancelCurrent` and independent current/next state. A direct native subscription preserves single-event errors/finish. Selection/history identity survives technical retry; installation identity changes on every retry. User pause/seek, native pause/interruption, auth epoch and source change invalidate delayed work. Minimizing the player is not a dismiss/stop intent.

Default playback budgets remain 15 s startup, 10 s no-progress stall, one automatic replacement after 800 ms and 30 s total episode. Header acquisition and recovery seek each have at most 5 s within that total. Loaded/command return/seek jump is not playback confirmation. No automatic native recovery on an old binary lacking all three guarded APIs and capability version; explicit user retry remains available. No native preload/AudioPlaylist migration, backend edits or hook/cache/scheduler/coordinator implementation occurred in S1.

## Supplied native patch and exact JS API

Deliverable: `app/ios/puuk-ios/scripts/patch-expo-audio.js`, its dedicated test and isolated fixtures. Applying a patch only to node_modules is not the deliverable. Existing postinstall already runs this tracked script.

```js
player.puukSourceIdentityVersion === 1;
player.replaceWithAttempt({uri,headers}, newAttemptId, expectedIntentRevision, expectedOldAttemptId);
player.playForAttempt(attemptId, expectedIntentRevision);
player.seekForAttempt(attemptId, positionSeconds, expectedIntentRevision);
// All return boolean synchronous command acceptance, never readiness.
```

Explicit selection passes null/null to replace; delayed recovery passes the captured revision and old attempt. Explicit play/user seek passes null revision; technical resume/restore passes a matching revision. A rejected guarded command has no unguarded fallback. JS supplies resolved URI objects; new APIs do not use the SDK string/asset shim. The capability and all three methods must exist before automatic recovery is enabled.

`playbackStatusUpdate` adds `sourceIdentityVersion`, `sourceAttemptId`, `nativeEvent`, `nativeIntent`, `intentRevision`, optional `seekTargetSeconds`, `seekCompleted`, `seekOrigin`. Event kinds: snapshot/intent/loaded/progress/seekIntent/seek/error/finish/reset. Intent is play/pause/interrupted; seek origin is user/recovery. Recovery seeking checks native revision, preserves that intent revision and emits recovery metadata, so J07 can acknowledge its own seek without cancelling itself. User/lock-screen seeks increment intent revision and always supersede technical restoration. Progress is suppressed as confirmation while a seek is pending.

The patch binds the supplied ID before installing a new AVPlayerItem and captures concrete item/player/attempt in observer contexts. All source status publication requires that context; no default-to-active-attempt path exists. Old item/player callbacks are rejected before subscription mutation; queued JS events retain the original ID, including A/B/A. Periodic/ready/error/finish/seek/reset paths capture/check their origin, ready subscriptions are removed on source switch/pause/release, pending seeks and observers are cleaned up, and pause leaves source identity unchanged. Legacy replace clears identity. Loop/reset descendants retain the logical installation ID with concrete item/player guards; they are not new JS-authorized recovery attempts.

Public JS pause now reaches native `pause()` (the old AudioModule bypassed it). Loading sources are included in system/route interruption pauses; explicit pause blocks later system resume. Native change-position/skip-forward/skip-back commands now use the same seek boundary. Position restoration can seek a paused item but cannot autoplay. The existing background task end-after-play behavior is retained; source failure deterministically ends its outstanding task. Extending protection until confirmed progress remains an S2/device decision.

### Native execution and atomicity limits

Installed `expo-modules-core/.../SyncFunctionDefinition.swift:87–112` executes synchronous functions under `@JavaScriptActor` and calls their body inline; it does not route them through the main queue. Combine KVO has no explicit receive queue in this SDK, periodic time observer uses queue:nil, and MediaController handlers have no explicit queue serialization. There is no evidence those entry points share one thread.

The patch therefore puts source/intent guard plus replace/play/seek/pause mutation in one `NSRecursiveLock` critical section, with matching observer-state locks and recursive reentry for synchronous KVO. It holds no lock across an async await. Source snapshots also synchronize. Seek completion checks its seek revision and publishes under the same lock, so an old completion cannot acknowledge a newer same-source user seek. This is a source-level implementation, **not proof of iOS scheduling/deadlock freedom**: S2 must compile and stress source switch/seek/pause/interruption/release on a real native build. In particular verify AVFoundation/KVO reentry and lock ordering; regex/source checks cannot establish that runtime property.

### Patch reproducibility and drift behavior

Full SHA-256 allowlists pin each target to pristine Audio 58.0.10, the exact pre-S1 Puuk patch or the exact final identity-v1 output. Stage all transformations in memory, validate every complete output and check concurrent source changes before the first write. Missing files, source drift, modified-marker-only output or a broken internal transform fail nonzero without writing earlier staged patches. Byte-identical repeat application exits 0. This is validation-before-write; an OS write failure is not claimed to be a multi-file filesystem transaction.

Five pristine Swift fixtures come from the offline official npm tarball with integrity `sha512-GoOyd1JAb7l/bJ/UNc5QIrXqSK9QrEFF3ahjdONGt8V6PN3RXRsTcOJDMN6RmDc9kb0XPP34DJIxEd/ushH1RQ==`; LICENSE and provenance are included. The preserved legacy-patch fixture reproduces migration without Git/npm/network or mutation of installed SDK sources. Source-contract tests are explicitly labelled static, not AVFoundation runtime tests.

## Verification and evidence ledger

Cwd for verification commands: `/home/fish/projects/puuk/app/ios/puuk-ios`. Exact argv, UTC start, exit and elapsed time are in `/tmp/puuk-playback/S1/commands.jsonl`; each row has a separate immutable log filename. Before/after hashes: `before-manifest.json`, `final-manifest.json`; protected product-file comparison: `protected-files.json`.

| Command / evidence | Exit | Duration | Result |
|---|---:|---:|---|
| `node scripts/patch-expo-audio.js` (`final-installed.log`) | 0 | 36.24 ms | passed |
| `node --check scripts/patch-expo-audio.js` (`final-syntax.log`) | 0 | 21.06 ms | passed |
| `npx eslint --no-config-lookup --config /tmp/puuk-playback/S1/eslint.config.cjs scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` (`final-lint.log`) | 0 | 325.47 ms | passed |
| `npx prettier --check scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` (`final-format-passed.log`) | 0 | 301.36 ms | passed |
| `node scripts/patch-expo-audio.js` (`final-idempotency-passed.log`) | 0 | 28.13 ms | passed |
| `npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js utils/__tests__/audioCache.test.js utils/__tests__/preloadScheduler.test.js utils/__tests__/networkPolicy.test.js utils/__tests__/streamUrl.test.js utils/__tests__/playbackCoordinator.test.js hooks/__tests__/usePlayerController.test.js components/fullplayer/__tests__/PlayerNetworkBanner.test.js` (`accepted-combined.log`) | 0 | 2909.97 ms | passed |


Final pinned revision (after the seek-completion guard/publication correction):

| Evidence | Exit | Duration | Result |
|---|---:|---:|---|
| `pinned-installed.log` (`node scripts/patch-expo-audio.js`) | 0 | 31.26 ms | passed |
| `pinned-combined.log` (`npm test -- --runInBand utils/__tests__/patchExpoAudio.test.js utils/__tests__/audioCache.test.js utils/__tests__/preloadScheduler.test.js utils/__tests__/networkPolicy.test.js utils/__tests__/streamUrl.test.js utils/__tests__/playbackCoordinator.test.js hooks/__tests__/usePlayerController.test.js components/fullplayer/__tests__/PlayerNetworkBanner.test.js`) | 0 | 2875.26 ms | passed |
| `pinned-format.log` (`npx prettier --check scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js`) | 0 | 329.75 ms | passed |
| `pinned-lint.log` (`npx eslint --no-config-lookup --config /tmp/puuk-playback/S1/eslint.config.cjs scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js`) | 0 | 346.59 ms | passed |

Earlier failures are retained: initial patch run inside the sandbox failed because child Node spawn was blocked with EPERM (its apparent status output was not accepted as evidence); the same suite passed after escalation and now explicitly throws spawn errors. An injected-transform test initially used a formatting-sensitive anchor; that test was corrected and rerun. One combined run listed the patch path but executed only 7/167 because the owned test file had disappeared; it is not 8-suite evidence. Another run executed 8 suites but failed 1/183 because the legacy fixture had also disappeared; the final 8/183 run follows restoration. Offline `npm pack` failed ENOTCACHED for registry metadata; direct read-only extraction from existing cacache succeeded and matched official integrity. A documentation update initially used the app cwd instead of repo root; it was corrected before reporting.

### Concurrent owned-file drift

At 18:00:38 UTC the owned patch inode was externally replaced with an earlier S1 version (1034 lines, no guarded seek/lock), and the owned untracked test plus later fixture files disappeared. The coordinator confirmed it did not perform that change; origin remains unknown. Exact final implementation/tests were restored from task-owned temporary artifacts/Jest sourceContent before the coordinator's later read-only hold arrived; no intentional foreign edits were identified or synthesized. `drift-checkpoint.json`, `final-source/`, `final-patch-expo-audio.js.backup`, `patchExpoAudio.test.js.backup` and `plan-final.backup.md` preserve the evidence. Further repository writes were held until the coordinator relayed explicit user approval to restore our exact artifacts and continue; unrelated edits were preserved. The checked S1 runtime-product baseline hashes remain unchanged; externally changed PlaylistScreen files are outside this task and were preserved.

## Passed / failed / not tested and handoff

**Passed locally:** complete source transformation from pristine and legacy SDK; repeat application; drift/missing-source/failed-transform rejection; 16 patch source/fixture tests; unchanged existing 167 playback regressions; protected cache/scheduler/coordinator/hook/App/lockfile bytes. Exact changed-source hashes follow below.

**Historical failed checks:** sandbox subprocess restriction, initial brittle failure-injection test, missing owned test/legacy fixture during drift; final verified suite supersedes these only for the identified final source, without erasing their logs. Formatting initially failed on the restored unformatted artifacts, then passed after formatting only the two owned JS files; the final 183-test run follows that formatting.

**Not tested:** Swift compilation/linking, Expo native method registration on device, actual native event timing/order/deadlock behavior, installed-phone capability/build identity, audible output, real pause/seek/interruption/Bluetooth/lock-screen behavior, mobile path and startup latency/SLO. No full iOS suite/export/device matrix is claimed in S1; S2/J09 own them. Automatic recovery must remain disabled on capability-absent existing binaries. S2 independently reviews this patch and all implementations before a new identified native candidate can close Gate B/device acceptance.

| Source | SHA-256 |
|---|---|
| `app/ios/puuk-ios/scripts/patch-expo-audio.js` | `c4146f0c8d041b8d163ab5256b4a2f099296d6f72d3c7c8dff2ce8f897925f71` |
| `app/ios/puuk-ios/utils/__tests__/patchExpoAudio.test.js` | `2c4210efbe11eb7ddd235a9cd0c0bd5ee3a673398360d7fba24b848a6e0ca3db` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/AudioPlayer.swift` | `7618a05d110f31624073f91e2be9c40ad60229cfb8a22f40a8fd425b9346bd04` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/AudioModule.swift` | `27a51ef0c2d6d52938f6f078b12aa38f32cc68d8b9d3ac6303373ea28267707b` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/MediaController.swift` | `fe5b7b908f98632f6deb3efc71712ac9ee4489bde0ecb90fcdc1b9be33acf830` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/AudioComponentRegistry.swift` | `8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/AudioUtils.swift` | `7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01` |
| `app/ios/puuk-ios/node_modules/expo-audio/ios/AudioPlaylist.swift` | `56524ad4a486a37d3e494d0f06d8c637a98f4d15fb3a0cfb2c94a1d9c54cceb5` |
| `app/ios/puuk-ios/package-lock.json` | `ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd` |


No commits, deployments, restarts, outbound messages outside the authorized Orca coordinator, production mutations or audio-file edits were made. The user explicitly authorized restoring the exact owned artifacts and continuing; that coordinator instruction is recorded in msg_5b03dba112bc/msg_a53c2c2055d3. The final 26-file pinned-before/after manifests match exactly, with the dedicated test and every fixture present. Report and plan journal are published; coordinator review/dispatch is the next step.
