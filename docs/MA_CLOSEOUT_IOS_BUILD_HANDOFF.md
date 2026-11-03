# I1H — candidate-to-GitHub Actions handoff proposal

**Prepared, not executed.** Owner will personally sign/install the resulting unsigned IPA. This task proposes only source staging and the existing Actions build; I1's original failed outcome is unchanged. An unsigned IPA for this exact candidate does not yet exist. I2/G3/G5 and all physical acceptance remain open.

## Exact approval scope

Proposed isolated build branch: `build/ios-ma-closeout-780589e84ec7` in `fishtries/puuk`, based on immutable commit `671be2ff8bf2d89a1bc11766d18f62b4faebe5a5`. Proposed commit title: `build(ios): freeze multi-artist candidate 780589e84ec7`. **No commit exists; actual commit SHA must be recorded after an authorized commit, never invented in advance.** No branch/commit/push/CI dispatch was performed.

Approval must explicitly cover: creating a separate checkout and that dedicated branch, committing exactly the40 listed iOS changes, pushing that ref/source to the existing repository, and allowing the existing workflow's automatic push build or one verified fallback workflow_dispatch. Existing workflow also uploads CI artifacts and **force-pushes `ci/puuk-ios-status`** with build status/log excerpts (`permissions: contents: write`); it serializes runs in concurrency group `build-ios-unsigned`. Approval must cover those known effects. This proposal contains no workflow/config/dependency upgrade, signing credentials change, backend deploy, data write, merge to main, tag/release, or user-channel publication. Common no-commit constraint stays in effect until that specific staging scope is approved; this document is not that approval.

The40 paths are the minimal delta needed to reproduce all136 frozen iOS inputs on the base commit:20 additions,20 modifications, no deletions, +7201/-133 text lines. They include31 feature paths and9 pre-feature dirty baseline paths already in the accepted candidate; do not omit those9 or stage unrelated dirty files. The remaining96 iOS inputs, package.json/package-lock.json/app.json/eas.json, and workflow are unchanged against HEAD. Changed-file scope is exactly `/tmp/puuk-ma-close/I1H/staging-paths.txt`, not a recursive `git add` of the shared checkout.

| Status | Exact path | Provenance |
|---|---|---|
| M | `app/ios/puuk-ios/App.js` | feature |
| M | `app/ios/puuk-ios/components/FullPlayerModal.js` | feature |
| M | `app/ios/puuk-ios/components/fullplayer/__tests__/FullPlayerControlsAndMenu.test.js` | preserved baseline |
| M | `app/ios/puuk-ios/components/fullplayer/playerStyles.js` | preserved baseline |
| M | `app/ios/puuk-ios/features/albums/AlbumEditScreen.js` | feature |
| M | `app/ios/puuk-ios/features/albums/AlbumScreen.js` | feature |
| M | `app/ios/puuk-ios/features/albums/__tests__/AlbumScreen.test.js` | preserved baseline |
| A | `app/ios/puuk-ios/features/artists/ArtistArtworkEditScreen.js` | preserved baseline |
| A | `app/ios/puuk-ios/features/artists/ArtistCreditBulkScreen.js` | feature |
| A | `app/ios/puuk-ios/features/artists/ArtistScreen.js` | feature |
| A | `app/ios/puuk-ios/features/artists/__tests__/ArtistArtworkEditScreen.test.js` | preserved baseline |
| A | `app/ios/puuk-ios/features/artists/__tests__/ArtistCreditBulkScreen.test.js` | feature |
| A | `app/ios/puuk-ios/features/artists/__tests__/ArtistScreen.test.js` | feature |
| M | `app/ios/puuk-ios/features/library/TrackEditScreen.js` | feature |
| A | `app/ios/puuk-ios/features/library/__tests__/CreditsDraft.test.js` | feature |
| M | `app/ios/puuk-ios/features/library/__tests__/TrackEditScreen.test.js` | feature |
| M | `app/ios/puuk-ios/features/search/SearchScreen.js` | preserved baseline |
| M | `app/ios/puuk-ios/features/search/__tests__/SearchScreen.test.js` | preserved baseline |
| M | `app/ios/puuk-ios/hooks/__tests__/usePlayerController.test.js` | feature |
| A | `app/ios/puuk-ios/hooks/__tests__/useSavedCreditsSync.test.js` | feature |
| M | `app/ios/puuk-ios/hooks/usePlayerController.js` | feature |
| A | `app/ios/puuk-ios/hooks/useSavedCreditsSync.js` | feature |
| M | `app/ios/puuk-ios/navigation/RootNavigator.js` | feature |
| M | `app/ios/puuk-ios/shared/api/__tests__/apiCache.test.js` | feature |
| A | `app/ios/puuk-ios/shared/api/__tests__/artistCredits.test.js` | feature |
| A | `app/ios/puuk-ios/shared/api/__tests__/artists.test.js` | feature |
| M | `app/ios/puuk-ios/shared/api/apiCache.js` | feature |
| A | `app/ios/puuk-ios/shared/api/artistCredits.js` | feature |
| A | `app/ios/puuk-ios/shared/api/artists.js` | feature |
| A | `app/ios/puuk-ios/shared/components/ArtistCreditsEditor.js` | feature |
| A | `app/ios/puuk-ios/shared/components/ArtistSelector.js` | feature |
| A | `app/ios/puuk-ios/shared/components/__tests__/ArtistCreditsEditor.test.js` | feature |
| A | `app/ios/puuk-ios/shared/components/__tests__/ArtistSelector.test.js` | feature |
| A | `app/ios/puuk-ios/shared/domain/__tests__/artistCredits.test.js` | feature |
| M | `app/ios/puuk-ios/shared/domain/__tests__/trackAdapter.test.js` | feature |
| A | `app/ios/puuk-ios/shared/domain/artistCreditEvents.js` | feature |
| A | `app/ios/puuk-ios/shared/domain/artistCredits.js` | feature |
| M | `app/ios/puuk-ios/shared/domain/trackAdapter.js` | feature |
| M | `app/ios/puuk-ios/shared/media/CoverImage.js` | preserved baseline |
| M | `app/ios/puuk-ios/shared/media/__tests__/coverImageUtils.test.js` | preserved baseline |

Full per-path before/after SHA256 and line counts: `candidate-delta.json`; reviewable text delta: `candidate-delta.diff`. Do not use that textual diff as a binary/source transport; use the verified archive and manifest. No source drift against I1 was found.

## Frozen source and build inputs

| Item | SHA256 / identity |
|---|---|
| I1 source archive,137 members (136 iOS + unchanged workflow) | `c462991e3ead0b771bc946914ba75c97961039c99008ac2bfc32fba7b6c702f4` |
| I1 source manifest / candidate ID | `780589e84ec7ccbe11aefd7411369ebfd99bb0d075bc171a86675f39a98c5e7a` / I1-780589e84ec7 |
| package-lock.json | `ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd` |
| unchanged workflow | `5a3d46dbd9425e2d956db769db49a09632139a6f1c6a168b038fafa6206d28d6` |
| staging-paths.txt | `82b755cc9852f5da3262d1f60a6449a743a73e4849954e7d0814caa218a46e8e` |
| candidate-delta.json | `7701635fa20af640edfb5b8ecb9df54711dd27e107e10af0da8f8c777cd8515a` |

Archive/manifest live under `/tmp/puuk-ma-close/task_a292bf0da3dd/`; current handoff receipts under `/tmp/puuk-ma-close/I1H/`. Freeze these exact bytes; later changes require a new manifest/delta and affected checks. Archive excludes original audio, env/secrets/signing files, node_modules/Pods, generated ignored ios/android trees, build output and stale dist. The listed40 paths add no secrets or build configuration. Workflow regenerates native iOS from package lock and the existing three postinstall patches; do not copy old ignored native files.

Native spec: `app/ios/puuk-ios`, macos-26/Node22, npm ci, existing patches for expo-audio/react-native-menu/expo-symbols, Expo prebuild, pod install, Release/Puuk/iphoneos archive with signing disabled. Config identity is `com.fishtries.puuk`, version1.0.0/build1; inspect actual IPA plist after build. It is the existing GitHub unsigned workflow, not EAS production/preview. Native toolchain/Pods lock and actual native output remain unproven until that build. I1's six Expo patch-version recommendations remain advisory diagnostics, not demonstrated incompatibility; preserve lock/config here.

## Proposed commands — NOT EXECUTED, approval required

Use a fresh separate checkout so the shared dirty baseline/index remain untouched. The following deliberately creates a commit/ref, and must not run under the current no-commit scope. Commands use existing local artifact paths; if executing on another host, transfer and verify those exact artifacts first. Fail if the proposed target directory or branch already exists; do not reset/clean/overwrite an existing checkout.

```bash
set -euo pipefail
cd /tmp
# NEW checkout only; do not reuse the shared repository for staging.
git clone https://github.com/fishtries/puuk.git puuk-ios-actions-780589e84ec7
cd /tmp/puuk-ios-actions-780589e84ec7
git switch -c build/ios-ma-closeout-780589e84ec7 671be2ff8bf2d89a1bc11766d18f62b4faebe5a5
python - <<'VERIFY_ARCHIVE'
from pathlib import Path
import hashlib, json, tarfile
root = Path('/tmp/puuk-ma-close/task_a292bf0da3dd')
archive = root / 'candidate-source.tar'
manifest = root / 'candidate-manifest.json'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == 'c462991e3ead0b771bc946914ba75c97961039c99008ac2bfc32fba7b6c702f4'
assert hashlib.sha256(manifest.read_bytes()).hexdigest() == '780589e84ec7ccbe11aefd7411369ebfd99bb0d075bc171a86675f39a98c5e7a'
with tarfile.open(archive) as source:
    source.extractall('.', filter='data')
for item in json.loads(manifest.read_text())['files']:
    assert hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() == item['sha256'], item['path']
assert hashlib.sha256(Path('.github/workflows/build-ios-unsigned.yml').read_bytes()).hexdigest() == '5a3d46dbd9425e2d956db769db49a09632139a6f1c6a168b038fafa6206d28d6'
VERIFY_ARCHIVE
# Explicitly stage only reviewed delta; never git add -A / git add .
git add --pathspec-from-file=/tmp/puuk-ma-close/I1H/staging-paths.txt
git diff --cached --name-only --no-renames | cmp - /tmp/puuk-ma-close/I1H/staging-paths.txt
git diff --cached --stat
git diff --cached --check
git diff --exit-code  # no unstaged changes in the fresh checkout
git commit -m 'build(ios): freeze multi-artist candidate 780589e84ec7'
PUUK_CANDIDATE_COMMIT=$(git rev-parse HEAD)
printf '%s
' "$PUUK_CANDIDATE_COMMIT"
git push origin HEAD:refs/heads/build/ios-ma-closeout-780589e84ec7
# This push already triggers the existing workflow. Inspect exact commit/ref first.
gh run list --repo fishtries/puuk --workflow build-ios-unsigned.yml \
  --branch build/ios-ma-closeout-780589e84ec7 --commit "$PUUK_CANDIDATE_COMMIT" \
  --json databaseId,headSha,headBranch,event,status,conclusion,url
```

Record allocated commit SHA, staged-path equality,136 source hashes, immutable remote head and run ID before accepting any build. Current main is historical HEAD without dirty candidate changes: **dispatching main would rebuild the wrong code**. Do not merge this branch to main as part of the proposal.

Manual fallback **NOT EXECUTED**: only after the operator/coordinator confirms no matching automatic push run was created (including queued/in-progress runs), use [Run workflow](https://github.com/fishtries/puuk/actions/workflows/build-ios-unsigned.yml) and choose `build/ios-ma-closeout-780589e84ec7`, or:

```bash
gh workflow run build-ios-unsigned.yml --repo fishtries/puuk \
  --ref build/ios-ma-closeout-780589e84ec7
```

Do not immediately dispatch merely because the first list query was empty; reconcile Actions event/run creation first. Retain one intended build/run receipt for the exact immutable commit. Repo/ref access is not established by public workflow metadata.

## Exact unsigned artifact receipt

Collect actual run ID/URL, event, head branch and immutable head_sha matching the allocated candidate commit; workflow ID370336007/path/hash, start/end/outcome and full environment/native build logs; artifact name `puuk-ios-unsigned-ipa`, actual artifact ID/size/archive digest/download time; inner `Puuk-unsigned.ipa` size/SHA256 plus matching uploaded `Puuk-unsigned.ipa.sha256`; actual plist bundle ID/version/build and executable hash from IPA. Save separately artifact `puuk-ios-build-log`/archive.log and its SHA256. Use actual build-host macOS/Xcode/SDK/Swift/Node/npm/Pod versions from logs; Podfile.lock/native generated hashes require a build-host receipt if available and must not be invented when the existing workflow does not upload them. Package lock is pinned already. The current workflow retains artifacts7 days; retrieve promptly and preserve raw receipts privately without secrets.

After setting PUUK_IOS_RUN_ID to the actual verified run ID and PUUK_IOS_RECEIPT_DIR to a new local receipt directory, proposed read/download commands (NOT EXECUTED) are:

```bash
gh run view "$PUUK_IOS_RUN_ID" --repo fishtries/puuk \
  --json databaseId,headSha,headBranch,event,status,conclusion,url,startedAt,updatedAt
gh run view "$PUUK_IOS_RUN_ID" --repo fishtries/puuk --log > "$PUUK_IOS_RECEIPT_DIR/run.log"
gh api "repos/fishtries/puuk/actions/runs/$PUUK_IOS_RUN_ID/artifacts" > "$PUUK_IOS_RECEIPT_DIR/artifacts.json"
gh run download "$PUUK_IOS_RUN_ID" --repo fishtries/puuk \
  --name puuk-ios-unsigned-ipa --dir "$PUUK_IOS_RECEIPT_DIR/ipa"
cd "$PUUK_IOS_RECEIPT_DIR/ipa"
sha256sum -c Puuk-unsigned.ipa.sha256
sha256sum Puuk-unsigned.ipa
```

Artifact archive digest is not the inner IPA SHA256. Preserve unsigned IPA as received and hand it to the owner; owner signing produces a different signed artifact/hash. Record that signed hash, resulting identity/build, device model/iOS and actual install/launch evidence separately. Owner signing/install commitment does not prove execution. No App Store/TestFlight/OTA/user-channel publication is requested here.

## Evidence and limits

**Passed current I1H:** frozen source/archive verification, exact HEAD delta40/136 and unchanged workflow; historical I1 report recovered byte-identically after it was absent on entry (original SHA11a11d7fa5e313e093d0684495aa5b02dbe052c053c44843bd2813d63d872e5f). Check cwd `/home/fish/projects/puuk`; command/time/exit details in candidate-delta.json, git-head.json, git-status-before.json, original-report-recovery.json and final-verification.json. Source version is base HEAD plus pinned manifest; original dirty baseline is retained.

**Auth limitation, current I1H:** read-only `gh run list --repo fishtries/puuk --limit 1 --json databaseId,headSha,status,conclusion` exits4, requiring existing owner authentication. No account/settings change or credential output occurred. Public REST workflow metadata from I1 confirms unsigned workflow only, not authenticated dispatch/download permission. No alternate authenticated connector was available in I1; no credentials were read to find one.

**Reused evidence, not rerun:** matching JD608 tests/50 suites, I1 Hermes export1685 modules/38 files and isolated prebuild23 native files passed; six advisory Expo patch recommendations recorded in I1; C0 backend schema12/read compatibility/source match. No tests, prebuild, export, installs or source changes were executed by I1H.

**Not executed / not tested:** source staging branch/commit/push/Actions dispatch, native unsigned build/download, owner signing/install, device playback/position/queue/background/lock controls, 0/1/N navigation/cancel, conflict/draft preservation, VoiceOver/large text/long names and5000-preview performance. Source archive is ready; unsigned IPA is NOT BUILT; signed/installed app is NOT TESTED. I1 remains failed and I2/G3/G5 open.

Authority: I1H Task `task_b53331f49fe6`, Dispatch `ctx_0567077fb981`, Run `run_ea37b46b2dc1`, existing terminal reuse. launch.requested/effective are equal all-null records (not a new model launch); live provider/model projection and terminal preview confirm Codex gpt-6.1-sol high. Used previously loaded installed Orca guides and current root/iOS instructions, frozen contract and updated Run journal. No delegation, retry of I1, lifecycle fabrication, source/config edit, original audio/production write or secret/account manipulation.
