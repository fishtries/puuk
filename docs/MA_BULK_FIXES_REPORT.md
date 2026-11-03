# Bulk fixes report

- SQLite busy/locked errors from the bulk service now return HTTP 503 with `detail.code = credits_busy`, safe message `База занята`, and `Retry-After: 1`, matching the existing credit service. The CLI's existing mapping of HTTP 5xx to exit 1 remains unchanged.
- Added a real SQLite write-lock test that checks the exact response, unchanged credits, and absence of journal writes. Added an album-scope preview/apply/undo test covering independent track credits, album and track DTO attribution, affected track IDs, and unchanged SHA256, size and mtime_ns for two temporary audio files.
- `brain/venv/bin/python -m pytest -q brain/test_multi_artist_bulk.py`: exit 0, 14 passed.

Tests used an isolated `PUUK_DB_PATH` and temporary fixtures; no production data, real Qdrant or audio library files were modified. Broader suites were not rerun as instructed.
