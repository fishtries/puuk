"""Track deletion service: RBAC, strict file resolution, Qdrant + file + SQLite cleanup.

Порядок удаления: Qdrant-вектор -> аудиофайл -> строка SQLite -> пустые альбомы.
Сбой на любом шаге останавливает операцию до необратимых изменений: пока жив
аудиофайл, повторный скан восстанавливает состояние библиотеки.
"""

import os
from typing import Dict, Any, List, Optional

from fastapi import HTTPException

from qdrant_client.models import PointIdsList

import db
from config import get_effective_music_dir, COLLECTION_NAME
from metadata import track_mutation_lock, validate_safe_path
from services.recommendation_service import client as qdrant_client
from services.track_metadata_service import check_track_edit_permissions


def _temp_audio_dir() -> str:
    return os.path.realpath(
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "temp_audio")
    )


def _deletion_roots() -> List[str]:
    """Разрешённые корни, внутри которых допустимо удалять файлы."""
    roots = [get_effective_music_dir()]
    temp_audio = _temp_audio_dir()
    if os.path.isdir(temp_audio) and temp_audio not in roots:
        roots.append(temp_audio)
    return roots


def _is_inside_roots(real_path: str, roots: List[str]) -> bool:
    for root in roots:
        real_root = os.path.realpath(root)
        if real_path == real_root or real_path.startswith(real_root + os.sep):
            return True
    return False


def _collect_deletion_candidates(db_file_path: Optional[str], roots: List[str]) -> List[str]:
    """
    Строгий резолв файла для удаления: точный относительный путь, затем basename
    внутри разрешённых корней. Возвращает уникальные существующие совпадения;
    больше одного совпадения — вызывающий код отменяет удаление (409).
    Абсолютный путь из БД допускается только внутри разрешённых корней.
    """
    found: List[str] = []
    rel = (db_file_path or "").strip()
    if not rel:
        return found

    if os.path.isabs(rel):
        real = os.path.realpath(rel)
        if os.path.isfile(real) and _is_inside_roots(real, roots):
            found.append(real)
        return found

    if ".." in rel:
        return found

    for root in roots:
        try:
            candidate = validate_safe_path(rel, root)
        except (PermissionError, ValueError):
            continue
        if os.path.isfile(candidate) and candidate not in found:
            found.append(candidate)
    if found:
        return found

    basename = os.path.basename(rel)
    for root in roots:
        try:
            candidate = validate_safe_path(basename, root)
        except (PermissionError, ValueError):
            continue
        if os.path.isfile(candidate) and candidate not in found:
            found.append(candidate)
    return found


def delete_track_everywhere(track_id: str, current_user: Dict[str, Any]) -> Dict[str, Any]:
    """
    Полное удаление трека: вектор Qdrant, аудиофайл, строка SQLite и опустевшие альбомы.
    Права: администратор или владелец (added_by_user_id).
    Отсутствующий на диске файл не блокирует удаление устаревшей записи (file_deleted=False).
    """
    db_track = db.get_track(track_id)
    if not db_track:
        raise HTTPException(status_code=404, detail="Трек не найден")

    check_track_edit_permissions(db_track, current_user)

    roots = _deletion_roots()
    candidates = _collect_deletion_candidates(db_track.get("file_path"), roots)
    if len(candidates) > 1:
        raise HTTPException(
            status_code=409,
            detail="Найдено несколько файлов с совпадающим именем; удаление отменено для безопасности",
        )

    # Вектор удаляем первым: если Qdrant недоступен, файл и запись БД остаются на месте.
    try:
        qdrant_client.delete(
            collection_name=COLLECTION_NAME,
            points_selector=PointIdsList(points=[track_id]),
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Не удалось удалить вектор из Qdrant: {e}")

    file_deleted = False
    target = candidates[0] if candidates else None
    with track_mutation_lock(track_id, get_effective_music_dir()):
        if target:
            try:
                os.remove(target)
                file_deleted = True
            except OSError as e:
                raise HTTPException(status_code=500, detail=f"Не удалось удалить аудиофайл: {e}")

    db.delete_track(track_id)
    db.delete_empty_albums()

    return {"status": "success", "file_deleted": file_deleted}
