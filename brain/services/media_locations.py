"""Physical media location resolution: SQLite -> Qdrant fallback for track files."""
import os
from typing import Optional

import db
from config import MUSIC_DIR, COLLECTION_NAME
from services.recommendation_service import client


def resolve_existing_file_path(file_path_value: Optional[str]) -> Optional[str]:
    """
    Разрешает абсолютный путь аудиофайла из записи БД.
    Поддерживает абсолютные пути и относительные (basename внутри MUSIC_DIR).
    Возвращает None, если файла физически нет.
    """
    if not file_path_value:
        return None
    cand = file_path_value
    if not cand.startswith("/"):
        cand = os.path.join(MUSIC_DIR, os.path.basename(cand))
    return cand if os.path.isfile(cand) else None


def locate_track_file(track_id: str, fallback_to_qdrant: bool = True) -> Optional[str]:
    """
    Быстрый поиск пути файла по track_id: сначала SQLite, затем (опционально) payload Qdrant.
    Возвращает None, если файл нигде не найден.
    """
    file_path = None
    db_track = db.get_track(track_id)
    if db_track and db_track.get("file_path"):
        file_path = resolve_existing_file_path(db_track["file_path"])

    if not file_path and fallback_to_qdrant:
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[track_id],
                with_payload=True,
            )
            if records:
                file_path = resolve_existing_file_path(records[0].payload.get("file_path", ""))
        except Exception as e:
            print(f"[locate_track_file] Qdrant retrieve error for track {track_id}: {e}")

    return file_path


def locate_track_file_strict_candidates(db_file_path: Optional[str], track_id: str) -> Optional[str]:
    """
    Расширенный резолв для GPU-джобов: прямой путь -> MUSIC_DIR/rel -> MUSIC_DIR/basename -> Qdrant.
    """
    cand_path = db_file_path
    if cand_path:
        if os.path.isfile(cand_path):
            return cand_path
        resolved = os.path.join(MUSIC_DIR, cand_path)
        if os.path.isfile(resolved):
            return resolved
        resolved_base = os.path.join(MUSIC_DIR, os.path.basename(cand_path))
        if os.path.isfile(resolved_base):
            return resolved_base

    try:
        records = client.retrieve(
            collection_name=COLLECTION_NAME,
            ids=[track_id],
            with_payload=True,
        )
        if records:
            cand_path = records[0].payload.get("file_path", "")
            if cand_path:
                if os.path.isfile(cand_path):
                    return cand_path
                resolved = os.path.join(MUSIC_DIR, cand_path)
                if os.path.isfile(resolved):
                    return resolved
                resolved_base = os.path.join(MUSIC_DIR, os.path.basename(cand_path))
                if os.path.isfile(resolved_base):
                    return resolved_base
    except Exception as e:
        print(f"Qdrant retrieve error for track {track_id}: {e}")

    return None


def extract_full_metadata(file_path: str):
    """Извлекает (title, artist, album, lyrics, duration) с деградацией до имени файла."""
    try:
        from services.track_metadata_service import resolve_track_file_path
        from metadata import read_audio_metadata
        full_path, _ = resolve_track_file_path({"file_path": file_path})
        meta = read_audio_metadata(full_path)
        return (
            meta.title or os.path.splitext(os.path.basename(file_path))[0],
            meta.artist or "Неизвестный исполнитель",
            meta.album or "Неизвестный альбом",
            meta.lyrics,
            meta.duration
        )
    except Exception:
        name_without_ext = os.path.splitext(os.path.basename(file_path))[0]
        title_val = name_without_ext
        artist_val = "Неизвестный исполнитель"
        if " - " in name_without_ext:
            parts = name_without_ext.split(" - ", 1)
            title_val = parts[0].strip()
            artist_val = parts[-1].strip()
        return title_val, artist_val, "Неизвестный альбом", None, None
