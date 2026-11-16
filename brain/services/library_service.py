"""Library scanning: walk MUSIC_DIR, extract tags, upsert tracks and albums into SQLite."""
import uuid
from pathlib import Path

import db
from config import get_effective_music_dir
from services.media_locations import resolve_import_album
from repositories.artist_credits import audio_artist_source

SUPPORTED_EXTENSIONS = {'.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus'}


def scan_library():
    """Сканирует MUSIC_DIR, извлекает теги и заполняет базу SQLite."""
    from metadata import read_audio_metadata

    effective_music_dir = get_effective_music_dir()
    base_path = Path(effective_music_dir)

    if not base_path.exists() or not base_path.is_dir():
        raise FileNotFoundError("Music directory not found")

    from services.media_locations import ingest_music_file
    added = 0
    for file_path in base_path.rglob("*"):
        if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_EXTENSIONS:
            try:
                row = ingest_music_file(str(file_path), source='import')
                if row:
                    added += 1
            except Exception:
                print('[scan] ingest_failed')

    result = {"status": "success", "tracks_scanned": added}
    queue_counters = _deliver_embedding_queue()
    if queue_counters is not None:
        result["embedding_queue"] = queue_counters
    return result


def _deliver_embedding_queue():
    """Best-effort: queue catalog tracks that are missing a Qdrant queue point.

    A Qdrant outage must never fail the scan: the error is logged and the
    periodic reconciliation retries on a later pass.
    """
    from services.embedding_queue_service import (
        get_qdrant_client,
        is_queue_delivery_enabled,
        reconcile_embedding_queue,
    )

    if not is_queue_delivery_enabled():
        return None
    try:
        return reconcile_embedding_queue(get_qdrant_client())
    except Exception as e:
        print(f"[scan] Не удалось поставить задания ML в Qdrant: {e}")
        return None


def sync_missing_tracks_to_db() -> dict:
    """
    Фоновая сверка: добавляет в SQLite треки, существующие в Qdrant или на диске,
    но отсутствующие в puuk.db. Гарантирует целостность базы без полного пересканирования.
    """
    from services.media_locations import ensure_track_in_db, ensure_track_from_file, client
    from config import COLLECTION_NAME

    synced_qdrant = 0
    synced_disk = 0

    # 1. Синхронизация точек из Qdrant
    try:
        offset = None
        while True:
            records, next_page = client.scroll(
                collection_name=COLLECTION_NAME,
                limit=250,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            for record in records:
                point_id = str(record.id)
                if not db.get_track(point_id):
                    row = ensure_track_in_db(point_id, record.payload)
                    if row:
                        synced_qdrant += 1
            if next_page is None:
                break
            offset = next_page
    except Exception as e:
        print(f"[sync_missing_tracks_to_db] Qdrant scroll warning: {e}")

    # 2. Быстрая проверка новых файлов на диске
    try:
        effective_music_dir = get_effective_music_dir()
        base_path = Path(effective_music_dir)
        if base_path.exists() and base_path.is_dir():
            for file_path in base_path.rglob("*"):
                if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_EXTENSIONS:
                    row = ensure_track_from_file(str(file_path))
                    if row:
                        synced_disk += 1
    except Exception as e:
        print(f"[sync_missing_tracks_to_db] Disk check warning: {e}")

    if synced_qdrant or synced_disk:
        print(f"[sync_missing_tracks_to_db] Восстановлено: {synced_qdrant} из Qdrant, {synced_disk} с диска")

    return {
        "status": "success",
        "synced_from_qdrant": synced_qdrant,
        "synced_from_disk": synced_disk,
    }
