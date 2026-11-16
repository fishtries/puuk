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

## Mixed-node propagation and bounded audio evidence

After the request-header correction, operator probes recorded normal CDN signed missing-object 404 and edge no-store/CORS, but earlier probes mixed updated/unupdated nodes. A pinned connection to yccdn-m9-18 still returned pre-update 403 behavior while yccdn-m9-12 served the chosen bounded file (674903 bytes) correctly. On m9-12 full GET and HEAD passed exact bytes/hash/ETag/MIME/CORS/no-store checks; start/middle/end/suffix each returned exact 100-byte 206 bodies and matching Content-Range, but failed because Accept-Ranges was absent on 206. Therefore audio acceptance remained FAIL rather than silently relaxing the header requirement. Coordinator saved explicit Accept-Ranges bytes plus browser exposed header list including cache-host in static responses; another propagation cycle is required. Cache and client issuance remain off. Initial client-header substitution/duplication results are not accepted as a conclusive provider failure until repeated on an updated pinned connection.


## Autonomous continuation — admin pilot selected, 2026-11-16

The user selected login admin; read-only lookup confirmed immutable user ID 1.
The pilot set is prepared for that ID only, while CDN issuance remains disabled.
On a pinned updated node yccdn-m9-16 all nine origin/edge checks passed: missing,
wrong and duplicate direct secrets deny 403/no-store; correct secret reaches404;
CDN unsigned denies403, valid/client-wrong/client-duplicate reaches404, extraquery400.
This establishes provider request-header overwrite on that node. Earlier mixed-node
results were propagation artifacts and are not treated as proof of a bypass.

Read-only audio on yccdn-m9-03 matched the existing674903-byte object: fullGET,
HEAD and four ranges returned correct status, bytes, ETag, Content-Length, MIME,
Content-Range, fixed web CORS and browser no-store. The exact-header gate remains
open: adding static Accept-Ranges restored it on206 but duplicated it on200/HEAD.
A scoped options.headerFilter update now whitelists required origin response
headers, while static Accept-Ranges, Cache-Control and Expose-Headers supply a
single final value. API operation bc8vndgry2rdsz3zzx4t completed; edge propagation
and full audio recheck are still required. No cache enabled by this update.

Dedicated service-account IAM auth was implemented, tested198/198 and installed
with protected rollback backup iam-20261116T113244963322Z; details and boundaries
are in PURGE_SERVICE_ACCOUNT_ADDENDUM.md. Exact four deployed source hashes were
checked. Origin ON, delivery/purge OFF; no bot restart. Commit9662779 pushed.


## Cold protocol proof and closed cache experiment — coordinator

The selected admin is ID1. Dedicated service account auth succeeded for one
nonexistent-prefix purge and an authenticated operation GET. Purge consumer was
enabled with fresh heartbeat; mode backup mode-20261116T114128361213Z. Direct
public API smoke under a60-second in-memory admin session passed; unsigned ticket
401, default/direct/CDN-request all selected direct, exact range and version-bound
full transfer matched. There were zero exposures/outbox jobs before fixture setup.

API inventory confirmed one dedicated origin and consumer, no resource rules or
secondary hostnames. Explicit SNI was enabled and slicing disabled. A HEAD+Range
probe exposed provider forced-range206; disableProxyForceRanges restored200/full
length. Static preflight methods/allowed headers/Max-Age300 were added. The earlier
exact-single-field Accept-Ranges assertion was corrected according to RFC9110
list semantics; exploratory header filtering was reverted, preserving origin
headers and the required static response metadata.

Cold origin full matrix passed. Cold CDN full matrix then passed on yccdn-m9-03
against81127 generated silent bytes: full/HEAD, start/middle/end/suffix/open range,
HEAD ignoring Range, matching/mismatching If-Range,304,400,416, exact multipart
parts and allowed/denied preflight. The earlier Max-Age-on-HEAD selection heuristic
was replaced by an actual OPTIONS check on the same connection. Full logs are
retained in the coordinator's scoped terminal history, no URLs/keys/audio printed.

One generated five-second silent fixture and a disposable random-password
non-pilot account were recorded in the server manifest. Creation resumed the same
recorded identity after an operator helper initially omitted the music_dir lock
argument; no duplicate file/account was created. Exposure is now recorded under
the same track lock before any warm-cache signed URL. No original music edited.

Cache-setting API attempt with simpleValue0 normalized caching OFF despite custom
success overrides, so it was not treated as enabled. The reviewed policy now uses
simpleValue3600 (documented200/206/301/302 defaults), explicit zero overrides for
redirects/OPTIONS/errors, browser cacheOFF, stale empty/off, cookies ignored and
blacklist onlymd5/expires. Operation bc87o5lu4xku7tibpdci accepted and readback
confirms the policy. This is a closed fixture experiment, not warm acceptance;
global permission issuance remains OFF and all real clients remain direct.

Web source integration9643683 and deterministic test fixtures2a3a413 were pushed.
Frozen web candidate:220 tests/33 suites, build/lint exit0, both public flagsfalse.
Production web/device rollout is still gated.

## R3 continuation — 2026-11-16 13:57 UTC

Supersedes the earlier experimental query blacklist: retain ALL query parameters.
See CONTRACT_R3_QUERY_CACHE.md for the failed R2 duplicate-query case and explicit
provider compatibility limits. Closed warm matrix passed on yccdn-m9-14: four
full GETs, one origin read, three Cache-Status HITs, exact generated silent bytes;
invalid/expired capabilities denied, including same cached URL after expiry.
Cached HEAD+Range206 and equivalent unreserved path spelling are documented R3
compatibility observations, not retroactive R2 passes.

Expiry cohort source installed successfully; rollback backup
/var/backups/puuk-cdn/expiry-20261116T130824339624Z. Live/local delivery_service.py
SHA256 both6e116cf37dd04fd1ecbe62e691c7804b54099cdb04f325c5ecefc94bb9248a7d.
Installer verified source/epoch, fresh purge heartbeat and protected origin;
issuance remains OFF. Local selected backend suite211 passed, one warning.

New iOS candidate75c2302 CI succeeded; see IOS_BUILD_ACCEPTANCE.md. Controlled
API pilot/rollback helper is prepared but has NOT executed: sudo -n was rejected
with a password-required response after the sudo timestamp expired. No flags
were changed by that attempt. Root access renewal is needed for the closed pilot,
fixture retirement/purge and cleanup. Refresh the fixture exposure before probing;
its previously recorded capability has expired. At13:57UTC brain, bot and nginx
were active. No real-user pilot or full release acceptance is claimed.
