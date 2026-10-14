"""Server-side loudness result delivery: shared Qdrant -> server SQLite.

``heavy_worker`` analyses loudness on the developer machine and writes results
both to its local SQLite and to the shared Qdrant collection. The server API
reads its own SQLite (``deploy`` does not sync ``*.db``), so analysed tracks stay
``pending`` server-side until the results are pulled back. This module performs
that pull.

Design constraints:
  * No ML/scanning dependencies: importing this module must not pull ``scan`` /
    ``librosa`` / ``essentia``. The server only copies already-computed numbers.
  * The Qdrant client is injected, so the logic is testable without a live
    instance; the synchronous runner owns the client and always closes it.
  * Untrusted payloads: only finite numeric metrics are accepted. The result is
    applied only when the worker's recorded file identity (size + mtime) matches
    the *real file on disk* resolved safely under ``MUSIC_DIR``. Missing files,
    path traversal and missing identity are rejected; no phantom catalog rows.
  * SFTP stat has one-second resolution: a worker timestamp truncated to whole
    seconds is compared by seconds, a full-resolution timestamp exactly.
  * The real server stat (nanoseconds) is written back to both ``file_*`` and
    ``loudness_file_*`` so the embedding queue's exact comparison stays current.
  * Idempotent: a result already covering the current file with the same
    analysis version is never rewritten, so a periodic pass does not bump the
    catalog version on every tick.
  * Outage isolated: any Qdrant read failure aborts the pass with a typed error
    and is retried on the next tick; it never raises into the API lifespan.
"""
from __future__ import annotations

import logging
import math
import os
from pathlib import Path
from typing import Any, Dict, Optional

from qdrant_client.models import FieldCondition, Filter, MatchValue

import db
from config import (
    COLLECTION_NAME,
    LOUDNESS_SYNC_QDRANT_TIMEOUT_SEC,
    QDRANT_URL,
    get_effective_music_dir,
)

logger = logging.getLogger(__name__)

SCROLL_PAGE_SIZE = 250
MAX_SCROLL_PAGES = 10_000
_NS_PER_SECOND = 1_000_000_000


class LoudnessSyncError(RuntimeError):
    """Qdrant could not be read, so the pass cannot be trusted."""


def get_qdrant_client():
    """Creates a fresh Qdrant client with a bounded timeout (lazy import)."""
    from qdrant_client import QdrantClient

    return QdrantClient(url=QDRANT_URL, timeout=LOUDNESS_SYNC_QDRANT_TIMEOUT_SEC)


def _empty_counters() -> Dict[str, Any]:
    return {
        "examined": 0,
        "analyzed": 0,
        "synced": 0,
        "created": 0,
        "skipped_not_analyzed": 0,
        "skipped_invalid": 0,
        "skipped_unverifiable": 0,
        "skipped_stale": 0,
        "skipped_unchanged": 0,
        "skipped_missing_file": 0,
        "skipped_missing_track": 0,
        "failed": 0,
        "dry_run": False,
        "would_sync": 0,
    }


def _finite_metric(value: Any) -> Optional[float]:
    """Returns ``value`` as a finite float, or None when it is not usable.

    Rejects booleans (``bool`` is an ``int`` subclass), strings, NaN and
    infinity so malformed Qdrant data can never poison the catalog or the
    client-side normalization path.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def _validated_metrics(payload: Dict[str, Any]) -> Optional[Dict[str, float]]:
    """Extracts finite loudness metrics from an analyzed payload, or None."""
    lufs = _finite_metric(payload.get("loudness_lufs"))
    true_peak = _finite_metric(payload.get("true_peak_db"))
    gain = _finite_metric(payload.get("normalization_gain_db"))
    if lufs is None or true_peak is None or gain is None:
        return None
    return {
        "loudness_lufs": lufs,
        "true_peak_db": true_peak,
        "normalization_gain_db": gain,
    }


def _as_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _resolve_audio_file(file_path: Any, music_root: str) -> Optional[str]:
    """Returns the real absolute path of a file safely inside ``music_root``.

    Relative paths resolve against the music root; absolute paths are allowed
    only when they stay inside it. Symlink/path traversal that escapes the root,
    directories and missing files are all rejected, so a Qdrant point can never
    make the service read or trust an arbitrary file.
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
    return target


def _identity_matches(
    payload_size: int,
    payload_mtime_ns: int,
    disk_size: int,
    disk_mtime_ns: int,
) -> bool:
    """Compares the worker's recorded identity with the real file on disk.

    Size must match exactly. For mtime, a worker value truncated to whole
    seconds (SFTP stat resolution) is compared at second granularity; a
    full-resolution value is compared exactly.
    """
    if payload_size != disk_size:
        return False
    if payload_mtime_ns % _NS_PER_SECOND == 0:
        return payload_mtime_ns // _NS_PER_SECOND == disk_mtime_ns // _NS_PER_SECOND
    return payload_mtime_ns == disk_mtime_ns


def _server_result_is_current(
    track: Dict[str, Any],
    analysis_version: Optional[str],
    disk_size: int,
    disk_mtime_ns: int,
) -> bool:
    """True when SQLite already holds a valid result for the file on disk.

    This is the guard against overwriting a newer server-side analysis with a
    stale Qdrant result, and the idempotency gate for repeated passes. It only
    reports "current" when the stored metrics are finite, the analysis version
    matches the payload's, and the recorded analysis identity equals the real
    file identity — so a version upgrade or a partial row is never blocked.
    """
    if track.get("loudness_status") != "analyzed":
        return False
    if _finite_metric(track.get("loudness_lufs")) is None:
        return False
    if _finite_metric(track.get("true_peak_db")) is None:
        return False
    if _finite_metric(track.get("normalization_gain_db")) is None:
        return False
    if (track.get("loudness_analysis_version") or None) != (analysis_version or None):
        return False
    stored_size = _as_int(track.get("loudness_file_size"))
    stored_mtime = _as_int(track.get("loudness_file_mtime_ns"))
    if stored_size is None or stored_mtime is None:
        return False
    return stored_size == disk_size and stored_mtime == disk_mtime_ns


def _create_track_from_payload(
    track_id: str,
    payload: Dict[str, Any],
    rel_path: str,
    file_size: int,
    file_mtime_ns: int,
) -> None:
    """Creates a minimal catalog row for a Qdrant point with a verified file.

    The caller only reaches this after resolving and stat'ing a real file inside
    the music root, so no phantom track can be created for a missing file.
    """
    title = str(payload.get("title") or Path(rel_path).stem or track_id)
    artist = str(payload.get("artist") or "Неизвестный исполнитель")
    db.add_or_update_track(
        track_id,
        rel_path,
        title,
        None,
        artist,
        duration=payload.get("duration"),
        file_size=file_size,
        file_mtime_ns=file_mtime_ns,
    )


def _iter_qdrant_records(client):
    """Yields analyzed records page by page, raising on any Qdrant failure.

    Treating a read error as "no records" would silently report a successful
    pass while nothing was delivered; instead the whole pass is aborted and
    retried on the next tick.
    """
    offset = None
    seen_offsets = set()
    scroll_filter = Filter(
        must=[FieldCondition(key="loudness_status", match=MatchValue(value="analyzed"))]
    )
    for _ in range(MAX_SCROLL_PAGES):
        try:
            records, next_page = client.scroll(
                collection_name=COLLECTION_NAME,
                scroll_filter=scroll_filter,
                limit=SCROLL_PAGE_SIZE,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
        except Exception as exc:  # noqa: BLE001 - boundary: normalize client errors
            raise LoudnessSyncError(f"Не удалось прочитать Qdrant: {exc}") from exc

        for record in records:
            yield record

        if next_page is None:
            return
        key = str(next_page)
        if key in seen_offsets:
            logger.warning("Qdrant scroll вернул повторный offset %s, останавливаюсь", key)
            return
        seen_offsets.add(key)
        offset = next_page

    logger.warning("Qdrant scroll превысил %d страниц, останавливаюсь", MAX_SCROLL_PAGES)


def sync_loudness_from_qdrant(
    client,
    *,
    dry_run: bool = False,
    limit: Optional[int] = None,
    create_missing: bool = True,
    music_root: Optional[str] = None,
) -> Dict[str, Any]:
    """Delivers analyzed loudness results from Qdrant into the server SQLite.

    Only validated, disk-verified results are applied. ``dry_run`` computes the
    counters without writing. ``limit`` bounds the number of applied results per
    pass. Returns a counters dict for observability and the CLI.
    """
    counters = _empty_counters()
    counters["dry_run"] = bool(dry_run)
    root = music_root or get_effective_music_dir()

    for record in _iter_qdrant_records(client):
        counters["examined"] += 1
        payload = record.payload or {}
        if payload.get("loudness_status") != "analyzed":
            counters["skipped_not_analyzed"] += 1
            continue
        counters["analyzed"] += 1

        metrics = _validated_metrics(payload)
        if metrics is None:
            counters["skipped_invalid"] += 1
            continue

        track_id = str(record.id)
        track = db.get_track(track_id)
        if track is None and not create_missing:
            counters["skipped_missing_track"] += 1
            continue

        file_path = (track.get("file_path") if track else None) or payload.get("file_path")
        resolved = _resolve_audio_file(file_path, root)
        if resolved is None:
            counters["skipped_missing_file"] += 1
            continue
        try:
            stat = os.stat(resolved)
        except OSError:
            counters["skipped_missing_file"] += 1
            continue

        payload_size = _as_int(payload.get("loudness_file_size"))
        payload_mtime = _as_int(payload.get("loudness_file_mtime_ns"))
        if payload_size is None or payload_mtime is None:
            counters["skipped_unverifiable"] += 1
            continue
        if not _identity_matches(payload_size, payload_mtime, stat.st_size, stat.st_mtime_ns):
            counters["skipped_stale"] += 1
            continue

        analysis_version = payload.get("loudness_analysis_version")
        if track is not None and _server_result_is_current(
            track, analysis_version, stat.st_size, stat.st_mtime_ns
        ):
            counters["skipped_unchanged"] += 1
            continue

        counters["would_sync"] += 1
        if not dry_run:
            try:
                if track is None:
                    rel_path = os.path.relpath(resolved, os.path.realpath(root))
                    _create_track_from_payload(
                        track_id, payload, rel_path, stat.st_size, stat.st_mtime_ns
                    )
                    counters["created"] += 1
                db.update_track_loudness(
                    track_id=track_id,
                    loudness_lufs=metrics["loudness_lufs"],
                    true_peak_db=metrics["true_peak_db"],
                    normalization_gain_db=metrics["normalization_gain_db"],
                    status="analyzed",
                    analysis_version=analysis_version,
                    file_size=stat.st_size,
                    file_mtime_ns=stat.st_mtime_ns,
                )
                counters["synced"] += 1
            except Exception as exc:  # noqa: BLE001 - boundary: keep other tracks flowing
                counters["failed"] += 1
                logger.warning("Не удалось применить loudness для %s: %s", track_id, exc)

        if limit is not None and counters["would_sync"] >= limit:
            break

    if counters["synced"] or counters["created"] or counters["failed"]:
        logger.info("Синхронизация loudness из Qdrant: %s", counters)
    return counters


def run_loudness_sync(
    *,
    create_missing: bool = True,
    music_root: Optional[str] = None,
) -> Dict[str, Any]:
    """Creates a timeout-bounded client, runs one pass and always closes it.

    Meant to be executed in a worker thread by the API loop. Owning and closing
    the client inside this synchronous call avoids a cancellation/close race: a
    cancelled ``asyncio.to_thread`` task cannot close the client while the thread
    is still using it.
    """
    client = get_qdrant_client()
    try:
        return sync_loudness_from_qdrant(
            client, create_missing=create_missing, music_root=music_root
        )
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            try:
                close()
            except Exception as exc:  # noqa: BLE001 - close must never mask the pass
                logger.warning("Не удалось закрыть Qdrant-клиент: %s", exc)
