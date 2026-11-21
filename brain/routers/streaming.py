"""Streaming endpoints: raw audio files, embedded covers, dominant cover color."""
import logging
import os
import time
import uuid
from typing import Optional, Literal

import db
from auth import (
    MEDIA_TICKET_TTL_SECONDS,
    create_media_ticket_with_expiry,
    create_cover_ticket,
    get_cover_user,
    get_current_user,
    get_stream_user,
)
from config import get_effective_music_dir, DEFAULT_COVER_PATH, DEFAULT_COVER_COLOR
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from services.recommendation_service import client
from services.cover_extractor import extract_cover_bytes, extract_cover_preview, resize_cover_image, extract_dominant_hex
from config import COLLECTION_NAME

logger = logging.getLogger("puuk.streaming")

router = APIRouter(tags=["streaming"])


class MediaTicketRequest(BaseModel):
    track_id: str
    delivery: Literal['direct', 'cdn'] = 'direct'


class MediaTicketResponse(BaseModel):
    url: str
    expires_in: int
    expires_at: int
    delivery: Literal['direct', 'cdn']
    server_time: int
    content_version: str | None
    content_length: int | None
    download_binding: Literal['if-match', 'immutable-path'] | None
    delivery_epoch: str
    cache_for: int


@router.post('/api/media-ticket', response_model=MediaTicketResponse)
async def issue_media_ticket(payload: MediaTicketRequest, request: Request):
    from services.delivery_service import executor, issue
    return await executor.run(request,lambda deadline,cancel: issue(request,payload.track_id,payload.delivery,deadline,cancel))


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


@router.api_route('/api/stream/{track_id}', methods=['GET', 'HEAD'])
async def stream_track(track_id: str, request: Request):
    from services.delivery_service import executor, stream
    return await executor.run(request,lambda deadline,cancel: stream(request,track_id,deadline,cancel))


@router.api_route('/cdn/audio/{track_id}/{content_version}', methods=['GET', 'HEAD'])
async def protected_audio(track_id: str, content_version: str, request: Request):
    from services.delivery_service import executor, stream
    return await executor.run(request,lambda deadline,cancel: stream(request,track_id,deadline,cancel,content_version))


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


@router.post("/api/cover/{track_id}/ticket")
def issue_cover_ticket(track_id: uuid.UUID, response: Response, user: dict = Depends(get_current_user)):
    response.headers["Cache-Control"] = "no-store"
    return {"ticket": create_cover_ticket(user, str(track_id))}


@router.get("/api/cover/{track_id}")
def get_cover_art(
    track_id: str,
    request: Request,
    current_user: dict = Depends(get_cover_user),
    size: Optional[int] = Query(None, ge=128, le=1024),
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
    if size is not None:
        etag = etag[:-1] + f'-preview-{size}-jpeg82"'
    cache_headers = {"ETag": etag, "Cache-Control": _COVER_CACHE_CONTROL}

    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=cache_headers)

    file_path = _resolve_stream_file_path(track_id, db_track=db_track)

    if file_path and os.path.isfile(file_path):
        try:
            from services.telegram_import_service import album_cover, track_cover

            if db_track and db_track.get('album_id'):
                image_data, mime = album_cover(db_track['album_id'])
                if image_data:
                    if size is not None:
                        image_data, mime = resize_cover_image(image_data, size)
                    return Response(content=image_data, media_type=mime, headers=cache_headers)
            image_data, mime = track_cover(track_id)
            if image_data and size is not None:
                image_data, mime = resize_cover_image(image_data, size)
            if not image_data:
                image_data, mime = (extract_cover_preview(file_path, size, etag)
                                    if size is not None else extract_cover_bytes(file_path))
            if image_data:
                return Response(content=image_data, media_type=mime, headers=cache_headers)
        except Exception:
            pass

    # Если обложка отсутствует в файле, возвращаем дефолтную обложку
    if os.path.isfile(DEFAULT_COVER_PATH):
        if size is not None:
            with open(DEFAULT_COVER_PATH, 'rb') as source:
                image_data, mime = resize_cover_image(source.read(), size)
            return Response(content=image_data, media_type=mime, headers=cache_headers)
        return FileResponse(DEFAULT_COVER_PATH, media_type="image/jpeg", headers=cache_headers)

    raise HTTPException(status_code=404, detail="Обложка отсутствует в файле")


@router.get("/api/color/{track_id}")
def get_track_color(
    track_id: str,
    request: Request,
    current_user: dict = Depends(get_stream_user),
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
