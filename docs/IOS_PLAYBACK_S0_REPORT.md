# S0 baseline — 2026-10-30

Run: `run_5c86d4feea71`. Actual source snapshot, not HEAD, is authoritative.

Artifacts: `/tmp/puuk-playback/S0/`: `status.txt`, `head.txt`, `diff.txt`, `manifest.json` (SHA-256), `environment.json`, `versions.json`, `ios-targeted.log`, `ios-targeted.json` (exact command/cwd/exit/duration).

Targeted existing playback suite: **passed**, 7 suites / 167 tests, exit 0. Runtime versions: {"node": "v26.12.0", "npm": "12.2.1", "python": "Python 3.14.8", "expo": "58.0.19", "expo-audio": "58.0.10", "expo-file-system": "58.0.11"}.

Existing dirty iOS hook/App/player and backend changes are protected. No reset, commit, deploy, service restart or audio edits authorized for workers. Diagnostic ownership is report-only.

Host: Linux; xcodebuild/xcrun and iPhone runtime evidence unavailable in current environment. Device build ID: unknown; device acceptance **not tested**. Native/installed SDK source hashes are collected by J03. Server/proxy verification delegated read-only to J02; production environment is not a baseline test database.

Model catalog check passed for `tundra/deepseek-v4.1-flash-1017` and `antigravity-manager/gemini-3.8-flash`; inference availability is established only by worker execution.
