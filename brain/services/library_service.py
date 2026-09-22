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
                album_id = db.add_or_get_album(meta.album or "Неизвестный альбом", None)
                db.add_or_update_track(
                    track_id, rel_path, meta.title, album_id, meta.artist, meta.lyrics,
                    duration=meta.duration, genre=meta.genre
                )
                # Режим сканера: пустой жанр в файле не затирает жанр в БД (например,
                # выставленный вручную через редактор тегов).
                db.update_track_metadata_from_audio(track_id, meta, album_id, preserve_empty_genre=True)
            except Exception as e:
                print(f"[scan] Error scanning {file_path}: {e}")
                title, artist, album, lyrics, duration = extract_full_metadata(rel_path)
                album_id = db.add_or_get_album(album, None)
                db.add_or_update_track(track_id, rel_path, title, album_id, artist, lyrics, duration=duration)

            added += 1

    return {"status": "success", "tracks_scanned": added}
