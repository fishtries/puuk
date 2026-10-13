#!/usr/bin/env python3
"""Server-side embedding queue recovery CLI.

Reconciles the server SQLite catalog with the shared Qdrant queue: every track
whose audio file is present in MUSIC_DIR but has no Qdrant point gets a queue
placeholder (needs_embedding=true), which the local heavy_worker picks up.

This is the server-side counterpart to the periodic API reconciliation and does
not require ML dependencies (no essentia/tensorflow/heavy_worker import).

Usage (on the server, from brain/):

    MUSIC_DIR=/mnt/data/projects/puuk/music \
    QDRANT_URL=http://127.0.0.1:6333 \
    ./venv/bin/python reconcile_embedding_queue.py --dry-run

Reads the server SQLite from PUUK_DB_PATH (or the default puuk.db). Exits
non-zero when Qdrant cannot be reached or points fail to be written.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Восстановление отсутствующих точек Qdrant из серверного каталога SQLite"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Только показать, сколько заданий было бы создано (без записи в Qdrant)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Ограничить количество создаваемых заданий (для поэтапного восстановления)",
    )
    args = parser.parse_args()

    from services.embedding_queue_service import (
        EmbeddingQueueError,
        get_qdrant_client,
        reconcile_embedding_queue,
    )

    try:
        counters = reconcile_embedding_queue(
            get_qdrant_client(), dry_run=args.dry_run, limit=args.limit
        )
    except EmbeddingQueueError as e:
        print(f"[reconcile] Ошибка Qdrant: {e}", file=sys.stderr)
        return 1

    prefix = "[reconcile][dry-run]" if args.dry_run else "[reconcile]"
    print(
        f"{prefix} examined={counters['examined']} existing={counters['existing']} "
        f"enqueued={counters['enqueued']} would_enqueue={counters['would_enqueue']} "
        f"missing_file={counters['missing_file']} invalid_id={counters['invalid_id']} "
        f"failed={counters['failed']}"
    )
    return 1 if counters.get("failed") else 0


if __name__ == "__main__":
    sys.exit(main())
