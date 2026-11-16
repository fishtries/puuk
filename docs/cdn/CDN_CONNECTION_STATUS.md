# CDN connection — current execution status

2026-11-16 coordinator probes, after user requested CDN connection. No provider/server mutation or feature activation has occurred. No workers were launched.

Fresh read-only evidence: SSH fish@192.168.1.117:59348 works; puuk-brain and nginx active/running. Backend works from /home/fish/apps/puuk/puuk/brain as fish. sudo -n -l failed (passwordless operator route unavailable). origin-media.puuk.fun did not resolve; media.puuk.fun resolved to 188.72.112.1. Backend delivery_service.py, nginx origin site and /etc/puuk/cdn.env are not present at expected paths (limited to fish visibility). Orca native app enumeration and embedded tab list are empty; no yc executable or Yandex connector is available. These do not establish provider account state.

Prepared reviewable operator inputs:

- infra/puuk-origin-media.conf: dedicated Host/SNI boundary; ACME-only HTTP, TLS default deny, media prefix proxied with raw URI to ASGI secret validation; no credential forwarding or signature-bearing access logs. Candidate has not passed nginx -t: local nginx is unavailable, and the target certificate does not yet exist by demonstrated evidence. Do not enable this file before DNS/certificate/backend preparation.
- infra/cdn.env.example: no secret values, all switches off. Secret provisioning must generate distinct signing/origin materials and give runtime purge access. No JWT reuse or rotation.

Required coordinated actions, in order:

1. Finish G2 backend compatibility regressions and coordinator security evidence review; freeze a scoped source manifest excluding unrelated recommendations/bot changes. Back up exact remote predecessors and consistent SQLite state, publish backend with switches off and scoped --no-access-log, restart only puuk-brain. No broad deploy.sh.
2. Beget A record origin-media.puuk.fun -> 128.69.178.203; preserve existing media/validation records. Privileged operator provisions ACME webroot and origin certificate, installs reviewed nginx candidate and explicit /cdn/ deny on web vhost, runs nginx -t and reloads nginx only on success. Update CDN-only log policies without dumping existing secret-bearing configs.
3. Provider operator inventories exact resource/folder/origin group and secondary hostnames; backs up configuration before edits. HTTPS origin, Host and SNI all target origin-media.puuk.fun. Install independent 32-character signing key, no-IP per-file secure token, overwritten single X-Puuk-Origin-Secret, no redirects/transforms, only media methods/paths; leave cache off until closed probes succeed. Never expose auth/admin API through media resource.
4. Verify cold denial without/with bad signatures, origin secret bypass, method/Range/CORS/no-store semantics. Then configure success-only edge cache 3600 seconds, no stale/error caching, exclude ONLY md5/expires from query cache key; browser remains private/no-store. Warm and repeat negative probes and byte comparisons; prove actual HIT plus reduced origin reads.
5. Enable purge consumer with protected runtime credential; select explicit approved numeric pilot user and two-user synthetic fixtures. Enable backend issuance only for pilot after G2 and closed security checks. Publish reviewed web/iOS client capability flags and verify installed build, no auth-header leak, bounded fallback/rollback. Geographic measurements and 24-hour pilot remain required for rollout.

Access needed now: a working Yandex API or supported console route and an operator who can perform narrow sudo/DNS actions. Passwords/tokens must stay outside chat and git. Existing read-only SSH alone cannot install nginx/systemd/TLS configuration or edit provider settings.

Provider references: https://yandex.cloud/ru/docs/cdn/operations/resources/configure-server-name and https://yandex.cloud/ru/docs/cdn/api-ref/Resource/update (read during this turn). Exact schema/settings must be checked on authenticated resource before submitting a masked update. No ready-to-submit API payload is fabricated without resource inventory.

## Operator-assisted origin bootstrap completed

User added Beget A record and installed ACME-only nginx bootstrap, then issued certificate with certbot webroot and installed closed HTTPS vhost plus scoped renewal hook. Fresh coordinator probes verify TLS 1.3 with trusted certificate for origin-media.puuk.fun expiring 2027-02-14; root, /api/tracks and a synthetic /cdn/audio path all return 404. Hook is root-owned/executable and passes sh -n. Provider configuration, backend delivery deployment, flags and live audio tests remain unfinished. The named .http-backup contains HTTPS because the operator repeated copy after installation; original HTTP bootstrap bytes remain in /home/fish/puuk-cdn-setup/origin-http.conf for recovery. Do not treat the named backup as an original HTTP snapshot.

## Initial provider token propagation confirmed by operator probe

User reports sudo HEAD-only probe: unsigned=403, correctly signed nonexistent object=404, wrong signature=403, correctly signed expired query=410. Expired 410 is a denial, not a failure. This confirms initial per-path edge token behavior against a closed/nonexistent origin object; it does not prove actual audio Range bytes, origin-secret header overwrite, cache HIT or negative authorization on warm cache. Provider screenshots show dedicated source origin-media.puuk.fun with HTTPS and matching custom Host/SNI, token enabled without IP binding. Static origin-header value was entered by operator outside chat; actual header delivery/overwrite still unverified.

## Autonomous provider correction authorized by user

User explicitly requested autonomous completion while away, including secret handling. Orca native bridge returned no apps; native Zen remained present. Hyprland 0.56+ uses Lua dispatch syntax, so direct installed Hyprland/Wayland utilities were used to focus only the CDN window and edit the existing form. No cookie/profile/token extraction or dependency install occurred. The request-header name/value reversal was confirmed visually and corrected, with format-only verification of the existing 64-hex origin secret; clipboard cleared. Static response Cache-Control private,no-store was added and saved; current CORS whitelist/methods preserved, caching/issuance unchanged. Initial post-save probes still reflect pre-propagation state. Existing user SSH terminal accepts sudo -n for bounded no-secret probes; no password captured or requested.

## Backend/origin deployment and final header verification

Operator installed frozen backend package successfully; protected backup /var/backups/puuk-cdn/20261116T103616948641Z. Coordinator verified all 27 source hashes, backend/bot/nginx active, share and media-ticket unauthenticated 401/no-store, effective delivery/origin/purge flags off and Uvicorn access logging disabled. Operator then applied scoped origin activation; backup /var/backups/puuk-cdn/origin-20261116T104006038278Z. Public origin rejects absent secret 403/no-store; web host /cdn/ is 404. Delivery and purge issuance remain off.

Provider correction was saved and independently re-read from its edit form. A fingerprint-only server helper and in-memory comparison confirmed saved provider origin secret matches root-only server environment exactly. No re-save occurred during this verification. Root helper output contains only SHA-256 fingerprint, not key. Native bridge remains unable to enumerate apps; existing user SSH terminal supports sudo -n and was used for safe probes. No password was obtained and no browser session/cookie extraction occurred.

Read-only backend metrics observed 1734 tracks, 1037 ready versions and 695 pending, zero exposures and zero purge jobs. Prepared probe_audio.py reads only one existing ready file <=1 MiB, checks its current hash, full/HEAD/Range bytes and headers; it does not change tracks/accounts/exposure or enable cache. Must run only after provider-header boundary checks succeed. These operations are not final G3/G4 acceptance.
