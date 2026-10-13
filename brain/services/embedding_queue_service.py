"""Server-side embedding queue reconciliation: SQLite catalog -> Qdrant queue points.

The API and the Telegram bot own the SQLite catalog, while historically only the
legacy ``scan.py`` wrote Qdrant queue points. When a track is registered through
the API or the bot it can therefore exist in SQLite without ever entering the
embedding worker queue. This module closes that gap.

Design constraints:
  * No ML dependencies: importing this module must not pull ``essentia`` /
    ``tensorflow`` or ``heavy_worker``. The server only needs to write queue
    placeholders; the worker performs the actual analysis.
  * The Qdrant client is always injected so the logic is testable without a
    live instance.
  * Re-running is idempotent: existing points (including their vectors and
    processing state) are never touched, and a ready vector is never reset to a
    zero placeholder.

Concurrency note: Qdrant offers no conditional "insert only if absent" upsert.
Two server processes (API reconciliation, scan, bot) can race, so reconciles are
serialized per process and point existence is re-checked immediately before
writing placeholders. The remaining cross-process window is deliberately
narrowed, not claimed to be atomic.
"""
from __future__ import annotations

import logging
import os
import threading
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

from qdrant_client.models import PointStruct

import db
from config import COLLECTION_NAME, QDRANT_URL, get_effective_music_dir

logger = logging.getLogger(__name__)

VECTOR_SIZE = 400
DEFAULT_LOUDNESS_ANALYSIS_VERSION = "r128-v1"
RETRIEVE_BATCH_SIZE = 250
UPSERT_BATCH_SIZE = 100

# Serializes reconciles inside a single process (API periodic task, scan, bot).
_RECONCILE_LOCK = threading.Lock()


class EmbeddingQueueError(RuntimeError):
    """Qdrant could not be read, so "point absent" cannot be trusted."""


def is_queue_delivery_enabled() -> bool:
    """Feature flag checked at call time (tests disable it to avoid live Qdrant)."""
    return os.getenv("EMBEDDING_QUEUE_ENABLED", "true").lower() in ("true", "1", "yes")


def get_qdrant_client():
    """Creates a fresh Qdrant client from configuration (lazy import)."""
    from qdrant_client import QdrantClient

    return QdrantClient(url=QDRANT_URL)


def _value(track: Any, key: str, default: Any = None) -> Any:
    """Reads a field from a dict or sqlite3.Row without assuming its type."""
    try:
        return track[key]
    except (KeyError, IndexError, TypeError):
        return default


def coerce_point_id(track_id: Any) -> Optional[Any]:
    """Normalizes a SQLite id into a valid Qdrant point id, or None if invalid.

    Qdrant accepts only unsigned integers or UUIDs. UUIDs are canonicalized so
    that lookup keys compare equal regardless of the textual form stored.
    """
    if track_id is None:
        return None
    raw = str(track_id)
    try:
        return str(uuid.UUID(raw))
    except (ValueError, AttributeError, TypeError):
        pass
    if raw.isascii() and raw.isdecimal():
        value = int(raw)
        if 0 <= value < 2 ** 64:
            return value
    return None


def _resolve_relative_file(file_path: Any, music_root: str) -> Optional[str]:
    """Returns the relative path when it safely points to a file inside music_root.

    Paths that escape the music root, point to directories, or do not exist are
    rejected. No basename fallback is applied: an unverifiable path must never
    become a queue point.
    """
    if not file_path or not isinstance(file_path, str) or not file_path.strip():
        return None
    root = os.path.realpath(music_root)
    candidate = file_path if os.path.isabs(file_path) else os.path.join(root, file_path)
    target = os.path.realpath(candidate)
    if target != root and not target.startswith(root + os.sep):
        return None
    if not os.path.isfile(target):
        return None
    return os.path.relpath(target, root)


def _loudness_payload(track: Any, stat: os.stat_result) -> Dict[str, Any]:
    """Loudness fields matching the project contract.

    A completed result is kept only when its recorded file size and mtime match
    the file on disk. Otherwise the track is marked pending and stale results
    are cleared, mirroring ``reset_track_loudness_pending``.
    """
    status = _value(track, "loudness_status") or "pending"
    l_size = _value(track, "loudness_file_size")
    l_mtime = _value(track, "loudness_file_mtime_ns")
    matches = (
        status == "analyzed"
        and l_size is not None
        and l_mtime is not None
        and int(l_size) == stat.st_size
        and int(l_mtime) == stat.st_mtime_ns
    )
    if matches:
        return {
            "loudness_status": "analyzed",
            "loudness_lufs": _value(track, "loudness_lufs"),
            "true_peak_db": _value(track, "true_peak_db"),
            "normalization_gain_db": _value(track, "normalization_gain_db"),
            "loudness_analysis_version": _value(track, "loudness_analysis_version"),
            "loudness_file_size": l_size,
            "loudness_file_mtime_ns": l_mtime,
            "loudness_error": _value(track, "loudness_error"),
            "loudness_retry_count": _value(track, "loudness_retry_count") or 0,
        }
    return {
        "loudness_status": "pending",
        "loudness_lufs": None,
        "true_peak_db": None,
        "normalization_gain_db": None,
        "loudness_analysis_version": DEFAULT_LOUDNESS_ANALYSIS_VERSION,
        "loudness_file_size": stat.st_size,
        "loudness_file_mtime_ns": stat.st_mtime_ns,
        "loudness_error": None,
        "loudness_retry_count": 0,
    }


def _build_payload(track: Any, rel_path: str, stat: os.stat_result) -> Dict[str, Any]:
    payload = {
        "file_path": rel_path,
        "title": _value(track, "title")
        or os.path.splitext(os.path.basename(rel_path))[0]
        or str(_value(track, "id")),
        "artist": _value(track, "artist") or "Неизвестный исполнитель",
        "duration": _value(track, "duration"),
        "genre": _value(track, "genre"),
        "needs_embedding": True,
        "file_size": stat.st_size,
        "file_mtime_ns": stat.st_mtime_ns,
    }
    payload.update(_loudness_payload(track, stat))
    return payload


def _retrieve_existing_keys(client, point_ids: List[Any]) -> set:
    """Returns the string keys of ids that already exist in Qdrant.

    Any read failure is surfaced as ``EmbeddingQueueError``: treating an error
    as "no points" would overwrite live vectors with zero placeholders.
    """
    keys: set = set()
    for start in range(0, len(point_ids), RETRIEVE_BATCH_SIZE):
        batch = point_ids[start:start + RETRIEVE_BATCH_SIZE]
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=batch,
                with_payload=False,
                with_vectors=False,
            )
        except Exception as exc:  # noqa: BLE001 - boundary: normalize client errors
            raise EmbeddingQueueError(
                f"Не удалось прочитать существующие точки Qdrant: {exc}"
            ) from exc
        keys.update(str(record.id) for record in records)
    return keys


def _upsert_placeholders(client, points: List[Tuple[Any, Dict[str, Any]]]) -> Tuple[int, int]:
    """Writes zero-vector placeholders, guarding against concurrent writes.

    Immediately before each batch write the points are re-read: a track that
    became ready (vector computed) after our first read must never be reset to a
    zero placeholder. Returns (created, failed).
    """
    created = 0
    failed = 0
    for start in range(0, len(points), UPSERT_BATCH_SIZE):
        batch = points[start:start + UPSERT_BATCH_SIZE]
        recheck = _retrieve_existing_keys(client, [pid for pid, _ in batch])
        batch = [(pid, payload) for pid, payload in batch if str(pid) not in recheck]
        if not batch:
            continue
        structs = [
            PointStruct(id=pid, vector=[0.0] * VECTOR_SIZE, payload=payload)
            for pid, payload in batch
        ]
        try:
            client.upsert(collection_name=COLLECTION_NAME, points=structs, wait=True)
            created += len(structs)
        except Exception as exc:  # noqa: BLE001 - boundary: keep processing other batches
            failed += len(structs)
            logger.error("Не удалось записать %d точек очереди Qdrant: %s", len(structs), exc)
    return created, failed


def _empty_counters() -> Dict[str, int]:
    return {
        "examined": 0,
        "existing": 0,
        "enqueued": 0,
        "missing_file": 0,
        "invalid_id": 0,
        "failed": 0,
    }


def enqueue_missing_tracks(
    client,
    tracks: Iterable[Any],
    music_root: Optional[str] = None,
    *,
    dry_run: bool = False,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Creates Qdrant queue points for tracks that lack one.

    Existing points are left untouched so vectors and processing state survive a
    repeated reconciliation. Only tracks whose audio file is present inside the
    music root and whose id is a valid Qdrant point id can be enqueued.
    """
    counters = _empty_counters()
    counters["dry_run"] = bool(dry_run)
    counters["would_enqueue"] = 0

    root = music_root or get_effective_music_dir()
    candidates: List[Tuple[Any, Dict[str, Any]]] = []
    seen_keys: set = set()

    for track in tracks:
        counters["examined"] += 1
        point_id = coerce_point_id(_value(track, "id"))
        if point_id is None:
            counters["invalid_id"] += 1
            continue
        key = str(point_id)
        if key in seen_keys:
            continue
        seen_keys.add(key)

        rel_path = _resolve_relative_file(_value(track, "file_path"), root)
        if rel_path is None:
            counters["missing_file"] += 1
            continue

        stat = os.stat(os.path.join(root, rel_path))
        candidates.append((point_id, _build_payload(track, rel_path, stat)))

    if not candidates:
        return counters

    existing = _retrieve_existing_keys(client, [pid for pid, _ in candidates])
    counters["existing"] = len(existing)

    to_create = [(pid, payload) for pid, payload in candidates if str(pid) not in existing]
    if limit is not None:
        to_create = to_create[:limit]
    counters["would_enqueue"] = len(to_create)

    if dry_run or not to_create:
        return counters

    created, failed = _upsert_placeholders(client, to_create)
    counters["enqueued"] = created
    counters["failed"] = failed
    logger.info("Очередь embedding: %s", counters)
    return counters


def reconcile_embedding_queue(
    client,
    *,
    dry_run: bool = False,
    limit: Optional[int] = None,
) -> Dict[str, Any]:
    """Full SQLite catalog -> Qdrant reconciliation.

    Runs independently of whether the current pass created any SQLite rows:
    backlog tracks that already exist in the catalog are recovered too.
    """
    with _RECONCILE_LOCK:
        tracks = db.get_tracks_for_embedding_reconcile()
        return enqueue_missing_tracks(client, tracks, None, dry_run=dry_run, limit=limit)
