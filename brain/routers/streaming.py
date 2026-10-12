"""Streaming endpoints: raw audio files, embedded covers, dominant cover color."""
import logging
import os
import time
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
from config import get_effective_music_dir, DEFAULT_COVER_PATH, DEFAULT_COVER_COLOR
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

    Трек проверяется до выдачи: обычный путь — SQLite; при отсутствии записи
    допускается одна попытка восстановления из Qdrant (файл должен существовать
    внутри музыкального каталога). Несуществующий/удалённый/невоспроизводимый
    трек -> 404, чтобы клиенты не получали тикет, ведущий к бесполезному запросу.
    """
    try:
        uuid.UUID(payload.track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный track_id")

    track = db.get_track(payload.track_id)
    if not track:
        track = _recover_missing_track(payload.track_id, "media-ticket")
    if not track:
        raise HTTPException(status_code=404, detail="Трек не найден")

    if not _resolve_db_file_path(track):
        raise HTTPException(status_code=404, detail="Файл трека не найден")

    ticket, expires_at = create_media_ticket_with_expiry(current_user, payload.track_id)
    return MediaTicketResponse(
        url=f"/api/stream/{payload.track_id}?mt={ticket}",
        expires_in=MEDIA_TICKET_TTL_SECONDS,
        expires_at=expires_at,
    )


def _resolve_db_file_path(db_track: dict) -> Optional[str]:
    """SQLite file_path -> абсолютный путь к файлу внутри MUSIC_DIR."""
    from services.media_locations import resolve_safe_music_file
    cand_path = db_track.get("file_path")
    if not cand_path:
        return None
    safe = resolve_safe_music_file(cand_path)
    if safe:
        return safe
    rel = cand_path.lstrip("/")
    safe_rel = resolve_safe_music_file(os.path.join(get_effective_music_dir(), rel))
    if safe_rel:
        return safe_rel
    safe_base = resolve_safe_music_file(os.path.join(get_effective_music_dir(), os.path.basename(cand_path)))
    if safe_base:
        return safe_base
    return None


def _recover_missing_track(track_id: str, source: str) -> Optional[dict]:
    """Run the Qdrant recovery path only after an SQLite cache miss."""
    from services.media_locations import ensure_track_in_db

    started_at = time.perf_counter()
    track = ensure_track_in_db(track_id)
    logger.info(
        "track recovery completed source=%s track_id=%s recovered=%s duration_ms=%.2f",
        source,
        track_id,
        bool(track),
        (time.perf_counter() - started_at) * 1000,
    )
    return track


def _resolve_stream_file_path(
    track_id: str,
    raise_on_qdrant_error: bool = False,
    db_track: Optional[dict] = None,
) -> str | None:
    """
    SQLite-first file resolution with safe path check and Qdrant fallback.
    """
    from services.media_locations import resolve_safe_music_file
    file_path = None
    if db_track is None:
        db_track = db.get_track(track_id)
    if db_track:
        cand_path = _resolve_db_file_path(db_track)
        if cand_path:
            file_path = cand_path

    if not file_path:
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[track_id],
                with_payload=True,
            )
            if records and records[0].payload:
                cand_path = records[0].payload.get("file_path", "")
                if cand_path:
                    safe = resolve_safe_music_file(cand_path)
                    if safe:
                        file_path = safe
                    else:
                        safe_base = resolve_safe_music_file(os.path.join(get_effective_music_dir(), os.path.basename(cand_path)))
                        if safe_base:
                            file_path = safe_base
        except Exception as e:
            if raise_on_qdrant_error:
                raise HTTPException(status_code=500, detail=str(e))

    return file_path


@router.get("/api/stream/{track_id}")
def stream_track(track_id: str, current_user: dict = Depends(get_stream_user)):
    """
    Стриминг аудиофайла по track_id.
    Обычный путь читает SQLite и локальный файл; Qdrant используется только для
    восстановления записи при SQLite cache miss.
    """
    try:
        uuid.UUID(track_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный track_id")

    started_at = time.perf_counter()
    db_track = db.get_track(track_id)
    recovery_path = not db_track
    if not db_track:
        db_track = _recover_missing_track(track_id, "stream")

    file_path = _resolve_db_file_path(db_track) if db_track else None
    logger.info(
        "stream file resolution completed path=%s track_id=%s found=%s duration_ms=%.2f",
        "recovery" if recovery_path else "sqlite",
        track_id,
        bool(file_path and os.path.isfile(file_path)),
        (time.perf_counter() - started_at) * 1000,
    )

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
        file_path = _resolve_db_file_path(db_track)

    if not file_path:
        try:
            records = client.retrieve(
                collection_name=COLLECTION_NAME,
                ids=[track_id],
                with_payload=True,
            )
            if records and records[0].payload:
                cand_path = records[0].payload.get("file_path", "")
                if cand_path:
                    from services.media_locations import resolve_safe_music_file

                    music_dir = get_effective_music_dir()
                    file_path = resolve_safe_music_file(cand_path, music_dir)
                    if not file_path:
                        file_path = resolve_safe_music_file(
                            os.path.join(music_dir, os.path.basename(cand_path)), music_dir
                        )
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
