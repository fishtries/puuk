# S4 iOS integration — coordinator continuation

Status: integrated locally, switches off; native compilation and device acceptance pending. Earlier isolated R1 review failed and R2 retained an intentionally failing race. Those reports remain historical. The coordinator implemented the additive native API described in NATIVE_RETRY_DECISION.md and enabled the formerly failing race in the actual test run, including native play/pause/interruption during awaited Retry and old-binary capability handling.

The coordinator merged R2 failure-path corrections with the latest repository source using a three-way merge, preserving later source deadlines, foreground cancellation, recovery intent generations, native resume and terminal status restoration. Source snapshots before editing are preserved in `/tmp/puuk-coordinator-resume/`; no other worker was launched. Retry early exits do not allocate a token; unload failure is visible with best-effort pause and no unproven cancellation claim.

## Verification

- Working-tree integration: 13 suites, 625 tests pass; no skipped tests. This includes existing unrelated dislike tests in dirty files, so this count does not describe the commit.
- Exact staged source snapshot at `/tmp/puuk-cdn-index-xgj4fd5w`: 13 suites, **620 tests pass**, zero failed/skipped, 11.319 seconds. Command: `npm test -- --runInBand --testPathPatterns='(streamUrl|playbackCoordinator|preloadScheduler|audioCache|mediaDelivery|shareLinks|linking|usePlayerController|patchExpoAudio|FullPlayerControlsAndMenu|shared/api/__tests__/share)' --silent --json --outputFile=/tmp/puuk-cdn-index-test-results.json`. The snapshot was created using `git checkout-index`; dependencies were linked from the installed tree. Mixed dislike changes were excluded from staged hook/player files; baseline App.js and other unrelated files were not staged.
- Actual installed Expo patch migration succeeded with `node scripts/patch-expo-audio.js`. Source transformation tests verify pristine install, earlier patch generations, exact prior output migration, idempotence and drift rejection. Static native assertions and JavaScript mocks are explicitly not Swift runtime proof.
- Working-tree Expo iOS JS export succeeded to `/tmp/puuk-cdn-ios-coordinator-export`. Exact staged-source export also succeeded to `/tmp/puuk-cdn-ios-index-export` (Hermes bundle generated).
- `git diff --cached --check` passes after removal of test-fixture trailing whitespace.

## Build and release limits

`.github/workflows/build-ios-unsigned.yml` runs on push affecting iOS files, installs dependencies, applies the native patch, prebuilds and archives with Xcode on macos-26, then publishes an unsigned IPA. The user supplies this build route; no Apple credentials are needed in this chat. Record the resulting commit/run/artifact identity before device testing. Actual installation/signing and behavior on a device remain unverified.

Both `EXPO_PUBLIC_CDN_DELIVERY_ENABLED` and `EXPO_PUBLIC_SHARE_LINKS_ENABLED` remain off unless explicitly configured. No provider/server/CDN deployment occurred. Full native-header, background/lockscreen, long-file/pause/wake, offline, direct compatibility, live CDN Range/security and RF/EU acceptance remain open. Do not describe source/mock results as those proofs. Independent review remains required before enabling the integrated native change.
