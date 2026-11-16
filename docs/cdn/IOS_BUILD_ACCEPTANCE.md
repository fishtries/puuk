# iOS build evidence — 2026-11-16

GitHub Actions run50 for commit bb050d937a63e0c61f6abbeade385f860f8c930b
completed successfully:
[Build unsigned iOS IPA](https://github.com/fishtries/puuk/actions/runs/43842168281).
It started09:42:33UTC and completed10:00:25UTC. The workflow installs dependencies,
applies the native audio patch, prebuilds and archives for a generic iOS device.
This confirms compilation of the committed native intent guard in the CI build.

The API reports these unexpired artifacts:

| Artifact | ID | ZIP bytes | ZIP SHA-256 |
|---|---|---:|---|
| puuk-ios-unsigned-ipa |14213239748|13294105|3d38d1978358d8ed491f0c5600acb4cbedc4f3547e4f0a0b4d402e9e3c2b933a|
| puuk-ios-build-log |14215315279|591969|d370b8ddfcdbc89da13339c8a67b17914f3547cda05e4a617a661feca18d22b0|

These are GitHub artifact archive digests, not an independently downloaded IPA
file hash or installed-device identity. The source build capabilities default
false; the workflow supplies no CDN/share override. The earlier frozen source
snapshot passed620 tests in13 suites and an Expo export; unrelated later dirty
iOS edits were excluded from that commit.

A successful unsigned archive does not establish signing, installation, physical
device playback, request-header capture, background/lock-screen behavior, expiry
recovery, offline transfer races or geographic performance. Those gates remain
open; no signed-device acceptance or user rollout is claimed.

## CDN-capable candidate

Commit75c230220935dca41d2b69ff18b39a95e5fea9d6 explicitly supplies
EXPO_PUBLIC_CDN_DELIVERY_ENABLED=true to the iOS build job. Run
[43868581365](https://github.com/fishtries/puuk/actions/runs/43868581365)
succeeded on2026-11-16 at12:56UTC (15:56 Moscow). Install this candidate for CDN
acceptance; the earlier13:00 Moscow IPA keeps its compiled capability false.
The server pilot gate remains separate and currently OFF. No physical-device
acceptance is inferred from the CI result.
