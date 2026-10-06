"""Streaming endpoints: raw audio files, embedded covers, dominant cover color."""
import logging
import os
import uuid
from typing import Optional

import db
from auth import (
    MEDIA_TICKET_TTL_SECONDS,
    create_media_ticket_with_expiry,
    get_cover_user,
    get_current_user,
    get_stream_user,
)
from config import MUSIC_DIR, DEFAULT_COVER_PATH, DEFAULT_COVER_COLOR
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from services.recommendation_service import client
from services.cover_extractor import extract_cover_bytes, extract_dominant_hex
from config import COLLECTION_NAME

logger = logging.getLogger("puuk.streaming")

router = APIRouter(tags=["streaming"])


class MediaTicketRequest(BaseModel):
    track_id: str


class MediaTicketResponse(BaseModel):
    url: str
    expires_in: int
    expires_at: int


@router.post("/api/media-ticket", response_model=MediaTicketResponse)
def issue_media_ticket(
    payload: MediaTicketRequest,
    current_user: dict = Depends(get_current_user),
):
    """
    Выдаёт короткоживущий media-тикет для стриминга одного трека.
    Веб получает его по Bearer (обычный fetch), затем <audio> играет
    /api/stream/{id}?mt=... напрямую — поток с Range вместо полной blob-загрузки.

    Трек проверяется в SQLite до выдачи: несуществующий/удалённый трек -> 404,
    чтобы клиенты не получали тикет, ведущий к бесполезному запросу стрима.
    """
    try:
        uuid.UUID(payload.track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный track_id")

    if not db.get_track(payload.track_id):
        raise HTTPException(status_code=404, detail="Трек не найден")

    ticket, expires_at = create_media_ticket_with_expiry(current_user, payload.track_id)
    return MediaTicketResponse(
        url=f"/api/stream/{payload.track_id}?mt={ticket}",
        expires_in=MEDIA_TICKET_TTL_SECONDS,
        expires_at=expires_at,
    )


def _resolve_db_file_path(db_track: dict) -> Optional[str]:
    """SQLite file_path -> абсолютный/относительный путь, валидный на диске."""
    cand_path = db_track.get("file_path")
    if not cand_path:
        return None
    if not cand_path.startswith("/"):
        cand_path = os.path.join(MUSIC_DIR, os.path.basename(cand_path))
    return cand_path


def _resolve_stream_file_path(
    track_id: str,
    raise_on_qdrant_error: bool = False,
    db_track: Optional[dict] = None,
) -> str | None:
    """
    SQLite-first file resolution with Qdrant fallback.

    raise_on_qdrant_error=True reproduces legacy /api/stream semantics (HTTP 500
    on Qdrant failure); cover/color endpoints historically swallowed the error
    and fell back to defaults. db_track lets callers reuse an already loaded row.

    Внимание: /api/stream этот хелпер больше не использует — стриминг идёт
    только по SQLite (см. stream_track). Fallback остаётся для cover/color.
    """
    file_path = None
    if db_track is None:
        db_track = db.get_track(track_id)
    if db_track:
        cand_path = _resolve_db_file_path(db_track)
        if cand_path and os.path.isfile(cand_path):
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
def stream_track(track_id: str, current_user: dict = Depends(get_stream_user)):
    """
    Стриминг аудиофайла по track_id.

    Критический путь воспроизведения: только SQLite (tracks.file_path ->
    os.path.isfile -> FileResponse с поддержкой Range/206). Qdrant в путь
    стриминга не вовлекается — временный сбой Qdrant не должен ломать
    воспроизведение уже просканированной библиотеки.
    """
    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный track_id")

    db_track = db.get_track(track_id)
    file_path = _resolve_db_file_path(db_track) if db_track else None

    if not file_path or not os.path.isfile(file_path):
        if db_track:
            logger.warning(
                "stream: track %s in DB but file missing on disk: %s",
                track_id,
                file_path or db_track.get("file_path"),
            )
        raise HTTPException(status_code=404, detail="Файл трека не найден")

    from services.cover_extractor import get_media_type

    return FileResponse(
        path=file_path,
        media_type=get_media_type(file_path),
        filename=os.path.basename(file_path),
    )


_COVER_CACHE_CONTROL = "private, max-age=86400"


def _cover_etag(track_id: str, db_track: Optional[dict]) -> str:
    """
    ETag обложки. cover_version меняется при замене/удалении арта в тегах,
    file_mtime_ns — при внешней замене файла: сканер и resync обновляют его
    в БД (repositories/tracks.py), поэтому 304 не переживает смену файла.
    """
    version = (db_track or {}).get("cover_version") or 0
    mtime_ns = (db_track or {}).get("file_mtime_ns") or 0
    return f'"{track_id}-{version}-{mtime_ns}"'


def _etag_matches(if_none_match: Optional[str], etag: str) -> bool:
    if not if_none_match:
        return False
    candidates = [candidate.strip() for candidate in if_none_match.split(",")]
    return etag in candidates or "*" in candidates


@router.get("/api/cover/{track_id}")
def get_cover_art(
    track_id: str,
    request: Request,
    current_user: dict = Depends(get_cover_user),
):
    """
    Возвращает обложку трека из ID3-тегов файла или дефолтную обложку.

    Ответ помечен ETag (по cover_version) и Cache-Control: при повторных
    запросах браузер отвечает If-None-Match и получает 304 без парсинга
    аудиофайла; `?v=` в URL (из serialize_track) сбрасывает кэш при смене арта.
    """
    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный track_id")

    db_track = db.get_track(track_id)
    etag = _cover_etag(track_id, db_track)
    cache_headers = {"ETag": etag, "Cache-Control": _COVER_CACHE_CONTROL}

    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=cache_headers)

    file_path = _resolve_stream_file_path(track_id, db_track=db_track)

    if file_path and os.path.isfile(file_path):
        try:
            image_data, mime = extract_cover_bytes(file_path)
            if image_data:
                return Response(content=image_data, media_type=mime, headers=cache_headers)
        except Exception:
            pass

    # Если обложка отсутствует в файле, возвращаем дефолтную обложку
    if os.path.isfile(DEFAULT_COVER_PATH):
        return FileResponse(DEFAULT_COVER_PATH, media_type="image/jpeg", headers=cache_headers)

    raise HTTPException(status_code=404, detail="Обложка отсутствует в файле")


@router.get("/api/color/{track_id}")
def get_track_color(
    track_id: str,
    request: Request,
    current_user: dict = Depends(get_cover_user),
):
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
