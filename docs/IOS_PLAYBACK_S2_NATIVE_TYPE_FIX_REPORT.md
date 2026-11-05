# S2 native remote pause type correction — SOURCE-ONLY

Task `task_8f6eee02d9b7`, Dispatch `ctx_76934dc80720`, Run `run_5c86d4feea71`. Narrow corrective author implementation; independent reviewer remains `ctx_3d6a9d4d830e`. Local implementation is complete: **56/56 focused fixture/static tests pass**, syntax/lint/targeted formatting pass, installed producer applies and repeats byte-identically. Swift compilation, native registration, rebuilt candidate/device behavior and Gate B remain **unverified**; candidate/build ID is **unknown**.

## Source correction and preservation

Read root/component AGENTS, governing plan section 4/4.1, native S1N and R2 author/review evidence, independent `/tmp/puuk-playback/S2/native-type-evidence.md`, and release-it mini rules. Checked exact [Expo SDK 58 Audio documentation](https://docs.expo.dev/versions/v58.0.0/sdk/audio/) before code; its current recommendation is 58.0.11, while installed **58.0.10 bytes** remain the pinned authority. No package update was performed. Linux tool inventory confirms swift, swiftc, xcodebuild, xcrun and eas absent.

`MediaController.activePlayable` has type `(any LockScreenPlayable)?`; `LockScreenPlayable` and `Playable` are separate noninheriting protocols. `AudioModule.pauseExplicitly(_ playable: Playable)` cannot accept the former existential just because the currently known concrete implementations conform to both. This is a source-confirmed nominal mismatch with an expected compile error, not an observed compiler diagnostic.

Only remote pause and the generic playing branch of remote toggle now check `if let modulePlayable = playable as? Playable` before calling `AudioModule.pauseExplicitly(modulePlayable)`. Their `else` branches call the original `playable.pause()`. Known AudioPlayer/AudioPlaylist conformers retain the shared module lock, synchronous notification, resume-membership revocation and actual pause through the unchanged helper; a LockScreenPlayable-only conformer retains generic pause. The AudioPlayer toggle delegation and generic play branch remain unchanged. No force cast, protocol inheritance change, broadened API, capability/version change or new native feature was introduced.

Among the five native outputs, **only MediaController changes**, by these two conditional boundaries. AudioModule, AudioPlayer, AudioComponentRegistry and AudioUtils are byte-identical to full R2. Thus the actual shared lock/notification implementation, R1/R2 intent/veto/token logic and ducking-volume semantics are unchanged at source level. This preservation is not a lock-order/reentrancy or runtime proof.

## Delivery and guards

The tracked producer adds a small post-R2 `patchRemotePauseTypes` stage. Existing pristine/legacy/S1/first-correction/R1/R2 hashes are retained exactly, with a new final column; all five full staged R2 hashes must match before the type transformation. Exact R2 input bypasses historical transforms. Every supported generation converges to the same final hashes and repeats without changes.

`s1n-r2-patch.cjs` was already present at this Dispatch baseline and matches the exact R2 producer SHA below; it remains the exact historical migration fixture. Its README now documents provenance. All historical producer files, pristine Swift fixtures and LICENSE are byte-identical to this Dispatch snapshot; none were rewritten. Complete-generation input admission now rejects combinations of individually accepted hashes that do not form one supported full generation before transforms. Unknown/missing/drift inputs fail before planned writes. Existing in-memory staging, final full-output hash validation and disk recheck before first write remain intact; this is not an atomic filesystem transaction against OS write failure or process death.

The original 44 tests remain, with two old untyped-call assertions changed to require the typed boundary. Twelve added cases cover exact R2 migration and unchanged other outputs, repeat application, each specific handler's cast/fallback, failed transformation, five per-file R2 drifts, mixed-generation rejection, wrong-output-pin rejection and concurrent disk modification before commit. Original pristine/legacy/S1/F-fix/R1 migration and prior intent/interruption regressions still pass. Tests execute JavaScript producers and inspect Swift source; **they do not compile Swift or execute AVFoundation**.

## Verification evidence

Fresh evidence is isolated under `/tmp/puuk-playback/S2-NATIVE-TYPE/ctx76934/`; previous-attempt baseline/logs in the parent directory were not overwritten or reused as fresh passes. `before.json`, `baseline/`, `after.json`, `final-source/`, `native-manifest.json` and exact R2-to-final diffs preserve input/output bytes. `commands.jsonl` records exact argv, cwd, UTC start/end, elapsed seconds, real exit, before/after source hashes and complete log SHA-256 for every verification command. Cwd for the child commands below is `/home/fish/projects/puuk/app/ios/puuk-ios`. Snapshot/edit/inspection/IPC operations were not timed verification claims.

| Log | Exact child argv | UTC start | Elapsed seconds | Exit |
|---|---|---|---:|---:|
| `format.log` | `node node_modules/prettier/bin/prettier.cjs --write scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-04T21:18:28.542886+00:00 | 0.162 | 0 |
| `focused.log` | `npm test -- --runInBand --watchman=false --runTestsByPath utils/__tests__/patchExpoAudio.test.js` | 2026-11-04T21:18:28.728660+00:00 | 1.077 | 1 |
| `focused-host.log` | `npm test -- --runInBand --watchman=false --runTestsByPath utils/__tests__/patchExpoAudio.test.js` | 2026-11-04T21:18:38.768932+00:00 | 2.662 | 0 |
| `format-final.log` | `node node_modules/prettier/bin/prettier.cjs --write scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-04T21:19:25.417176+00:00 | 0.201 | 0 |
| `focused-final.log` | `npm test -- --runInBand --watchman=false --runTestsByPath utils/__tests__/patchExpoAudio.test.js` | 2026-11-04T21:19:44.663824+00:00 | 2.973 | 0 |
| `syntax-producer.log` | `node --check scripts/patch-expo-audio.js` | 2026-11-04T21:20:02.271408+00:00 | 0.022 | 0 |
| `syntax-tests.log` | `node --check utils/__tests__/patchExpoAudio.test.js` | 2026-11-04T21:20:02.318973+00:00 | 0.019 | 0 |
| `lint.log` | `node node_modules/eslint/bin/eslint.js --no-ignore --no-config-lookup --config /tmp/puuk-playback/S2-NATIVE-TYPE/ctx76934/eslint.config.cjs scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-04T21:20:02.360950+00:00 | 0.195 | 0 |
| `format-check.log` | `node node_modules/prettier/bin/prettier.cjs --check scripts/patch-expo-audio.js utils/__tests__/patchExpoAudio.test.js` | 2026-11-04T21:20:02.578661+00:00 | 0.166 | 0 |
| `apply-installed.log` | `node scripts/patch-expo-audio.js` | 2026-11-04T21:20:02.769017+00:00 | 0.029 | 0 |
| `installed-idempotence.log` | `node scripts/patch-expo-audio.js` | 2026-11-04T21:20:02.820621+00:00 | 0.022 | 0 |
| `verify-final.log` | `python /tmp/puuk-playback/S2-NATIVE-TYPE/ctx76934/verify.py` | 2026-11-04T21:20:53.728716+00:00 | 0.032 | 0 |
| `environment.log` | `python /tmp/puuk-playback/S2-NATIVE-TYPE/ctx76934/environment.py` | 2026-11-04T21:21:06.336566+00:00 | 0.022 | 0 |

`focused.log` preserves the initial failed sandbox invocation: beforeAll `spawnSync /usr/bin/node EPERM`, so all 55 then-defined tests reported failure from that common setup restriction. The identical focused child argv reran with scoped escalation and passed 55; after adding the disk-recheck case and formatting, final exact-source run passed 56. No failure log was overwritten. Lint explicitly uses `--no-ignore --no-config-lookup` and a task-local CommonJS/Jest globals config so the dedicated test is checked despite the repository test ignore. It checks no-undef/no-unreachable/no-debugger/no-dupe-args/no-dupe-keys; no app-wide lint claim is made.

Installed application and repeat application both exit 0; repeat before/after hashes match. Full suite and Expo export were left to independent S2 frozen checks as instructed. No JS playback/cache/coordinator/network, package/lockfile, production/provider/service/audio change, deploy, reset/clean or commit was made; no nested workers were used.

## Exact pins

Paths are relative to `app/ios/puuk-ios/`. The producer/test/R2 fixture and all five native outputs are listed; complete fixture hashes are in the manifests above.

| File | Before SHA-256 | Final SHA-256 |
|---|---|---|
| `scripts/patch-expo-audio.js` | `0923ad325ded9385e0bc6c95afad478a1ff2bff6453fb403201eed5d408a8d6c` | `d7c6085b16aaafd9bff698c256b67e6959ffc1435e27c2e74c0bcd2bfce0ad89` |
| `utils/__tests__/patchExpoAudio.test.js` | `9538fdf66697549469f400c948961e18cadedbafd789d10920435ed540814970` | `aa88f517fecd76bc7781a4cff60f7378e897f2119678ea61f2423f602a6e11e0` |
| `utils/__tests__/fixtures/expo-audio-58.0.10/s1n-r2-patch.cjs` | `0923ad325ded9385e0bc6c95afad478a1ff2bff6453fb403201eed5d408a8d6c` | `0923ad325ded9385e0bc6c95afad478a1ff2bff6453fb403201eed5d408a8d6c` |
| `node_modules/expo-audio/ios/AudioPlayer.swift` | `016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746` | `016ee2ea3246f0e53ce7437d902ca994f35f8c918b3867a3110af888d2bcd746` |
| `node_modules/expo-audio/ios/AudioModule.swift` | `81577fb10c88206da394daa548379c64b6bce4dc833287352b5bb8fd74f8e43e` | `81577fb10c88206da394daa548379c64b6bce4dc833287352b5bb8fd74f8e43e` |
| `node_modules/expo-audio/ios/MediaController.swift` | `2e90e151ddbbc9d696e7fade169d37c5ba5c12d9e7d0b9f7893302c619dcc3cd` | `e270b82a708b56be4084ffd8dfa4e17dd16c3017f494aaccec793b3b254575b6` |
| `node_modules/expo-audio/ios/AudioComponentRegistry.swift` | `8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0` | `8240462a8aa0b1d5db765e6346557de2cf0e984fc3298567cc159ab7f229a5a0` |
| `node_modules/expo-audio/ios/AudioUtils.swift` | `7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01` | `7488c7cc261b9eed2e797f193fd5ed63f4676b74f397503322462a8f45c66d01` |

## Remaining acceptance

Independent S2 source/integration disposition remains with the independent reviewer. A rebuilt identified iOS candidate still needs Swift compile/link and native method registration, explicit pause versus interruption-end overlap, loading toggle, no-resume veto, duck-volume restoration and framework callback/lock behavior on a physical device. No build/phone capability or audible playback is inferred from patched installed sources, host fixtures or JS tests. Historical runtime lock/reentrancy and event-order hypotheses remain open; this narrow type correction does not claim to close them.
