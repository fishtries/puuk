"""Library scanning: walk MUSIC_DIR, extract tags, upsert tracks and albums into SQLite."""
import uuid
from pathlib import Path

import db
from config import get_effective_music_dir
from services.media_locations import extract_full_metadata

SUPPORTED_EXTENSIONS = {'.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'}


def scan_library():
    """Сканирует MUSIC_DIR, извлекает теги и заполняет базу SQLite."""
    from metadata import read_audio_metadata

    effective_music_dir = get_effective_music_dir()
    base_path = Path(effective_music_dir)

    if not base_path.exists() or not base_path.is_dir():
        raise FileNotFoundError("Music directory not found")

    added = 0
    for file_path in base_path.rglob("*"):
        if file_path.suffix.lower() in SUPPORTED_EXTENSIONS:
            rel_path = str(file_path.relative_to(base_path))
            track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
            try:
                meta = read_audio_metadata(str(file_path))
                # Идентичность альбома = (название, album_artist); без альбомного
                # артиста fallback на исполнителя трека — временное значение импорта.
                album_id = db.resolve_album(
                    meta.album,
                    album_artist=meta.album_artist or meta.artist,
                    year=meta.year,
                )
                db_track = db.get_track(track_id)
                file_changed = False
                if db_track:
                    old_size = db_track.get("file_size")
                    old_mtime = db_track.get("file_mtime_ns")
                    if (meta.file_size is not None and old_size is not None and old_size != meta.file_size) or \
                       (meta.file_mtime_ns is not None and old_mtime is not None and old_mtime != meta.file_mtime_ns):
                        file_changed = True

                db.add_or_update_track(
                    track_id, rel_path, meta.title, album_id, meta.artist, meta.lyrics,
                    duration=meta.duration, genre=meta.genre,
                    track_number=meta.track_number, disc_number=meta.disc_number,
                )
                # Режим сканера: пустой жанр в файле не затирает жанр в БД (например,
                # выставленный вручную через редактор тегов).
                db.update_track_metadata_from_audio(track_id, meta, album_id, preserve_empty_genre=True)

                if file_changed:
                    db.reset_track_loudness_pending(track_id, file_size=meta.file_size, file_mtime_ns=meta.file_mtime_ns)
            except Exception as e:
                print(f"[scan] Error scanning {file_path}: {e}")
                title, artist, album, lyrics, duration = extract_full_metadata(rel_path)
                album_id = db.resolve_album(album, album_artist=artist)
                db.add_or_update_track(track_id, rel_path, title, album_id, artist, lyrics, duration=duration)

            added += 1

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
                    rel_path = str(file_path.relative_to(base_path))
                    track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
                    if not db.get_track(track_id):
                        row = ensure_track_from_file(str(file_path), track_id=track_id)
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
