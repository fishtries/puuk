# Source candidate build/install handoff (instructions, not executed)

Final frozen source candidate: `sha256:798418c223c9836646ecba3fb4d0bde370bd42d4bd717d399c0a45c204239312` (163 app files, 16 expected native Swift files). Full host verification passed 59 suites / 931 tests, explicit product/test lint, syntax, selected formatting and Hermes export; none of these compile Swift or identify an installed binary. Export is `export-FINAL-ctx-fef7/`, pinned separately in `export-manifest.json`. Package-lock SHA-256 is `ce053ceebfa85250e4a0008e9f8508faa71624fe2375674fd00b587b96d75bcd`.

Keep `verify-candidate.py`, both candidate manifests and these instructions together on the authorized builder. Before dependency installation, run `python3 /path/to/S2/verify-candidate.py --app /path/to/isolated/puuk-ios`; after `npm ci`, rerun with `--with-native`. This read-only verifier checks all source files and, with that option, all 16 expected installed Swift files. Actual binary identity remains **unknown** until compiled and recorded separately.

The adjacent `candidate-manifest.json` identifies source bytes, not a compiled or installed iOS binary. `candidate-source/` contains the reviewed app source, tests, assets, lockfile and native producer. `candidate-native/` is the reviewed expected installed Swift output. Do not substitute a checkout of HEAD: this candidate includes uncommitted changes. No Mac, Xcode, signing identity, cloud builder or usable phone was available in S2.

On an authorized Mac with Xcode and a signing setup, work in a fresh directory copied from `candidate-source/app/ios/puuk-ios/`, preserving these exact bytes. Verify each relative path against the manifest before dependency installation. Do not copy a production .env or signing credentials into the review artifacts. Use existing approved configuration through its normal secure mechanism if required for a real build.

1. Install the lockfile with `npm ci` in that isolated app copy. The checked postinstall runs `scripts/patch-expo-audio.js`, the menu patch and the symbols patch. Stop on any source-drift rejection; do not remove pin validation or upgrade SDK dependencies. Re-run `node scripts/patch-expo-audio.js` to confirm verified idempotence and compare all 16 expected installed Audio Swift files (including the five patched targets) to `candidate-native-manifest.json`. Recheck lockfile and app source hashes.
2. Run `npm test -- --runInBand`, then the lint argv recorded in S2 `commands.jsonl`, adapting only the temporary config's absolute app root. Export with `npx expo export --platform ios --output-dir <fresh-temporary-directory>`. Any intentional configuration/source change creates a new candidate and requires a new manifest; passing the old candidate does not cover it.
3. Run `npx expo run:ios --device` in the isolated copy with the authorized connected device and signing configuration. This generates/builds the native iOS project and installs it; neither action was executed by S2. Record Xcode/SDK versions, actual native build command/result, app bundle hash, Mach-O/dSYM UUID, bundle identifier, CFBundleShortVersionString and CFBundleVersion. Configured version 1.0.0 / build 1 alone is not unique build provenance. Do not use an Expo Go or older development binary as proof of the custom native patch.
4. Record the actual installed device/iOS/build identity and verify the runtime player exposes `puukSourceIdentityVersion === 1` and all three synchronous boolean methods (`replaceWithAttempt`, `playForAttempt`, `seekForAttempt`). Verify attributed events from actual selections, rather than inferring capability from node_modules. Old binaries must continue legacy playback with `identityAvailable:false` and no attributed automatic recovery.
5. Execute J09's full matrix on that identified binary. Observe audible output separately from progress. Include FIFO installation error before initial play admission, user/remote pause/seek during async recovery, two overlapping system interruptions with stale end completions, lifecycle/route/no-resume veto, duck-volume restoration, reset/false seek completion and rapid A/B/A. Exercise background transitions with success, item failure, pre-install JS failure, previous-to-zero, cancel/release and expiration. Record bounded completion/thread diagnostics and actual task identifiers/count without playback URLs, tokens or raw native errors.

No cloud submission, signing-profile change, production deployment, provider configuration, service restart or package update is authorized or implied by these instructions. Gate B/native/device/sound acceptance stays open until the missing evidence exists on a matching candidate.

## Durable handoff if temporary artifacts are unavailable

The repository copies are `docs/IOS_PLAYBACK_CANDIDATE_MANIFEST.json`, `docs/IOS_PLAYBACK_NATIVE_MANIFEST.json` and this document as `docs/IOS_PLAYBACK_BUILD_INSTALL.md`. Their manifest contents are identical to the temporary candidate manifests. If `candidate-source/` is unavailable, copy the current workspace app only after verifying every path against the durable source manifest; a checkout of HEAD alone is insufficient. A mismatch requires recovering the exact reviewed files or identifying/reviewing a new candidate, not changing the expected hash.

If `verify-candidate.py` is unavailable, the following self-contained check can be saved as `verify-playback.py` outside the app. Run `python3 verify-playback.py /path/to/IOS_PLAYBACK_CANDIDATE_MANIFEST.json /path/to/IOS_PLAYBACK_NATIVE_MANIFEST.json /path/to/isolated/puuk-ios` before installation; append `--with-native` after `npm ci`. It only reads files and hashes; it never prints file contents, credentials or device identifiers.

```python
import hashlib, json, sys
from pathlib import Path

source_manifest, native_manifest, app_dir = map(Path, sys.argv[1:4])
source = json.loads(source_manifest.read_text())
app = Path(app_dir)
prefix = "app/ios/puuk-ios/"
expected = {}
for relative, digest in source["files"].items():
    assert relative.startswith(prefix), "Unexpected manifest path"
    expected[app / relative[len(prefix):]] = digest
if "--with-native" in sys.argv[4:]:
    for relative, digest in json.loads(native_manifest.read_text()).items():
        expected[app / "node_modules/expo-audio/ios" / relative] = digest
for path, digest in expected.items():
    assert path.is_file(), f"Missing file: {path}"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, f"Mismatch: {path}"
print(source["sourceCandidateId"], "verified", len(expected), "files")
```

Source verification is not a native compiler, runtime-capability, installed-build or audible-output check. Follow the build identity and J09 steps above on the authorized Mac and physical iPhone even when every hash matches.
