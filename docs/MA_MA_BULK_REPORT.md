# Multi-artist bulk worker report

Implemented the bulk service, reconciliation CLI and isolated tests in `brain/services/artist_credit_bulk_service.py`, `brain/reconcile_artist_credits.py` and `brain/test_multi_artist_bulk.py`. Preview stores a hashed durable plan, apply checks exact source membership and all revisions before changes, and undo checks every changed entity before restoring manual decisions. The service checks admin at every boundary; the CLI report opens SQLite with `mode=ro`, marks punctuation candidates ambiguous, and never splits names automatically.

Commands and outcomes:

- `python -m py_compile brain/reconcile_artist_credits.py brain/services/artist_credit_bulk_service.py`: exit 0.
- `pytest -q brain/test_multi_artist_bulk.py`: exit 127 (pytest unavailable on PATH).
- `venv/bin/pytest -q brain/test_multi_artist_bulk.py`: exit 127 (no root venv).
- `brain/venv/bin/python -m pytest -q brain/test_multi_artist_bulk.py`: exit 0, 10 passed at that checkpoint.
- `brain/venv/bin/python -m pytest -q brain/test_multi_artist_bulk.py brain/test_multi_artist_storage.py`: exit 0, 33 passed in the final run.
- Read-only report on `/tmp/puuk-ma-storage-dryrun-m8u1yaka/library.db`, output `/tmp/puuk-ma-bulk-report.json`: exit 0, 248 ambiguous candidates; SHA256, size and mtime_ns of the database were unchanged. Human output on the same copy also exited 0 (`/tmp/puuk-ma-bulk-human.txt`). Original snapshot was not opened or changed.

Tests use temporary `PUUK_DB_PATH`, a temporary audio fixture and no real Qdrant. The audio SHA256, size and mtime_ns remain unchanged across apply and conflicting undo. Current tests do not exhaustively cover album propagation, concurrent process retries, SQLite busy behavior, or full API/iOS integration; these remain for integration and independent review. No production writes, deployment, commits, or audio edits were performed.
