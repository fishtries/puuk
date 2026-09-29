"""Streaming endpoints: raw audio files, embedded covers, dominant cover color."""
import os
import uuid
from typing import Optional

import db
from auth import get_current_user
from config import MUSIC_DIR, DEFAULT_COVER_PATH, DEFAULT_COVER_COLOR
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response
from services.recommendation_service import client
from services.cover_extractor import extract_cover_bytes, extract_dominant_hex
from config import COLLECTION_NAME

router = APIRouter(tags=["streaming"])


def _resolve_stream_file_path(track_id: str, raise_on_qdrant_error: bool = False) -> str | None:
    """
    SQLite-first file resolution with Qdrant fallback.

    raise_on_qdrant_error=True reproduces legacy /api/stream semantics (HTTP 500
    on Qdrant failure); cover/color endpoints historically swallowed the error
    and fell back to defaults.
    """
    file_path = None
    db_track = db.get_track(track_id)
    if db_track and db_track.get("file_path"):
        cand_path = db_track["file_path"]
        if not cand_path.startswith("/"):
            cand_path = os.path.join(MUSIC_DIR, os.path.basename(cand_path))
        if os.path.isfile(cand_path):
            file_path = cand_path

    if not file_path:
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[track_id],
                with_payload=True,
            )
            if records:
                cand_path = records[0].payload.get("file_path", "")
                if cand_path and not cand_path.startswith("/"):
                    cand_path = os.path.join(MUSIC_DIR, os.path.basename(cand_path))
                if cand_path and os.path.isfile(cand_path):
                    file_path = cand_path
        except Exception as e:
            if raise_on_qdrant_error:
                raise HTTPException(status_code=500, detail=str(e))

    return file_path


@router.get("/api/stream/{track_id}")
def stream_track(track_id: str, current_user: Optional[dict] = Depends(get_current_user)):
    """Стриминг аудиофайла по track_id (сначала быстрый поиск в SQLite)."""
    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный track_id")

    file_path = _resolve_stream_file_path(track_id, raise_on_qdrant_error=True)
    if not file_path or not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Файл трека не найден")

    from services.cover_extractor import get_media_type

    return FileResponse(
        path=file_path,
        media_type=get_media_type(file_path),
        filename=os.path.basename(file_path),
    )


@router.get("/api/cover/{track_id}")
def get_cover_art(track_id: str, current_user: Optional[dict] = Depends(get_current_user)):
    """Возвращает обложку трека из ID3-тегов файла или дефолтную обложку."""
    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный track_id")

    file_path = _resolve_stream_file_path(track_id)

    if file_path and os.path.isfile(file_path):
        try:
            image_data, mime = extract_cover_bytes(file_path)
            if image_data:
                return Response(content=image_data, media_type=mime)
        except Exception:
            pass

    # Если обложка отсутствует в файле, возвращаем дефолтную обложку
    if os.path.isfile(DEFAULT_COVER_PATH):
        return FileResponse(DEFAULT_COVER_PATH, media_type="image/jpeg")

    raise HTTPException(status_code=404, detail="Обложка отсутствует в файле")


@router.get("/api/color/{track_id}")
def get_track_color(track_id: str, current_user: Optional[dict] = Depends(get_current_user)):
    """Возвращает доминирующий цвет обложки в HEX-формате с кешированием в SQLite."""
    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный track_id")

    # 1. Проверяем наличие закешированного цвета в SQLite
    db_track = db.get_track(track_id)
    if db_track and db_track.get("cover_color"):
        return {"color": db_track["cover_color"]}

    file_path = None
    if db_track and db_track.get("file_path"):
        cand_path = db_track["file_path"]
        if not cand_path.startswith("/"):
            cand_path = os.path.join(MUSIC_DIR, os.path.basename(cand_path))
        if os.path.isfile(cand_path):
            file_path = cand_path

    if not file_path:
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[track_id],
                with_payload=True,
            )
            if records:
                cand_path = records[0].payload.get("file_path", "")
                if cand_path and not cand_path.startswith("/"):
                    cand_path = os.path.join(MUSIC_DIR, os.path.basename(cand_path))
                if os.path.isfile(cand_path):
                    file_path = cand_path
        except Exception:
            pass

    if file_path and os.path.isfile(file_path):
        try:
            hex_color = extract_dominant_hex(file_path)
            # Сохраняем в SQLite для мгновенного доступа без повторного расчета
            db.update_track_cover_color(track_id, hex_color)
            return {"color": hex_color}
        except Exception:
            pass

    return {"color": DEFAULT_COVER_COLOR}
