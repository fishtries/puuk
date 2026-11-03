# Independent R2 corrective review — 2026-11-03

Task `task_0020a1ce7f4e`, Dispatch `ctx_582133096a72`, Run `run_5c86d4feea71`. Independent reviewer of the original native author's [R2 correction](IOS_PLAYBACK_S1N_R2_FIX_REPORT.md). **This is a limited source/host review, not full S2, native runtime acceptance or Gate B.**

**R2: addressed at source level.** Both defects in the [original conditional trace](IOS_PLAYBACK_S1N_R1_REVIEW_REPORT.md#r2--p2-stale-system-end-work-mutates-newer-ducking-state) are corrected: overlapping begins retain the first unducked baseline, and the complete queued end is fenced before/after session activation. Matching denied/failed completion restores volume without granting playback. **No new confirmed P1/P2 source defect was found within the introduced R2 changes.** Framework lock/callback behavior remains explicitly untested below.

Independent evidence: **30/30 final manifest hashes match**, **44/44 focused host patch tests pass**, the **entire AudioPlayer.swift is unchanged** from exact R1, and all **four native v1 registration declarations match**. Build ID remains unknown; no Swift/Xcode/device proof exists.

## Scope and baseline

Read the complete author report, exact R2 native/producer/test diffs and manifests, previous R2 finding, root/component AGENTS and governing plan section 4. Applied the already loaded release-it/software-design and version-matched Orca worker instructions. Exact versioned [Expo 58 Audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) and [FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) documentation was read in this continuous review session; the installed Audio 58.0.10 bytes remain authoritative for this patch.

HEAD `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5`; dirty/untracked state is the baseline. Installed Expo 58.0.19, Audio 58.0.10, FileSystem 58.0.11, Modules Core 58.0.26. The 30-entry author manifest includes the fix report as well as the delivered producer/test/fixtures and installed native sources. Compared each current file independently, rather than relying on the author's reported result.

Review was confined to the introduced R2 producer/test/native changes and preservation of earlier invariants. Read the directly called generic pause/resume and recorder methods only to assess the new boundary; no unrelated SDK audit or implementation was undertaken. No active J07 coordinator or other peer JS implementation/test was imported or run. Only this report and `/tmp/puuk-playback/S1N-R2-REVIEW/` were written; no product changes, reset/clean, commit, deploy, restart of Puuk services, production request or audio write occurred.

## Why the reported R2 trace is closed

Paths below are relative to `app/ios/puuk-ios/` and refer to exact reviewed installed output.

- `node_modules/expo-audio/ios/AudioModule.swift:719` acquires the shared module lock, advances generation and records pending state. It preserves outstanding actions. At `:731`, a baseline is saved and volume reduced only when the player's baseline is absent. With initial volume 1, D1 saves 1 and ducks to 0.5; D2 retains 1 and does not duck to 0.25.
- End captures generation and player tokens under the same lock (`:759`–`:765`). Queued work checks ownership before activation (`:775`–`:778`), releases the bookkeeping lock for activation, then reacquires it and checks pending/generation again (`:780`–`:783`) before any player completion or module cleanup. D2 beginning during activation therefore rejects D1's later effects whether activation succeeded or failed. An OS activation already in progress is not cancelled by this check; that limitation is documented rather than misrepresented as atomic OS control.
- `resumeInterruptedPlayers(generation:shouldResume:)` at `:852` validates matching ownership itself, restores saved volume independently from playback permission, and permits generic/recorder resume only when shouldResume is true. It clears only after this matching completion; pending=false rejects later duplicate completions.
- The no-resume path finishes matching player permission and restores/clears module actions synchronously with shouldResume=false (`:766`–`:771`). Failed matching activation uses that same denied completion. Neither path issues generic/recorder automatic play. AudioPlayer's unchanged cause/veto/token checks own its playback permission.
- Cleanup uses recorded volume and actual-paused membership rather than the current interruption mode (`:856`–`:863`). Mode assignment is synchronized with begin (`:955`–`:957`). A mode change cannot convert a duck-only action into generic play admission or lose the first volume baseline.

### Explicit/route stop and generic semantics

`AudioModule.pauseExplicitly` at `:704` holds the shared module lock across synchronous notification delivery, resume-membership revocation and actual pause. Its selector (`:711`) removes membership and clears generic lifecycle `wasPlaying`; saved volume may still be restored without granting play. Generic stop and matching cleanup therefore serialize: if stop wins, cleanup cannot resume that member; if cleanup wins first, the later actual stop completes afterward.

JS player/playlist pause (`AudioModule.swift:296`, `:426`), explicit audio disable (`:931`) and remote pause/generic-toggle pause (`MediaController.swift:318`, `:331`) use this boundary. Route loss removes current membership even for already system-paused generic playables (`AudioModule.swift:801`–`:810`). AudioPlayer route/toggle behavior still uses its original intent fence; generic duck-only state is never inserted as actual-paused membership. This addresses the R2 cleanup scope; it is not an acceptance claim for every unrelated generic lifecycle path.

## New module lock / synchronous notification assessment

**No concrete new lock inversion, infinite recursion or callback defect was established from the inspected source.** This is a source finding, not a claim of deadlock freedom.

- The notification sender and all module selector observers acquire the **same static NSRecursiveLock**. Selector notification delivery adds no queue handoff in this bridge, and its intentional same-thread reacquisition is recursive. The observer only revokes membership/bookkeeping; it does not call pauseExplicitly recursively. The actual playable pause runs after that notification returns. Existing OnDestroy removes the module's selector observers (`AudioModule.swift:108`–`:117`).
- Inspected nested order is module interruption lock → player source lock. The reviewed AudioPlayer callbacks do not establish the reverse edge: status emission schedules JS delivery; off-main lock-screen updates enqueue main work rather than synchronously waiting; release/completion closures enqueue session work. Registry snapshots return before invoking playable methods, and removal uses asynchronous barriers. No code-proven source-lock → new module-lock cycle was found.
- Audio session activation is outside the module lock in the queued end. Reacquiring and revalidating afterwards closes stale **completion effects** without holding bookkeeping across that OS call.

**Runtime hypotheses / probes, not confirmed severity findings:**

1. AVFoundation/Combine/NotificationCenter internal cross-thread locking and observer teardown require native stress. Recursive locking only establishes same-thread reentry, not absence of framework lock inversion.
2. Cleanup holds the recursive lock while restoring volume and invoking native resume methods (`AudioModule.swift:858`–`:869`). If those framework operations can synchronously deliver a *new system-begin notification on the same thread*, reentry could change generation during a cleanup that checked ownership only at entry, before its final collection clear (`:874`–`:876`). No such synchronous path is established by the inspected application code, so this remains a conditional runtime probe rather than a claimed R3 defect. Exercise it with native instrumentation; reconsider generation checks around external callbacks only if the ordering is reproduced.
3. Verify synchronous explicit-pause notification lifetime, multiple module instances, nested route events and cancellation/release while callbacks execute. Test with bounded completions/thread diagnostics and the actual rebuilt binary. No speculative lock redesign is proposed from host results.

Structured source assessment and exact reviewed AudioPlayer/AudioModule/MediaController copies are retained in `source-assessment.json` and `reviewed-source/` under this task's artifact directory.

## Earlier invariants, v1 API and patch delivery

Independent exact-file comparison against fresh R1 baseline confirms all of **AudioPlayer.swift** unchanged (SHA-256 `016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746`). Thus F1's locked intent admission, F2's successful seek/context/intent/generation checks and cancellation ordering, F3's locked relative seek, F4's intent toggle and R1's separate lifecycle/system causes and no-resume veto remain intact. All four capability/API registration declarations also compare equal (`preservation-independent.json`). Public version remains 1 with no new JS capability or unguarded recovery fallback.

The tracked producer adds a stage requiring complete exact R1 input hashes (`scripts/patch-expo-audio.js:1745`). Supported full inputs remain pristine Audio 58.0.10, legacy Puuk, S1, first correction, R1 and current R2 repeat application. Each historical intermediate and final output is verified. Input drift/missing/marker-only modifications and failed transforms reject before planned disk writes; disk originals are rechecked before committing staged outputs (`:2021`–`:2090`). Sequential final writes are not a multi-file filesystem transaction under OS failure.

Historical producer fixtures remain exact; the new R1 producer fixture matches `cb7535449e3c410af58eb6947a765d7da230c80be73e3f0dc9bb5e7f0c16e3a0`. The focused suite executes all historical migration entries, current idempotence, partial generation rejection and failed original/corrective/R1/R2 transformation preservation. Its new R2 checks assert baseline retention, full completion guards, denied/failed cleanup, recorded-action semantics and stop revocation. They do **not** execute Swift interleavings.

## Fresh verification and evidence

Independent test cwd: `/tmp/puuk-playback/S1N-R2-REVIEW/isolated`. Copied producer/test/fixtures byte-for-byte, used the installed Jest runner with a Node environment and no product setup/transforms/cache; TMPDIR was confined to this review. This avoids importing concurrent J07 JS.

```sh
node /home/fish/projects/puuk/app/ios/puuk-ios/node_modules/jest/bin/jest.js --runInBand --runTestsByPath /tmp/puuk-playback/S1N-R2-REVIEW/isolated/utils/__tests__/patchExpoAudio.test.js --config /tmp/puuk-playback/S1N-R2-REVIEW/jest.config.json --json
```

| Evidence under `/tmp/puuk-playback/S1N-R2-REVIEW/` | Fresh result |
|---|---|
| `pins-before.json` | **30/30** current hashes match author's final-after manifest. |
| `dedicated-initial.json`, stdout/stderr logs | UTC start **2026-11-03T05:22:11.749478Z**, real exit **1**, 0.388 s; beforeAll spawnSync EPERM caused 44 reported failures. Environment restriction, not 44 diagnosed product defects. |
| `dedicated-escalated.json`, stdout/stderr logs | UTC start **2026-11-03T05:22:47.617232Z**, real exit **0**, 1.481 s; **1 suite / 44 passed**, 0 failed. Scoped escalation permitted Node subprocesses. |
| `preservation-independent.json` | Entire AudioPlayer plus four v1 declarations preserved. |
| `pins-after.json` | Final manifest/current and before/after comparison, report hash. |

Exact test argv/cwd/timestamp/elapsed/exit are recorded in the test JSON files; failure output was not overwritten. No full suite, export, peer tests or additional native compile was run. The author's separate failed injection/audit-helper invocations remain in its own report/artifacts and are not relabelled as independent verification.

Reviewed final hashes:

| Path under `app/ios/puuk-ios/` | SHA-256 |
|---|---|
| `scripts/patch-expo-audio.js` | `0923ad325ded9385e0bc6c95afad478a1ff2bff6453fb403201eed5d408a8d6c` |
| `utils/__tests__/patchExpoAudio.test.js` | `9538fdf66697549469f400c948961e18cadedbafd789d10920435ed540814970` |
| `node_modules/expo-audio/ios/AudioModule.swift` | `81577fb10c88206da394daa548379c64b6bce4dc833287352b5bb8fd74f8e43e` |
| `node_modules/expo-audio/ios/MediaController.swift` | `2e90e151ddbbc9d696e7fade169d37c5ba5c12d9e7d0b9f7893302c619dcc3cd` |

## Acceptance limits

**R2 source/host correction passes this independent scoped review; no new confirmed defect is left open in the reviewed R2 delta.** Native compile/link/Expo registration, actual callback ordering/reentry/deadlock behavior, audible volume/playback, Bluetooth/hardware routing, installed-binary identity and device matrix remain **not tested**. Linux has no swift/swiftc/xcodebuild/xcrun/eas on PATH and no Mac/native builder/iPhone was used (`environment.json`); build ID is unknown. Previous same-item finish-versus-seek and broader framework-lock hypotheses are unchanged, not expanded into new assertions by this review.

Full independent S2 still follows J08. The actual rebuilt native candidate and device evidence are necessary before native/Gate B/device acceptance; patched source and 44 passing host checks cannot substitute for those facts.
