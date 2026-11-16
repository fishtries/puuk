# S0 — execution and environment baseline

Date: 2026-11-16 UTC. Task `task_f0ed0d7c8e0c`, Dispatch `ctx_28c682d6f930`. Audit in the shared checkout `/home/fish/projects/puuk`; role: senior Codex, requested model `gpt-6.1-sol`, effort `high`.

**S0 read-only audit completed; production delivery, device acceptance and geographic acceptance remain unverified. No production configuration, process, database record, audio file, provider setting, DNS record or deployment was changed.** Only this report was written by S0. No tests, builds, package installation, commit, push, reset, stash, deployment, paid operation or helper agent were run.

## 1. Instructions, ownership and preservation

Read root `AGENTS.md`, `brain/AGENTS.md`, `app/ios/puuk-ios/AGENTS.md`, the complete `docs/CDN_AND_SHARE_LINKS_ORCHESTRATION_PLAN.md`, `docs/AGENT_ORCHESTRATION.md`, `docs/DEPLOYMENT.md`, both deployment scripts, and the current Orca orchestration/CLI guides. No web-specific AGENTS.md was found by `rg --files -g AGENTS.md`.

The only write allowance for this task is `docs/cdn/S0_BASELINE.md`. J1 owns provider investigation; J2 owns the exhaustive code map. Their work is concurrent and must not be overwritten. All existing tracked and untracked changes are preserved; do not treat them as CDN implementation or include them in a broad deployment/commit. Audio originals must never be edited. Python tests must use an explicitly isolated `PUUK_DB_PATH` before importing project modules; do not rely solely on an assumption that every test imports the isolation helper correctly.

Direct user steering during this audit was exactly `запусти в agy gemini`. S0 asked the coordinator to resolve its scope rather than silently transfer a senior task. The coordinator first confirmed J1/J2 on OpenCode, then explicitly corrected that interpretation: the user wanted the **native Antigravity launcher**, and instructed S0 to continue as senior Codex without subdelegation while the coordinator corrects J1/J2. S0 launched no agents and made no claim that OpenCode is native Antigravity.

## 2. Git and dirty inventory

Commands: `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, `git diff --stat`, `git diff --numstat`, and SHA-256 of each path in `docs/cdn/BASELINE_MANIFEST.json` using Python standard-library `hashlib` without importing project code.

- Branch: `main`.
- HEAD: `89ebc1c30b36837e584fbe72d51cdb0aed6303be`, matching the dispatch baseline.
- Baseline manifest captured at `2026-11-16T00:55:35.639938+00:00`; SHA-256: `53d17c407c829c3c12fb41a8bfe18b37b591ba6c0dfe6ca29b40a90760591af8`.
- **All 20 inventoried baseline files matched their manifest SHA-256.** There were 18 tracked modified files and two untracked baseline documents; `docs/cdn/` was additionally untracked and initially contained the manifest.
- Tracked worktree diff: 18 files, 279 insertions, 77 deletions. SHA-256 of `git diff --binary`: `b6032e867e2e2771a6b3ec266a108eb986f846646b002e8574aa9223c2727b8d`.
- Index diff was empty: `git diff --cached --binary` had zero bytes, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Inventory below retains exact paths; the linked manifest is the authoritative per-file hash list.

| Baseline paths | Status / hash comparison |
|---|---|
| `app/ios/puuk-ios/App.js` | modified / MATCH |
| `app/ios/puuk-ios/components/FullPlayerModal.js` | modified / MATCH |
| `app/ios/puuk-ios/components/fullplayer/PlayerHeader.js` | modified / MATCH |
| `app/ios/puuk-ios/components/fullplayer/__tests__/FullPlayerControlsAndMenu.test.js` | modified / MATCH |
| `app/ios/puuk-ios/hooks/__tests__/usePlayerController.test.js` | modified / MATCH |
| `app/ios/puuk-ios/hooks/usePlayerController.js` | modified / MATCH |
| `app/ios/puuk-ios/shared/components/ArtistSelector.js` | modified / MATCH |
| `app/ios/puuk-ios/shared/components/__tests__/ArtistSelector.test.js` | modified / MATCH |
| `brain/routers/wave_recommendations.py` | modified / MATCH |
| `brain/services/recommendation_service.py` | modified / MATCH |
| `brain/test_multi_artist_integration.py` | modified / MATCH |
| `docs/AGENT_ORCHESTRATION.md` | modified / MATCH |
| `docs/design/DESIGN.md` | modified / MATCH |
| `docs/design/ios.md` | modified / MATCH |
| `tg_music_bot/bot.py` | modified / MATCH |
| `tg_music_bot/downloader.py` | modified / MATCH |
| `tg_music_bot/source_worker.py` | modified / MATCH |
| `tg_music_bot/test_source_selection.py` | modified / MATCH |
| `docs/CDN_AND_SHARE_LINKS_ORCHESTRATION_PLAN.md` | untracked / MATCH |
| `docs/TASTE_SERVER_TEST_REPORT.md` | untracked / MATCH |

Preservation check is repeatable without checkout mutations:

```sh
python - <<'PY'
import hashlib, json, pathlib
m = json.loads(pathlib.Path('docs/cdn/BASELINE_MANIFEST.json').read_text())
for f in m['files']:
    p = pathlib.Path(f['path'])
    actual = hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else 'MISSING'
    print('MATCH' if actual == f['sha256'] else 'DIFFERENT', f['path'])
PY
```

## 3. Actual services and architecture

Read-only SSH succeeded with `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -p 59348 fish@192.168.1.117 '<read-only command>'`. No host key was accepted interactively. Remote host identifies as `fish-deb-server`, Linux `6.12.116+deb13-amd64`; local host is Linux `7.2.11-arch1-1 x86_64`.

`systemctl is-active puuk-brain puuk-telegram-bot nginx` returned `active` for all three. `systemctl --user is-active puuk-brain puuk-telegram-bot` returned `inactive` for both. `systemctl show ... -p FragmentPath -p User -p WorkingDirectory -p ActiveState -p MainPID` and sanitized reads of their unit files established:

| Service | Current source / execution |
|---|---|
| Backend | System unit `/etc/systemd/system/puuk-brain.service`, user `fish`, working directory `/home/fish/apps/puuk/puuk/brain`, `venv/bin/uvicorn api:app --host 127.0.0.1 --port 8000`, `Restart=on-failure` |
| Telegram bot | System unit `/etc/systemd/system/puuk-telegram-bot.service`, user `fish`, working directory `/home/fish/apps/puuk/puuk/tg_music_bot`, `venv/bin/python bot.py`, `Restart=always`, EnvironmentFile in that directory |
| nginx | Active system unit `/usr/lib/systemd/system/nginx.service`; serves HTTPS web and proxies API |
| SQLite | Read-only URI `file:/home/fish/apps/puuk/puuk/brain/puuk.db?mode=ro` plus `PRAGMA query_only=ON`: journal mode `wal`, 1,734 tracks at sampling time |
| Qdrant | `ss -lnt` shows ports 6333/6334 listening on all IPv4 interfaces; server-local GET `http://127.0.0.1:6333/healthz` returned 200 text/plain |
| Heavy worker | Repository/deployment instructions place `brain/heavy_worker.py` on the development host over SFTP; its current execution was not established or started |

`ss -lnt` confirms backend bound to **127.0.0.1:8000**, nginx on 80/443, SSH on 59348. Therefore `192.168.1.117:59348` is the SSH endpoint, not a single HTTP port shared by all services. Local direct `http://192.168.1.117:8000/` failed with curl exit 7. This is consistent with the loopback bind, not evidence that the backend is down. Local `brain/api.py`'s standalone `uvicorn.run` uses `0.0.0.0`, but the active system unit's explicit bind governs production.

Deployed `brain/api.py` SHA-256 `a279547a214ad4e713ae7818fb380e869a8c49de147eee2f07412ad74ef53bc7` and `brain/routers/streaming.py` SHA-256 `6382aae1a9ebaee0ed00bc597832a3809e6787b89773e38cde534a9b2d688a87` each match local bytes. This compares only those files; it does not establish a complete deployed revision.

`docs/DEPLOYMENT.md` is stale about missing units and stdout-only logging: system units now exist and are active. Do not follow its `/api/health` example as a readiness contract. S0 did **not** request `/api/health`; authenticated catalog denial and actual service status were used instead. No API startup or scanner was imported/executed.

## 4. Public probes and nginx boundaries

DNS via `socket.getaddrinfo` / `getent hosts`: `web.puuk.fun` resolved to `128.69.178.203`; `media.puuk.fun` resolved to `188.72.112.1` with canonical name `a77ec7546eec5094.topology.gslb.yccdn.ru`. `getent hosts _acme-challenge.media.puuk.fun` returned exit 2; getent is not a CNAME inspection tool, so this **does not disprove** the validation CNAME. NS/validation records remain J1 evidence.

GET probes used curl with `--silent --show-error --connect-timeout 4 --max-time 8 --output /dev/null --dump-header - --write-out 'RESULT status=%{http_code} ssl_verify=%{ssl_verify_result} ttfb=%{time_starttransfer} total=%{time_total}\n'`, without cookies or authorization. One sample per row below; timings are diagnostic, not performance acceptance.

| URL / vantage | Result | TTFB / total seconds |
|---|---|---|
| `https://web.puuk.fun/`, local | 200 HTML, TLS verification 0 | 0.016877 / 0.016915 |
| `https://media.puuk.fun/`, local | 200 HTML, TLS verification 0 | 0.187047 / 0.187089 |
| `https://web.puuk.fun/api/tracks?limit=1`, local | 401 JSON, TLS verification 0 | 0.021055 / 0.021078 |
| `http://127.0.0.1:8000/api/tracks?limit=1`, server-local | 401 JSON | not timed |
| `https://media.puuk.fun/api/tracks?limit=1`, local | 401 JSON, `Cache-Host: yccdn-m9-12` | not timed |
| `https://media.puuk.fun/track/5bb9c7a4-ffc5-50ef-9594-d30cf3eb0adc`, local | 200 HTML, `Cache-Host: yccdn-m9-15` | not timed |
| Both web AASA paths, local | 200 HTML, not AASA JSON | about 0.021 / 0.021 |

The last media probes show that the media hostname currently exposes responses beyond an audio-only prefix. The API still required authorization for the tested catalog route; there is **no claim of unauthenticated catalog disclosure**. A media root 200 and node header do not prove audio caching, secure-token enforcement or warm-cache authorization.

Read `/etc/nginx/nginx.conf`, enabled site files and the complete Puuk vhost, printing no secret header values. Disk Puuk vhost hash: `f4057ca4d1fa450f97184e1b4e8f3ffd0c5479ae9001dcbdd561a28546919716`.

- Puuk vhost: `/etc/nginx/sites-enabled/puuk-web`; server_name `web.puuk.fun`, root `/var/www/puuk-web`, TLS certificate paths under `/etc/letsencrypt/live/web.puuk.fun/`.
- `/api/` proxies to `http://127.0.0.1:8000`, forwards Host `$host` and X-Forwarded-Proto `$scheme`, disables response/request buffering, has read/send timeouts 600 seconds and connect timeout 60 seconds.
- SPA fallback: `try_files $uri $uri/ /index.html`. ACME exception `/.well-known/acme-challenge/`. Static extension regex sets one-year public immutable caching. `client_max_body_size 25m`.
- Port 80 redirects the web host to HTTPS. No dedicated media vhost, `/cdn/audio/` proxy, origin-secret check or AASA location was present in the inspected enabled-site files.
- The same nginx instance serves other sites/services. Future changes must be scoped to the reviewed Puuk server/location; do not replace global config, touch unrelated vhosts or alter certificate validation routes. Backend route additions alone will not make `/cdn/...` reach FastAPI through the present `/api/`-only proxy.
- Config files are root-owned mode 0644. `sudo -n -l` returned `sudo: a password is required`, exit 1. S0 could read disk config but cannot assert passwordless privilege for nginx writes/reloads, cert access, or system-service restarts. No `nginx -T`, config test or reload was run; disk config plus live HTTP probes do not prove every loaded directive is identical to disk.

## 5. Deployment mechanism and secure configuration

Root `deploy.sh` delegates to `brain/deploy.sh`. Inspected script hash: `9625f8adde07e38c880d586c02ed980e3a4351729f70e5a2a4cd5df0b97f758a`.

- Default SSH target/user/port: `fish@192.168.1.117:59348`; remote backend directory `/home/fish/apps/puuk/puuk/brain/`.
- Normal execution rsyncs the **whole brain directory and Telegram bot**, then attempts `systemctl restart puuk-brain` / `puuk-telegram-bot`, falling back to `pkill -9` patterns. It is not an allowlisted CDN deployment and can include unrelated dirty work. A restart command ending in `|| true` is not proof of successful restart.
- `--dry-run` adds rsync `-n` and skips restart/install paths in the inspected script; `--delete` is opt-in; `--install` updates dependencies when not dry-run. None of these commands was executed during S0.
- Brain exclusions cover venv, temporary audio, Python caches, log files and database/journal/WAL/SHM files, but do **not** generally exclude `.env` or arbitrary key files. Bot sync excludes `.env` and `state/` but uses its own smaller exclusion list. Do not assume the script is a safe secret filter.
- This script does not deploy the web root or iOS, configure nginx/CDN, preserve reviewed backups, or establish a complete rollback revision. Later release needs an exact reviewed file manifest, narrow transfer, known process-control authority, off-by-default compatibility smoke, and explicit web/native build identity. Never deploy the current shared dirty tree wholesale.

Secure-config inspection emitted **names/presence/permissions only**, never values. The active backend process environment contains `JWT_SECRET`, `QDRANT_URL`, `MUSIC_DIR`; the system unit declares `JWT_SECRET` inline (alongside nonsecret keys), and is root-owned **0644**. This is not a protected-file storage pattern: later infrastructure work must arrange a restricted secret store/EnvironmentFile without disclosing values or silently rotating JWT. Backend `.env` is absent. Bot `.env` exists and is **0644**, keys `BOT_TOKEN,ALLOWED_USERS,MUSIC_DIR`; permissions are a finding, unchanged by S0. No CDN secret keys were observed in the backend environment or local relevant environment-key inventory; provider-console secret state was not inspected by S0.

New signing/origin secrets require distinct values, restricted storage/injection and redacted handling; they must not enter client config, source control, commands, query logs or this report. No secret was retrieved for testing. Existing iOS API source uses expo-secure-store with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`; that client storage capability does not provision server/CDN secrets.

Provider tools/account: `command -v` found no local or server `yc`, Terraform/OpenTofu or EAS CLI. Local `~/.config/yandex-cloud/config.yaml` and Yandex/Terraform config directories were absent. No `EXPO*`, `EAS*`, `YC_*`, `YANDEX*`, `AWS_*`, `APPLE*` or `ASC_*` environment keys were present. No provider account, IAM capability, spending authority, token rotation/purge permission or console session was verified by S0. Browser/console verification belongs to J1; absence of local CLI credentials does not disprove a logged-in native browser session. No provider installation or login was attempted.

## 6. iOS SDK, playback and build capability

Before any implementation, opened the exact [Expo SDK 58 reference](https://docs.expo.dev/versions/v58.0.0/), [SDK 58 Audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/), [SDK 58 FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/) and [SDK 58 app configuration](https://docs.expo.dev/versions/v58.0.0/config/app/), plus the [Expo Universal Links guide](https://docs.expo.dev/linking/ios-universal-links/). No iOS code was written. SDK documentation is versioned, but its recommended patch can differ from installed bytes: Audio docs recommended `~58.0.12`; the project actually uses **58.0.10**.

Local installed `node_modules/*/package.json`, not just declared ranges:

| Package | Installed |
|---|---|
| expo | 58.0.19 |
| expo-audio | 58.0.10 |
| react-native | 0.88.0 |
| expo-file-system | 58.0.11 |
| expo-secure-store | 58.0.2 |
| jest-expo | 58.0.12 |

Playback entrypoint is `hooks/usePlayerController.js` using `useAudioPlayer(null, {updateInterval:100, keepAudioSessionActive:true})`, with the existing `PlaybackCoordinator`, `PreloadScheduler` and `AudioCache`; `App.js` delegates to the hook. Audio mode sets silent/background playback and `doNotMix`. Source resolution passes through synchronous `normalizeStreamUrl` in `utils/streamUrl.js`; `preloadScheduler.js` invokes its configured synchronous `getStreamUrl`. Preserve these boundaries explicitly when adding asynchronous tickets; do not silently return a Promise from the current URL helper.

The SDK 58 docs and installed `AudioModule.types.ts` agree that public `replace(AudioSource)` returns void and `seekTo(...)` returns `Promise<void>`. AudioSource supports URI plus HTTP headers. Installed `ios/AudioUtils.swift` sets `AVURLAssetHTTPHeaderFieldsKey` from source headers. The project postinstall patches expo-audio with custom source identity/attempt APIs: installed `AudioPlayer.swift` contains `replaceWithAttempt`, and coordinator uses it. Native preload is explicitly disabled in the coordinator comment; scheduler/cache supplies local file URIs instead. Native header forwarding across redirects/new origins, source refresh, background/seek and identity APIs must be checked on a rebuilt binary; these source facts alone do not prove their runtime safety.

Local build/device facts:

- Linux host; Node `v26.12.0`, npm `12.2.1`. No `xcodebuild`, `xcrun`, EAS CLI, or project `.bin/eas`; no Mac builder marker in the one local SSH Host declaration. This does not disprove an external Mac owned by the user.
- Generated `ios/` exists, but `ios/Pods` is absent. No new IPA/archive/build was produced. App config version `1.0.0`, build number `1`, bundle `com.fishtries.puuk`; these are source settings, **not** an identified installed build.
- `idevice_id` and `ideviceinfo` exist; `idevice_id -l` returned exit **255**, `ERROR: Unable to retrieve device list!`, zero output devices. `systemctl is-active usbmuxd` returned `inactive`; `.expo/devices.json` has zero cached devices. This is unavailable enumeration, not proof that no physical iPhone exists anywhere. No daemon was started or device pairing attempted.
- `~/.expo/state.json` exists and has a nonempty auth object; no identity or token was printed and server validity/permissions were not tested. `credentials.json` and project `.env` absent. EAS account/project/Apple team signing access remains unknown.
- `eas.json` development and preview profiles target **simulator**; production has autoIncrement but no established signing identity or EAS project ID. Simulator profiles cannot substitute for physical-device acceptance.
- Existing `.github/workflows/build-ios-unsigned.yml` uses `macos-26`, npm ci, native patches, Expo prebuild, CocoaPods and xcodebuild archive with signing disabled; packages unsigned IPA. It has `contents: write` and a status step that force-pushes `ci/puuk-ios-status`. Source configuration is a possible future unsigned-build route, not proven current build access. Local `gh api user --jq 'has("login")'` returned exit **4**, no authenticated user. No workflow was triggered, source pushed or CI status branch touched. An unsigned IPA still requires owner-controlled signing/install.

Universal Links capability: **not currently configured and not ready for acceptance**. App config has only scheme `puuk`, no `ios.associatedDomains` or `appleTeamId`; generated `Puuk.entitlements` has an empty dict; project pbxproj contains no DEVELOPMENT_TEAM. Both `https://web.puuk.fun/.well-known/apple-app-site-association` and `/apple-app-site-association` returned the same 709-byte HTML as `/`, SHA-256 `1c72821db6709841c3b85f28dd699027b9b8f1d0c644b52fbc68f37a5d7ed0e0`, not JSON. Both corresponding files are absent under `/var/www/puuk-web`. Hosting is technically possible through the existing web/nginx infrastructure, but requires privileged deployment plus Apple Team ID, Associated Domains entitlement/provisioning and signed build. Under the plan, release outgoing HTTPS links and working web routing separately; treat Universal Links as a separate blocked stage until those capabilities are supplied. `puuk://` is not evidence for HTTPS Universal Links.

## 7. Existing checks, auth and bounded test candidates

`git ls-files` filtered by component/pattern counted **50** tracked `brain/test_*.py` modules (including `test_db_path.py` helper), **70** tracked iOS `*.test.js` files and **9** web `*.test.ts` files. These are file inventory counts, not executed/passing test counts.

- Backend relevant suites: `test_media_ticket.py` (Bearer/ticket auth, track binding, tampering/expiry, Range start/middle/open-ended/invalid, recovery/deletion), `test_closed_access.py`, `test_track_recovery.py`, `test_track_deletion.py`, `test_loudness_integration.py`. Review external-service fixtures before broader execution.
- iOS: `utils/__tests__/streamUrl.test.js`, `playbackCoordinator.test.js`, `preloadScheduler.test.js`, `preloadSchedulerPressure.test.js`, `audioCache.test.js`, `lockScreenControls.test.js`, `patchExpoAudio.test.js`, hook playback/session lifecycle tests. Package script: `npm test -- --runInBand <selected suites>`.
- Web: stream/purge/wave store tests and loudness regression tests; scripts `npm test`, `npm run build` (`tsc -b && vite build`). No browser acceptance performed by S0.
- `brain/test_db_path.py` uses setdefault for a temporary DB and disables embedding/reconcile/loudness jobs. Future test command must set `PUUK_DB_PATH` explicitly to a disposable absolute path and disable external background work **before process import**, e.g. from root with an operator-created disposable path: `PUUK_DB_PATH=/tmp/<unique-test-directory>/test.db EMBEDDING_QUEUE_ENABLED=false EMBEDDING_RECONCILE_ENABLED=false LOUDNESS_SYNC_ENABLED=false venv/bin/python -m pytest brain/test_media_ticket.py brain/test_closed_access.py`. This is a future recipe, **not executed evidence**; verify interpreter/dependencies first.

Current backend playback API is `POST /api/media-ticket` authenticated by `get_current_user`, returning `url,expires_in,expires_at`; source TTL default 600 seconds, direct URL `/api/stream/<id>?mt=...`, with `get_stream_user` on stream. No ticket POST or playback session was issued by S0. Web App has mandatory LoginModal; source offers password and Telegram OTP `/login` flow. iOS LoginModal also offers password/OTP. Actual OTP login, new registration, share destination preservation and navigation edge cases were not performed; J2 must document them, and later integration must exercise them with an owner-supplied test session. No authenticated test account was accessed.

Read-only SQLite SELECTs and `stat()` identified two existing bounded **candidates**, without reading/downloading/changing audio bytes:

| Candidate | Track ID | Duration | Catalog bytes = filesystem bytes |
|---|---|---:|---:|
| Short MP3 | `5bb9c7a4-ffc5-50ef-9594-d30cf3eb0adc` | 24.408 s | 674,903 |
| Long MP3 | `3d35b514-3891-542d-b401-9cfda36eb104` | 1,944.0065 s | 77,840,453 |

Use the short existing file for bounded Range/cold/warm experiments after authorized test-session/origin access exists; use limited ranges for the long recording. These have not been designated disposable, and S0 did not establish artist/content rights or delete/replace permission. A deliberate unusual-size fixture, content byte comparison and deletion/purge test require an isolated fixture policy; never modify these originals. Schema already has `file_size,file_mtime_ns`; suitability as content version remains S1's decision, not established by S0.

## 8. Measurement access and outstanding external evidence

Local HTTPS `https://ipinfo.io/json`, with output limited to country/region/org and **no public IP**, reported RU / Krasnodar Krai / `AS8402 PJSC "Vimpelcom"`. This is a practical RF baseline vantage for the current host (third-party geolocation, not proof of physical location or all RF networks). SSH server is accessible on the same LAN; it is **not** an independent European point. No European SSH runner, problematic European residential/mobile network, VPN measurement route, or owner-operated European device was established. No new VPS/service was purchased, VPN installed or third-party probe scheduled.

Required next evidence:

1. J1's authenticated read-only provider-console/account configuration audit: secure token/cache key/origin-header/prefix-rule support, exact current options, purge and billing/traffic observation access. S0 has no account/control-plane proof.
2. Owner/coordinator-provided European measurement point, recording country, ASN/network type without personal IP, UTC, sample count, app build, CDN node, direct versus CDN conditions. The RU single requests above cannot establish p95, audible startup, cache HIT, throughput or regression thresholds.
3. Authorized test session plus reviewed fixture policy for actual direct/CDN audio bytes and Range/negative warm-cache tests. Current 401 catalog probes are only availability/auth boundary checks.
4. Privileged operator path for reviewed nginx/systemd/secret changes; passwordless sudo is not available to this shell. Do not infer that successful SSH grants root deployment authority.
5. Signed iOS build route and physical device with exact build/native patch identity. Local Expo cached auth and an unsigned CI workflow are insufficient. Background playback, seek, sleep/expiry, network transitions and header leakage remain **not tested**.
6. Apple Team ID, Associated Domains entitlement/provisioning, real AASA and signed build if Universal Links are to enter the first release; otherwise explicitly keep that stage separate.

These are **unknown/unavailable evidence**, except the directly disproven readiness of current AASA/Associated Domains configuration and the observed media-prefix overbreadth. They are not claims that Yandex lacks required features, that no Apple account/device exists, or that Europe delivery is ineffective. S0 establishes safe constraints; it does not close G1/G2/G3/G4 or authorize production mutation.

Final preservation verification: repeated manifest/hash comparison returned **20/20 MATCH, zero mismatches**; tracked `git diff --binary` hash remained `b6032e867e2e2771a6b3ec266a108eb986f846646b002e8574aa9223c2727b8d`. Final `git status --short --untracked-files=all` added only this report relative to the observed start inventory; report whitespace scan found no trailing-space lines. No executable tests were run for this documentation-only audit.
