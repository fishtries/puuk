# Initial native intent — independent bounded preflight

2026-11-04 · Task `task_3a8cfbe50f0b` · Dispatch `ctx_a1499dccb311`.

**Decision: retain native v1.** A bounded terminal playback error, followed by explicit Retry that installs/restores a healthy **paused** source and a fresh explicit Play, satisfies the present plan's minimum contract. Automatic recovery of every installation failure is not required: J07 permits recovery **or terminal error**, and J08 requires Retry to replace the failed current source while respecting pause. This is a conservative degraded outcome, not successful automatic recovery or one-tap playback restoration. Author verification and independent S2 remain required; this review accepts no moving implementation or native runtime.

## Verified cause and model limit

Read root/component AGENTS, plan 4.1–4.6/J07/J08/S2, accepted J07 senior report, R2 fix/review, real hook integration test and retained failure logs before deciding. Applied orchestration, release-it and software-design skills. Exact copies and SHA-256 are in `/tmp/puuk-playback/INITIAL-INTENT-REVIEW/input-manifest.json` and `inputs/`.

Installed `AudioPlayer.swift:95,123–145,224–241,466–489` confirms:

- Initial intent is pause, revision zero. `replaceWithAttempt(source, attempt, null, null)` installs under `sourceLock`, bypasses preload and calls `replaceCurrentSource(..., resumeWhenReady:false)`. It neither sets play intent nor increments its revision. Its internal `ref.pause()` is physical pause, not a new explicit pause intent.
- Integer-guarded replacement requires matching installed attempt, revision **and native play intent**. `playForAttempt(attempt, revision)` also requires native play intent; only its null form admits fresh explicit play. `play(at:)` then advances intent/revision and invokes physical playback.
- Consequently, when an initial error is handled before initial play, the accepted J07 coordinator correctly skips play on the failed source. Native remains pause; automatic **replacement itself** rejects. Retained-intent manual Retry cannot guarded-resume that never-admitted play intent either. This is a code-confirmed conditional admission gap, not evidence the guard is wrong. The earlier integration model omitted the native-play predicate on replacement and therefore reached a later resume failure instead.

`integration-third.log` retains the failed two-play-call expectation; `narrow-fix-first.log` retains the failed-source-play regression caused by attempting to finish initial play. The existing accepted coordinator test around line 2972 correctly forbids that play. `safe-terminal-first.log` retains the separate terminal-queue-pause failure. None is relabelled as a passing review run.

**Event order is not device-proven.** Item creation/installation and the Combine status sink (`AudioPlayer.swift:393–426`) can produce a source-attributed failure without a preceding play. However, `SharedObject.emit` forwards to `EventEmitter.swift:110–138`, which uses `runtime.schedule`; `JavaScriptRuntimeScheduler.swift:64–76` schedules a task rather than using its distinct inline `runOrSchedule` path. `AppContext.swift:440–472` documents the normal React scheduler and a synchronous fallback when scheduler pointers are absent. The mock's inline JS `onInstall` callback and the coordinator test's Promise-returning replacement are stronger adverse orderings than the registered synchronous native `Function(...)->Bool`. They establish JS behavior for that ordering, not its occurrence on the normal installed bridge. Do not infer synchronous JS delivery from synchronous native KVO emission, or dismiss early-event defenses solely from this distinction.

## Minimum safe ordering and invariants

Recommend the J08 author's narrow JS terminal-veto handling, with these observable steps:

1. Subscribe before selection; preserve request/attempt/auth ownership. Never play an attempt once its initial error has scheduled recovery.
2. Attempt automatic replacement with the captured integer revision and previous attempt. If it returns false, restore the actually installed identity; only the still-owning operation may publish terminal playback error and conservative paused JS intent. Clear recovery/watchdog pressure. A later native pause/interruption revision remains authoritative. Do not send native play or another pause as a response to rejection.
3. Explicit current Retry retains the logical request/history ledger, refreshes bounded headers, installs a fresh remote source through the existing explicit replacement boundary, waits matching loaded, then issues `seekForAttempt(newAttempt, latestPosition, capturedRevision)` and waits successful matching acknowledgement, including position zero. For this rejected-admission case it stays paused and clears the displayed error only after successful restoration. Concurrent taps join one operation; failure stays visible.
4. A subsequent fresh `setIntent({type:'play',requestId})` uses `playForAttempt(currentAttempt,null)` as already specified for explicit user Play. Only matching advancing native progress confirms start/history. Normal Retry with previously admitted play intent still uses integer-guarded resume; genuine paused Retry remains paused.

Latest pause/seek, source switch, auth change, dismiss and unmount must invalidate pending continuations before their next side effect. Guard false never authorizes an unguarded fallback. The frozen J07 request/attempt/revision checks and native source lock remain essential; false is command rejection, not readiness or a playback acknowledgement.

## Why the proposed native shortcut is rejected

Changing null/null `replaceWithAttempt` to establish desired play intent would change public v1 behavior even without physical playback. The same signature is used by paused manual Retry and source repair, not just fresh playing selection. It could make a paused source appear play-intended, advance revisions unexpectedly, or admit automatic/system resume without a new explicit Play. Installation would also need to define active interruption causes, veto state and reentrant callbacks; merely assigning intent/revision under the source lock does not settle those semantics. Existing installed v1 binaries would retain the old behavior, so the present capability check could not distinguish contracts.

If a future product decision requires one-tap Retry-to-play for never-admitted intent, assign a separate native/producer owner and amend the contract first. Prefer a versioned, explicit admission operation such as `admitPlaybackIntentForAttempt(attempt, expectedRevision)` that does **not** play: under the source lock it must check current source and captured revision, deny intervening pause/seek/release and active interruption/veto, then establish a new revision before any emitted callback. JS must capture the pre-wait revision, admit only while the explicit action still owns request/auth/intent, capture the resulting revision, and use integer guards for restoration/resume. This is an alternative requiring design/tests and a rebuilt identified binary, not a change authorized or needed by this review. Never broaden guard-false semantics or complete play on the failed source.

## Author ownership, required checks and remaining probes

J08 author owns the authorized narrow coordinator/hook corrections and their tests; native/producer stay frozen. Before acceptance require exact-source targeted public tests for: initial error with zero failed-source plays; replacement veto terminates promptly with old identity restored; Retry creates a new healthy paused source, clears error after loaded/true seek acknowledgement, and explicit Play succeeds; ordinary play-intended Retry still resumes; paused Retry does not; latest pause/seek/system interruption during installation, headers and restoration wins; A/B/A/auth/dismiss/unmount and obsolete rejection cannot mutate the new owner; double Retry shares one promise; false/throw/failed seek/timeout never autoplay; one history/start/finish ledger. Retain both inline adverse-order and queued-delivery tests with truthful model labels and replacement's actual native-play predicate. Assert outcomes and accepted commands, not a mandatory two-play-call count.

No tests, full suite or export were run against moving JS in this read-only preflight. Only this report and its unique temporary evidence directory were written. Independent S2 must verify the final author hashes and required checks. On an identified rebuilt iOS candidate, probe immediate item failure before play, scheduled error/intent delivery versus command return/microtasks, first selection versus replacement of already-playing/paused sources, pause/seek/remote controls during install, overlapping system/lifecycle/route interruption and denied resume. Native compile/link, actual OS ordering, audible output and device acceptance remain unproved; Linux/source reasoning cannot supply them.

## Source pins

| Input | SHA-256 |
|---|---|
| Frozen accepted J07 coordinator | `65741867e211b5f8677e454a5ceb29bcbe72204701a0e0621d6707c29dd47f03` |
| Installed AudioPlayer.swift | `016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746` |
| Installed AudioModule.swift | `81577fb10c88206da394daa548379c64b6bce4dc833287352b5bb8fd74f8e43e` |
| Deliverable native producer | `0923ad325ded9385e0bc6c95afad478a1ff2bff6453fb403201eed5d408a8d6c` |
| Captured moving integration test | `ffb0bb0b7c98d792ac621b7fb61805a66997a19811d4f94fc1c440053361cb7a` |

Native/producer pins match accepted R2 reports. Moving JS copies are explicitly observations, not frozen acceptance candidates. The manifest includes all reviewed plan/reports, bridge/scheduler sources and existing J08 logs, preserving failures without overwriting them. Initial decisions were sent promptly to the coordinator as `msg_2ff477a23755` and the event-delivery qualification as `msg_2b6399c04907`.
