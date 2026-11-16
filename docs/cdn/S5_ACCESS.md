# S5-PREP — operational access audit

Audit date: 2026-11-16 UTC (live probes approximately 08:02–08:09 UTC). Task `task_49d28651b777`, dispatch `ctx_a26311ac0d0b`; senior Codex `gpt-6.1-sol`, high, no helpers. **Readiness investigation only: no S5 deployment, pilot, G3 acceptance or release.** Only this file and [CDN_RUNBOOK_DRAFT.md](CDN_RUNBOOK_DRAFT.md) are writable by this task.

The audit is complete when access results, unavailable evidence and the remaining operator inputs are recorded; those inputs can remain release blockers. Existing instructions authorize read-only SSH probes, not privilege escalation or production configuration changes. No password/token is requested in chat. No login, dependency installation, secret provisioning, audio read/write, database access, test/build, deploy, restart/reload, DNS/certificate/provider/IAM mutation, commit/reset/stash or helper launch occurred.

## Evidence identity and instruction coverage

Read root/backend/iOS AGENTS.md, the complete orchestration plan, S0/J1/J2, CONTRACT/DECISIONS, G1_REVIEW, DEPLOYMENT, deployment scripts, project agent assignments, orchestration/orca-cli/computer-use skills and their current executable guides, browser reference, release-it skill and mini reference. iOS code was not written. Historical reports are attributed below rather than treated as new live observations.

| Artifact | SHA-256 at audit |
|---|---|
| HEAD | `89ebc1c30b36837e584fbe72d51cdb0aed6303be` |
| BASELINE_MANIFEST.json | `53d17c407c829c3c12fb41a8bfe18b37b591ba6c0dfe6ca29b40a90760591af8` |
| CONTRACT.md revision 2 | `325d9b9a965fb1420dc4dc85218392cce8752fd68d3a1e61e9475ab00b020158` |
| DECISIONS.md | `86680b54319327f95fdd3d48c98ca1fa867a43dd1cec9f407cfde42eeb61a276` |
| G1_REVIEW.md (revision-1 rejection) | `07b22bb8d9012a6d54c3844db89c50c20a5b92583fa29139bf4eb7bdcee1c68b` |
| Tracked `git diff --binary` | `b6032e867e2e2771a6b3ec266a108eb986f846646b002e8574aa9223c2727b8d` |

All 20 baseline file hashes matched before authoring. During this audit coordinator message `msg_1ace04588f12` reported G1-R2 PASS and froze the exact revision-2 hash above; [GATE_LEDGER.md](GATE_LEDGER.md) and the opening verdict/hash of [G1_REVIEW_R2.md](G1_REVIEW_R2.md) corroborate that acceptance. This task does not write either report or independently repeat their review. S2/J4 implementation has started in disjoint scopes; G2/G3/G4 remain open and no production configuration is authorized by this preparation task.

## Verified access table

All commands below describe completed read-only observations unless marked historical. Responses were filtered before printing; no environment values, credentials, cookies, browser storage, raw logs or secret-bearing URLs were emitted.

| Capability | Method / actual result | Consequence |
|---|---|---|
| SSH | `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -p 59348 fish@192.168.1.117 'python3 -'` succeeded as `fish` | Existing noninteractive SSH works; no new host key/login |
| Service observation | `systemctl show` selected state/path/user/PID properties: `puuk-brain`, `puuk-telegram-bot`, `nginx` all active/running | System services exist; DEPLOYMENT.md's missing-unit note is stale |
| API process topology | One `uvicorn api:app` process; no `--workers`, no gunicorn, `WEB_CONCURRENCY` unset | Current observed API process count 1; re-count at release because contract limits multiply per process |
| Backend source files | `/home/fish/apps/puuk/puuk/brain` owned UID 1000, 0755, writable by `fish` | Narrow source staging is possible; write/restart not exercised |
| Web publication | `/var/www/puuk-web` UID 33, 0775, not writable; index UID 33, 0664, not writable | Privileged web deploy/rollback operator needed |
| nginx config | `/etc/nginx/sites-enabled/puuk-web` root-owned 0644 readable/not writable; sites-available directory root-owned/not writable | Config can be inspected; install/config-test/reload authority not demonstrated |
| System unit | `/etc/systemd/system/puuk-brain.service` root-owned 0644 readable/not writable; backend user `fish`, working directory above | Operator needed for drop-in/secret injection and process control; SSH does not confer it |
| Passwordless privilege | `sudo -n -l`: exit 1, password required; no prompt or recovery attempted | No usable passwordless sudo path verified; restart permission via polkit was not tested by mutation |
| Certificate filesystem | `stat` below `/etc/letsencrypt/live/web.puuk.fun` and `/origin-media.puuk.fun` raised PermissionError | Cannot establish presence/absence of origin certificate or read private keys; root operator must inspect safely |
| Provider tools | Local `yc`, terraform/tofu, EAS CLI absent; S0 also reported server provider tooling absent | No authenticated provider API path established; none installed |
| Native browser surface | Current `hyprctl instances -j` reports one live instance; its filtered clients show two mapped/nonhidden Zen windows, PID 559227, one title matching Yandex/CDN | A relevant existing browser window is present; title alone proves neither login nor resource access |
| Supported GUI bridge | Version-matched `orca computer capabilities` reports Linux provider 1.0.0; `list-apps` returns `apps: []`; `list-windows --app zen` and `--app pid:559227` both `app_not_found`; permissions report accessibility/screenshots unsupported | Cannot inspect the existing native console with the supported GUI tool in this session |
| GUI retry | Retried `list-apps` with child-command environment set from the **current** Hyprland instance/socket: still empty | Stale inherited Hyprland signature was not assumed authoritative; limitation persists |
| Embedded browser | `orca tab list --json`: no tabs | No existing embedded console session; no browser/tab started |
| Provider session/IAM | No authenticated resource view obtainable; no credentials/session extraction attempted | Console login, resource/folder/origin-group IDs, read/update/purge/IAM/billing access all **unconfirmed**; CLI absence is not account absence |
| Auth fixture/pilot | No login/ticket/catalog identity lookup performed | Test session, exact immutable numeric pilot ID, two-user cache-sharing test identities and fixture mutation policy must come from coordinator |
| RF vantage | Fresh HTTPS geolocation output restricted to RU, Krasnodar Krai, AS8402 PJSC Vimpelcom | Available RF measurement candidate; no personal IP recorded, no audio measurement |
| EU vantage | None established by available evidence; LAN SSH server is not independent Europe | Need a problematic European residential/mobile network or owner-run device/runner |
| Signed native build/device | See inventory below | No signed physical-device execution capability verified |

GUI calls used `/home/fish/.config/orca/linux-orca-cli-shim/orca` throughout, runtime ID `1c03e7d9-e633-4abd-b6c2-c800cdaa6d19`. No foreground restore, browser start, unrelated personal-tab navigation, screenshot capture, cookie/storage access or remote-debugging workaround was used. The exact limitation is the bridge's inability to enumerate/reach an already existing Zen window, **not** absence of that window or proof of a logged-out console. A later working console with no API capability must be recorded as UI-only, with each actually visible setting and permission distinguished from untested edits.

## Live DNS/TLS and deployment observations

DNS used standard-library queries to the configured recursive resolver (no dependency installation); `dig` is absent. Values are resolver observations, not a DNS-provider account audit.

| Item | Fresh result |
|---|---|
| `web.puuk.fun` A | `128.69.178.203` |
| `media.puuk.fun` CNAME / resolved A | `a77ec7546eec5094.topology.gslb.yccdn.ru.` / `188.72.112.1` |
| `_acme-challenge.media.puuk.fun` CNAME | `fpq4aktbaif1f6560qhe.cm.yandexcloud.net.`; preserve exactly |
| `puuk.fun` NS | `ns1.beget.com.`, `ns2.beget.com.`, `ns1.beget.pro.`, `ns2.beget.pro.`; does not establish Beget login/edit permission |
| `origin-media.puuk.fun` A | DNS response RCODE 3 (NXDOMAIN) from configured resolver; no origin DNS currently usable here |
| Public root HTTPS | Both web/media returned 200, curl exit 0, TLS verification result 0; no audio fetched |
| Public media certificate | SAN `media.puuk.fun`, valid 2026-11-15 23:12:35 through 2027-02-13 23:12:34 GMT |
| Public web certificate | SAN `web.puuk.fun`, valid 2026-09-29 12:13:12 through 2026-12-28 12:13:11 GMT |

The inspected Puuk nginx file still hashes to `f4057ca4d1fa450f97184e1b4e8f3ffd0c5479ae9001dcbdd561a28546919716`. It contains `server_name web.puuk.fun`, web root `/var/www/puuk-web`, API proxy to `http://127.0.0.1:8000`, web certificate path, and no `origin-media.puuk.fun` or `/cdn/audio/` configuration. This is disk-file evidence, not a new loaded-config dump/config test; no `nginx -T/-t` or reload ran. S0's prior SPA/API exposure probes remain historical evidence, not tests repeated here.

Remote `brain/api.py` hash `a279547a214ad4e713ae7818fb380e869a8c49de147eee2f07412ad74ef53bc7` and `brain/routers/streaming.py` hash `6382aae1a9ebaee0ed00bc597832a3809e6787b89773e38cde534a9b2d688a87` still match S0. This does not identify the complete deployed source revision. Web index hash `1c72821db6709841c3b85f28dd699027b9b8f1d0c644b52fbc68f37a5d7ed0e0`, asset references `/assets/index-DAr31KIJ.js` and `/assets/index-BsD7mOql.css`; the asset contents/build provenance are not audited. Both deployment directories are real directories, not release symlinks. There is no verified atomic-release switch to assume.

Backend security environment inspection printed names only: `JWT_SECRET` present, no `CDN_*` or `DELIVERY_*` names. Unit text inspection printed assignment names only and confirms inline JWT configuration in root-owned 0644 unit; bot `.env` is 0644 and contains BOT_TOKEN/ALLOWED_USERS/MUSIC_DIR names. Existing permissions need separately reviewed correction by the owner; preserve current JWT and bot behavior. No value was printed or reused. A file readable to `fish` is not adequate evidence of protected secret storage.

## Provider state: unknowns must remain unknown

| Resource field | Current authenticated value | Required later draft target / verification |
|---|---|---|
| Primary hostname | Public DNS/TLS corroborate media hostname; resource binding unconfirmed | `media.puuk.fun`; inventory all secondary hostnames/resources that could expose objects |
| Folder/resource/origin-group IDs; origin source list | Unconfirmed | Record exact existing IDs and every enabled/failover origin; determine whether group is shared before editing |
| Origin protocol, HTTP Host, SNI | Unconfirmed | HTTPS; Host and SNI `origin-media.puuk.fun`; verify upstream TLS trust behavior rather than infer it from public TLS |
| Active state/cert binding/HTTP redirect | Unconfirmed in console | Preserve media cert/validation; client HTTPS; wait for actual propagation |
| Edge/browser cache, status TTLs, stale, cookies, query key | Unconfirmed | Success-only edge 3600s, private/no-store client, no stale/errors, ignore cookies, blacklist **only** md5/expires |
| Secure token/type/IP binding | Unconfirmed; no key read | Exact per-file no-IP token; track enabled/type and key presence only, never value |
| Static request/response headers, header filter, CORS, methods | Unconfirmed | Secret-header presence/name only; overwritten single header proof; fixed web CORS, GET/HEAD/OPTIONS |
| Location rules/priority/rewrite/follow redirects/slicing | Unconfirmed | No arbitrary web/API exposure, no redirects/transforms, slicing initially off; inspect inherited/per-rule overrides |
| Purge/operation/metrics/budget permissions | Unconfirmed | Observed resource/purge-operation visibility and applicable operator role; no paid expansion |

The plan's old statements “token off/cache off/cookies not ignored/certificate connected” and J1's diagram **are not live settings evidence**. No warm-cache security, audio bytes, header overwrite, cache HIT, performance or device behavior is inferred from settings or root HTTP 200.

Current official [IAM documentation](https://yandex.cloud/en/docs/cdn/security/index) describes `cdn.viewer` for viewing and `cdn.editor` for resource/origin-group changes and purge; granting/viewing resource roles requires appropriate administrative authority. This audit confirms none of those assignments. Choose the narrowest actually supported scope for later credentials; do not promise a purge-only role where only broader editor is available, and do not grant anything in this task.

## Native build and fixture inventory

Fresh source/package inspection: app version `1.0.0`, iOS build number `1`, bundle `com.fishtries.puuk`, scheme `puuk`, no associatedDomains or appleTeamId. These are source settings, **not installed binary identity**. Installed expo/audio/filesystem are 58.0.19/58.0.10/58.0.11; Pods absent. Local EAS CLI, xcodebuild and xcrun absent; Expo cached nonempty auth object present but validity/account/signing access untested. No credentials.json or project .env. Development/preview EAS profiles are simulator; production autoIncrement alone proves no signing route. `gh api user` filtered boolean probe exited 4: no authenticated GitHub capability verified. Historical unsigned CI workflow from S0 does not replace signing/install evidence.

`idevice_id -l` exited 255, no devices listed, “Unable to retrieve device list”; usbmuxd inactive (exit 3). No daemon/pairing was started. This proves enumeration unavailable here, not absence of an owner's iPhone/Mac. Need operator-selected signed build/install route plus physical device and exact build/native patch provenance. Universal Links remain an explicitly excluded follow-up.

S0 identified short/long existing tracks `5bb9c7a4-ffc5-50ef-9594-d30cf3eb0adc` (674,903 bytes) and `3d35b514-3891-542d-b401-9cfda36eb104` (77,840,453 bytes). These are historical bounded read candidates, **not approved disposable fixtures**; this task neither queried the DB nor opened them. Deliberate replace/delete/purge tests need approved synthetic disposable objects and cleanup ownership.

## Exact blockers and input request

| ID | Missing input/capability | Blocks | What coordinator should supply without secrets |
|---|---|---|---|
| M1 | Supported console bridge cannot reach existing Zen; no API route verified | Authenticated settings export, IDs, IAM, provider rollback readiness | Working supported background access or owner-assisted redacted resource/origin-group/rules/IAM inventory; identify operator and whether access is UI-only or approved API tooling |
| M2 | No demonstrated privileged server/web/TLS/DNS operator | Restricted secret file/drop-in, source+web manifests, nginx test/reload, cert/DNS changes and rollback | Named scoped operator/execution route for existing server and Beget zone; no password or broad sudo grant requested |
| M3 | Approved test access and fixtures absent | Closed authenticated byte/security probes and exact pilot selection | Existing test identities/session delivery route outside chat, numeric pilot IDs, two-user test capability and approved disposable fixtures/cleanup policy |
| M4 | Signed build/install and physical device path unverified | Rebuilt native/header/background/seek acceptance | Owner-selected builder/signing/install route, physical device operator and artifact/build provenance; no Apple credentials in chat |
| M5 | Problematic EU measurement point absent | RF/EU acceptance and 24-hour pilot completion | Country, ASN/network type and owner-run measurement route; no personal IP required |

These are external prerequisites, separate from accepted G1-R2 and future S2/J3/G2 implementation evidence. RF access, read-only SSH, source-directory write permission and public DNS/TLS checks are available capabilities. Full live CDN configuration, root authority, fixture identity, signing/device and Europe are **unconfirmed or unavailable to this session**, not disproven globally. After discovery, Orca question `msg_6562b0fcb4db` referred M1–M5 to the coordinator; reply `msg_b64ef9f84ec2` explicitly instructs **carry all five pending**, with no inferred identities or broader tooling/privilege. The coordinator owns requesting nonsecret operator/test-device/network routes from the user while S2/J4 proceed; no further S5-PREP execution depends on an answer. Actual deployment remains gated by G2, the reviewed manifest and later accessible live settings.

## Preservation and verification

No application tests or builds were appropriate for this read-only documentation task. Document checks passed: local links exist, fenced blocks balance, no trailing whitespace. Repeated preservation check returned **20/20 matching baseline files**, original manifest/contract/decisions/historical-review hashes above, unchanged HEAD and tracked diff hash as recorded above at check time. Concurrent S2/J4 writes after that check belong to their owners and must not be reset to recreate this snapshot. This task leaves `CDN_RUNBOOK.md`, `G1_REVIEW_R2.md`, CONTRACT/DECISIONS and every production file untouched. The paired draft contains the future source/build/rollback manifest procedure and sequencing; it is not permission to execute it.

Final check after coordinator reply again returned **20/20 baseline matches**, unchanged HEAD and the four preserved document hashes above. The shared tracked diff has since advanced to `ac6e3beb8877a36a6dd8718b8f53a8f67dc994d65f1de6a940b8897098f21d30`; additional modified tracked paths outside the preserved baseline are `brain/auth.py`, `brain/config.py`, `brain/repositories/base.py` and `brain/repositories/users.py`, consistent with the coordinator-announced concurrent S2 scope. This worker did not write or revert those files. The original tracked-diff hash is the initial snapshot, not a claim that concurrent implementation stayed idle through handoff.
