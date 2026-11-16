# Independent S4 terminal Retry candidate review

Verdict: **FAIL; do not integrate as-is.** This is a source review of the isolated candidate, not S4 or G3 acceptance. The source-less native guard is substantively sound under the installed patched implementation, but the fail-closed branch leaves inconsistent coordinator state, and terminal unload failure is swallowed. The candidate also conflicts with subsequent shared work.

## Findings

1. **FAIL — failed snapshot exits before Retry cleanup and notification.** `coordinator-after.js:1263-1279` creates `_manualRetryToken`, increments generations, then returns on an already-paused, interrupted, missing, or unverifiable native snapshot. This return precedes the `try/finally` at `:1329-1479`, so `_manualRetryToken` remains set. It also changes `current.intent` to pause without notifying subscribers, while leaving the prior error/status in place and doing no fresh ticket/paused source preparation. This is an independent source-path proof, not a device observation: after terminal unload, a native pause (whose source-less event is ignored at `:1483-1495`) followed by Retry deterministically takes this branch. A second Retry sees paused intent and takes a different unguarded installation path. Preserve the native pause, but explicitly settle/notify the attempt and define the first Retry's recovery behavior; cover this scenario including subsequent Play and repeated Retry. Contract `CONTRACT.md:241,255` requires stable error/explicit Retry and preservation of intent. The existing race test (`hooks-test-after.js:376-403`) pauses *after* Retry captures its snapshot and does not cover this earlier ordering.

2. **FAIL — unload failure is silently treated as terminal completion.** `coordinator-after.js:864-878` catches an exception from `replace(null)` without a fallback or observable failure; source cancellation is then unproven and playback/transfer can continue, contrary to `CONTRACT.md:241`'s timeout unload/cancel requirement. Optional chaining also sets `_terminalUnloaded` even if `replace` is unavailable. This is a failure-path source argument; the candidate's mock does not establish the bridge cannot throw. Resolve and test the failure semantics without manufacturing play intent.

3. **PASS, conditional — source-less snapshot and atomic install guard.** In installed `AudioModule.swift:281-293`, `replace(null)` clears attempt and delegates to `replaceCurrentSource`; `AudioPlayer.swift:465-488` pauses AVPlayer and replaces the item, while `:551-552` cannot register onReady without an item. Neither path changes native intent/revision. `currentStatus` exposes source-context attempt and intent/revision (`:266-276`). With captured revision, `replaceWithAttempt(source, attempt, revision, null)` checks revision, wants-play and actual nil attempt under `sourceLock` (`:123-132`); null is an actual expected nil, not an omitted check when revision is present. A pause during ticket resolution changes intent/revision (`:809-816`) and vetoes installation, even though the source-less event is ignored by JS. The test model mirrors this (`hooks-test-after.js:102-113,376-403`). This assumes the synchronous native call succeeds and the binary contains exactly these patched sources; no device evidence was collected. A new build containing the reviewed native patch is required for these semantics, unless the installed binary is independently proven to contain it; stock/older binaries cannot be assumed to have the additive API (`AudioModule.swift:170-174`). No new native patch is proposed here.

4. **PASS, scoped — race and no-auto-retry reasoning.** For Retry after a valid snapshot, `isStale` checks retry, playback, recovery, auth, request and attempt generations (`coordinator-after.js:1285-1292`); `_retryWait` checks before and after each asynchronous phase (`:1219-1249`). Native revision/attempt guard closes the pause-after-snapshot window. Track switch/logout must invoke the existing generation/session fences, and candidate integration tests exercise those during delayed ticket resolution (`hooks-test-after.js:376-403`). Terminal handler clears watchdogs, cancels recovery and aborts media (`:864-873`); source-less status is ignored while error is set (`:1483-1491`); the 35-second fake-time test `:406-411` finds no new installation. These are scoped source/mock conclusions, not full proof for every native event or server transition.

5. **FAIL — wholesale integration would discard later changes.** `later-shared-coordinator.js:471-490` adds a recovery intent-generation check after resolution; `:1556-1563` adds native resume handling for expired/woken descriptors; `:874-878` restores error status after terminal unload. Candidate differs in all these areas, and also changes error classification, revision timing, and legacy replacement failure handling. Reconcile each behavior on the actual latest fenced source and independently retest; do not replace it with the candidate or blindly apply the patch. Review interactions between native resume and terminal-error suppression, and retain proper error-status restoration. Unknown external iOS writer makes latest-source identification and writer fencing essential.

## Evidence and limits

Read the root and iOS instructions, orchestration plan, frozen contract, decisions, gate ledger, release-it mini guidance, candidate README/patch/before/after/later source and all three candidate test files, earlier triage, and race log/JSON. Expo SDK 58 [audio documentation](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) describes public audio APIs and background configuration; it does not specify Puuk's custom source identity API. Native conclusions above are based on installed patched Swift, not generic Expo documentation. Installed package is `expo-audio` 58.0.10; SDK docs currently list ~58.0.12. The recorded author log/JSON reports 4 suites, 281 passing tests; it is not an independent rerun, and mock results do not prove a built or installed native binary. Independent checks here are the explicit source-path arguments above. No production, network media, device, or repository test/source mutations were performed. Other scheduler/share failures and physical-device/background/lockscreen/header capture identified in triage remain unresolved. No S4/G3 acceptance or integration authorization follows.

Baseline HEAD: `89ebc1c30b36837e584fbe72d51cdb0aed6303be`; shared checkout already dirty. SHA-256 reviewed:

```text
CONTRACT.md 325d9b9a965fb1420dc4dc85218392cce8752fd68d3a1e61e9475ab00b020158
DECISIONS.md 86680b54319327f95fdd3d48c98ca1fa867a43dd1cec9f407cfde42eeb61a276
GATE_LEDGER.md 1644aaf3298f26e1f2f3da1ee92ed2abe6f63f5a94f7b0f6e5cf5c18ab80d0c9
CDN_AND_SHARE_LINKS_ORCHESTRATION_PLAN.md b8567b863539b10ca5c6b1b48fa15beccb88ac2483679167c5e333ddf67690e6
README.md 9392d6bda200ab70a3c5bb4b64caecccc0778ffe37387baf2d0b86e34ba1e698
hashes.txt 22ffa8c2a1fb02582597545b897afc335ff1a042b6bfc1ca0e508a7c203641f9
coordinator-before.js 3f482afee339748d7bef2c3d322337b2111d874e938e0c04c89dc172384786b4
coordinator-after.js 100d4ae81cd808c1e14b3d14ca433d70ca273ee06db75a429c4c65e3757a3bd7
coordinator.patch ee93f747c9086eeaea02becfba0136c695422526057cb0e51ca67a3c5d2d7251
later-shared-coordinator.js 28c3d3040e316cc1a080d0174ae68fecc76d5d306a4af4c4d2c045b00f793c9d
coordinator-test-after.js d6a8f23c16fecdccc5a86554e2c815c56e667ecbf2e4b81ccc70755b595d0dca
hooks-test-after.js f37b6ec38efdc1a574efa1039532f32e8530c09d22db7debe6d2389e019f458d
pressure-test-after.js aeec4fcf5c1c063d69cd950d7d1eed5e9ef2493e14bbdcc580952abc9c95920f
triage.md 25ac30388f8bb3cb225ed32a864c37e5dbe6b050b4487306c4f508d07f2d20da
puuk-s4-retry-races2.log ab2b1826cb451b3ecbbeacd580c2c8abce6d5a3dc9703644677a15f49c6c13bf
puuk-s4-retry-races2.json 0a29f64e7b7ed991dc2c7bfa7fa5335ff4bcac09150e86309d4a71e5a0a190e1
installed AudioPlayer.swift 4c18573feeea3d01b5bf39fc064753c8f1244ea181ae0b2d3958780704faeec4
installed AudioModule.swift 00642d1f7e4c2abfe385d2e0565fb93c39b57d2d8b495587b2930a1ed3bd2400
```
