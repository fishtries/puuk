"""Physical media location resolution: SQLite -> Qdrant fallback for track files."""
import os
import uuid
from typing import Optional

import db
from config import get_effective_music_dir, COLLECTION_NAME
from services.recommendation_service import client


def resolve_safe_music_file(path: Optional[str], music_dir: Optional[str] = None) -> Optional[str]:
    """
    Разрешает путь к файлу (абсолютный или относительный) и строго проверяет,
    что он находится внутри музыкальной директории (без Path Traversal) и существует на диске.
    Возвращает канонический абсолютный путь или None.
    """
    if not path or not isinstance(path, str) or not path.strip():
        return None
    base_dir = music_dir or get_effective_music_dir()
    try:
        root = os.path.realpath(base_dir)
        target = os.path.realpath(path if os.path.isabs(path) else os.path.join(root, path.lstrip("/")))
        if os.path.commonpath((root, target)) == root and os.path.isfile(target):
            return target
    except Exception:
        return None
    return None


def resolve_existing_file_path(file_path_value: Optional[str]) -> Optional[str]:
    """
    Разрешает абсолютный путь аудиофайла из записи БД или имени файла.
    Гарантирует, что путь валиден на диске и не выходит за пределы MUSIC_DIR.
    """
    if not file_path_value:
        return None
    cand = resolve_safe_music_file(file_path_value)
    if cand:
        return cand
    cand_base = resolve_safe_music_file(os.path.basename(file_path_value))
    if cand_base:
        return cand_base
    return None


def locate_track_file(track_id: str, fallback_to_qdrant: bool = True) -> Optional[str]:
    """
    Быстрый поиск пути файла по track_id: сначала SQLite, затем (опционально) payload Qdrant.
    Возвращает None, если файл нигде не найден или выходит за пределы MUSIC_DIR.
    """
    file_path = None
    db_track = db.get_track(track_id)
    if db_track and db_track.get("file_path"):
        file_path = resolve_existing_file_path(db_track["file_path"])

    if not file_path and fallback_to_qdrant and track_id and str(track_id).strip():
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[track_id],
                with_payload=True,
            )
            if records and records[0].payload:
                file_path = resolve_existing_file_path(records[0].payload.get("file_path", ""))
        except Exception as e:
            print(f"[locate_track_file] Qdrant retrieve error for track {track_id}: {e}")

    return file_path


def _resolve_music_file_candidates(cand_path: Optional[str]) -> Optional[str]:
    """Один путь -> три кандидата (abs, rel, basename), все строго внутри MUSIC_DIR."""
    if not cand_path:
        return None
    cand = resolve_safe_music_file(cand_path)
    if cand:
        return cand
    cand_rel = resolve_safe_music_file(os.path.join(get_effective_music_dir(), cand_path.lstrip("/")))
    if cand_rel:
        return cand_rel
    return resolve_safe_music_file(os.path.join(get_effective_music_dir(), os.path.basename(cand_path)))


def locate_track_file_strict_candidates(db_file_path: Optional[str], track_id: str) -> Optional[str]:
    """
    Резолв пути аудиофайла с проверкой принадлежности к MUSIC_DIR:
    db_file_path -> Qdrant payload (по track_id).
    """
    resolved = _resolve_music_file_candidates(db_file_path)
    if resolved:
        return resolved

    if track_id and str(track_id).strip():
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[track_id],
                with_payload=True,
            )
            if records and records[0].payload:
                return _resolve_music_file_candidates(records[0].payload.get("file_path", ""))
        except Exception as e:
            print(f"Qdrant retrieve error for track {track_id}: {e}")

    return None


def extract_full_metadata_with_genre(file_path: str):
    """Извлекает (title, artist, album, genre, lyrics, duration) с деградацией до имени файла."""
    try:
        from services.track_metadata_service import resolve_track_file_path
        from metadata import read_audio_metadata
        full_path, _ = resolve_track_file_path({"file_path": file_path})
        meta = read_audio_metadata(full_path)
        return (
            meta.title or os.path.splitext(os.path.basename(file_path))[0],
            meta.artist or "Неизвестный исполнитель",
            meta.album or "Неизвестный альбом",
            meta.genre,
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
        return title_val, artist_val, "Неизвестный альбом", None, None, None


def extract_full_metadata(file_path: str):
    """Извлекает (title, artist, album, lyrics, duration) с деградацией до имени файла."""
    title, artist, album, _genre, lyrics, duration = extract_full_metadata_with_genre(file_path)
    return title, artist, album, lyrics, duration


def ensure_track_from_file(file_path: str, track_id: Optional[str] = None) -> Optional[dict]:
    """
    Быстрое добавление/восстановление трека по известному файлу на диске без повторного обхода.
    Гарантирует отсутствие Path Traversal за пределы get_effective_music_dir().
    """
    safe_path = resolve_safe_music_file(file_path)
    if not safe_path:
        return None

    root = os.path.realpath(get_effective_music_dir())
    rel_path = os.path.relpath(safe_path, root)
    if not track_id:
        track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))

    db_track = db.get_track(track_id)
    if db_track:
        return db_track

    from metadata import read_audio_metadata
    try:
        meta = read_audio_metadata(safe_path)
        alb_id = (
            db.resolve_album(meta.album, album_artist=meta.album_artist or meta.artist, year=meta.year)
            if meta.album else None
        )
        db.add_or_update_track(
            track_id=track_id,
            file_path=rel_path,
            title=meta.title,
            album_id=alb_id,
            artist=meta.artist,
            lyrics=meta.lyrics,
            duration=meta.duration,
            genre=meta.genre,
            file_size=meta.file_size,
            file_mtime_ns=meta.file_mtime_ns,
            track_number=meta.track_number,
            disc_number=meta.disc_number,
        )
        db.update_track_metadata_from_audio(track_id, meta, alb_id, preserve_empty_genre=True)
        return db.get_track(track_id)
    except Exception as e:
        print(f"[ensure_track_from_file] Error registering {safe_path}: {e}")
        return None


def ensure_track_in_db(track_id: str, payload: Optional[dict] = None) -> Optional[dict]:
    """
    Гарантирует наличие трека в SQLite, восстанавливая его из Qdrant или с диска,
    если запись отсутствует. Устраняет 404/Not Found при стриминге/редактировании/лайках.
    """
    if not track_id or not str(track_id).strip():
        return None

    try:
        db_track = db.get_track(track_id)
        if db_track:
            return db_track
    except Exception as e:
        print(f"[ensure_track_in_db] DB read error for {track_id}: {e}")

    # 1. Если payload не передан явно, запрашиваем точку из Qdrant
    if payload is None:
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[track_id],
                with_payload=True,
            )
            if records and records[0].payload:
                payload = records[0].payload
        except Exception as e:
            print(f"[ensure_track_in_db] Qdrant retrieve error for track {track_id}: {e}")

    # 2. Восстановление по payload Qdrant + физическому файлу на диске
    if payload:
        raw_file_path = str(payload.get("file_path") or "")
        title = str(payload.get("title") or os.path.splitext(os.path.basename(raw_file_path))[0] or track_id)
        artist = str(payload.get("artist") or "Неизвестный исполнитель")
        album_title = payload.get("album") or payload.get("album_title")
        album_artist = payload.get("album_artist") or payload.get("albumartist")
        year = payload.get("year")

        # Payload уже получен выше — повторный retrieve не нужен:
        # recovery выполняет ровно один запрос к Qdrant.
        actual_path = _resolve_music_file_candidates(raw_file_path)
        if not actual_path:
            # Аудиофайл не найден безопасно внутри музыкальной директории.
            # Не создаём фиктивную запись в SQLite, чтобы не засорять базу
            # и не выдавать 200 на media-ticket для невоспроизводимых треков.
            return None

        meta = None
        try:
            from metadata import read_audio_metadata
            meta = read_audio_metadata(actual_path)
            file_stem = os.path.splitext(os.path.basename(actual_path))[0]
            if meta.title and meta.title != file_stem:
                title = meta.title
            if meta.artist and meta.artist != "Неизвестный исполнитель":
                artist = meta.artist
            if meta.album and meta.album != "Неизвестный альбом":
                album_title = meta.album
            if meta.album_artist:
                album_artist = meta.album_artist
            if meta.year:
                year = meta.year

            # Set resolved title and artist on meta so update_track_metadata_from_audio won't downgrade them
            meta.title = title
            meta.artist = artist
        except Exception as e:
            print(f"[ensure_track_in_db] Tag reading error for {actual_path}: {e}")

        album_id = (
            db.resolve_album(str(album_title), album_artist=(album_artist or artist) if album_title else None, year=year)
            if album_title else None
        )

        root = os.path.realpath(get_effective_music_dir())
        rel_db_path = os.path.relpath(actual_path, root)

        try:
            db.add_or_update_track(
                track_id=track_id,
                file_path=rel_db_path,
                title=title,
                album_id=album_id,
                artist=artist,
                lyrics=(meta.lyrics if meta else None) or payload.get("lyrics"),
                duration=(meta.duration if meta else None) or payload.get("duration"),
                genre=(meta.genre if meta else None) or payload.get("genre"),
                file_size=(meta.file_size if meta else None) or payload.get("file_size"),
                file_mtime_ns=(meta.file_mtime_ns if meta else None) or payload.get("file_mtime_ns"),
                track_number=meta.track_number if meta else None,
                disc_number=meta.disc_number if meta else None,
            )

            if meta:
                db.update_track_metadata_from_audio(track_id, meta, album_id, preserve_empty_genre=True)

            if payload.get("loudness_status") == "analyzed":
                try:
                    db.update_track_loudness(
                        track_id=track_id,
                        loudness_lufs=payload.get("loudness_lufs"),
                        true_peak_db=payload.get("true_peak_db"),
                        normalization_gain_db=payload.get("normalization_gain_db"),
                        status="analyzed",
                        analysis_version=payload.get("loudness_analysis_version"),
                        file_size=payload.get("loudness_file_size"),
                        file_mtime_ns=payload.get("loudness_file_mtime_ns"),
                    )
                except Exception as loud_err:
                    print(f"[ensure_track_in_db] Loudness sync warning: {loud_err}")

            return db.get_track(track_id)
        except Exception as insert_err:
            print(f"[ensure_track_in_db] DB insert error for {track_id}: {insert_err}")

    return None
