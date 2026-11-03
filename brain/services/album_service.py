"""Album application service: catalog DTOs, detail envelope, whole-release editing.

Редактирование альбома — операция над всем релизом: новые значения
title/album_artist/year записываются в ID3-теги всех треков (product decision),
после чего обновляется запись альбома. Смена обложки применяется ко всем трекам.
"""
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from repositories.artist_credits import hydrate_album_credits, hydrate_track_credits

from fastapi import HTTPException

import db
from repositories.albums import UNCHANGED
from serializers import serialize_track
from services.artist_credit_lock import serialize_artist_credit_mutation
from services.track_metadata_service import (
    check_track_edit_permissions,
    mutate_track_metadata,
    prepare_cover_bytes,
)


def serialize_album(row: Dict[str, Any], base_url: str) -> Dict[str, Any]:
    """Единый Album DTO для каталога, поиска и detail.

    `album_artist` — как хранится (может быть пустым), `artist` — display-значение
    с fallback "Various Artists" (совместимо с клиентскими типами).
    `artist_id` — единственное место, где он выводится для альбомных DTO;
    берётся из фактического исполнителя альбома и не подменяется ярлыком
    "Various Artists" (иначе compilation получил бы несуществующего артиста).
    """
    cover_id = row.get("cover_track_id")
    stored_artist = row.get("album_artist") or ""
    return {
        "id": row["id"],
        "title": row["title"],
        "album_artist": stored_artist,
        "artist_id": row.get("artist_id"),
        "artists": row.get("artists", []),
        "artists_revision": row.get("artists_revision", 0),
        "artist": stored_artist or db.VARIOUS_ARTISTS,
        "year": row.get("year"),
        "track_count": row.get("track_count") or 0,
        "total_duration": row.get("total_duration") or 0.0,
        "cover_id": str(cover_id) if cover_id else None,
        "coverArt": f"{base_url}/api/cover/{cover_id}" if cover_id else None,
    }


def get_albums_catalog(base_url: str) -> List[Dict[str, Any]]:
    return [serialize_album(row, base_url) for row in db.get_albums_catalog_rows()]


def get_album_detail(album_id: int, current_user: Optional[Dict[str, Any]], base_url: str) -> Dict[str, Any]:
    """Detail-конверт: {"album": AlbumDTO, "tracks": TrackDTO[]}.

    Несуществующий альбом — 404 (не молчаливый пустой список); существующий,
    но опустевший альбом честно возвращается с пустым tracks.
    """
    album = db.get_album(album_id)
    if not album:
        raise HTTPException(status_code=404, detail="Album not found")

    album = hydrate_album_credits([album])[0]
    track_rows = db.get_album_tracks(album_id)
    fav_ids = db.get_favorite_track_ids(current_user["id"]) if current_user else set()

    dto = serialize_album(
        {
            **album,
            "track_count": len(track_rows),
            "total_duration": sum(t.get("duration") or 0.0 for t in track_rows),
            "cover_track_id": track_rows[0]["id"] if track_rows else None,
        },
        base_url,
    )
    tracks = [serialize_track(r, base_url, fav_ids, include_lyrics=False) for r in track_rows]
    return {"album": dto, "tracks": tracks}


def _normalize_year(value: Any) -> Optional[str]:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _split_album(source_id: int, title: str, artist: str, year: Any, track_ids: list[str]) -> int:
    """Create a split release, copy its manual decision, and move successful tracks atomically."""
    from repositories.albums import normalize_text
    from repositories.artist_credits import (CreditSource, get_credit_states, ingest_artist_credits,
        replace_artist_credits)
    from repositories.base import bump_catalog_version

    conn = db.get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        source = get_credit_states('album', [source_id], conn=conn)[str(source_id)]
        row = conn.execute("SELECT id FROM albums WHERE title_normalized=? AND album_artist_normalized=?",
                           (normalize_text(title), normalize_text(artist))).fetchone()
        if row:
            target_id = row['id']
        else:
            target_id = conn.execute("""INSERT INTO albums
                (title, album_artist, year, title_normalized, album_artist_normalized)
                VALUES (?, ?, ?, ?, ?)""", (title, artist or None, year,
                normalize_text(title), normalize_text(artist))).lastrowid
            ingest_artist_credits(conn, 'album', target_id, CreditSource(source['source_kind'], source['source_names']))
        if target_id != source_id and source['manual']:
            target = get_credit_states('album', [target_id], conn=conn)[str(target_id)]
            if target['manual'] and target['artists'] != source['artists']:
                raise HTTPException(409, detail={'code': 'album_credits_conflict', 'message': 'Составы альбомов конфликтуют'})
            replace_artist_credits(conn, 'album', target_id,
                [{'id': item['id']} for item in source['artists']], expected_revision=target['revision'])
        for offset in range(0, len(track_ids), 400):
            chunk = track_ids[offset:offset + 400]
            marks = ','.join('?' for _ in chunk)
            conn.execute(f'UPDATE tracks SET album_id=? WHERE id IN ({marks})', (target_id, *chunk))
            conn.execute(f"UPDATE artist_credit_state SET recovery_album_id=? WHERE entity_type='track' AND entity_id IN ({marks})", (target_id, *chunk))
        bump_catalog_version(conn)
        conn.commit()
        return target_id
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@serialize_artist_credit_mutation
def update_album(album_id: int, payload, current_user: Dict[str, Any], base_url: str) -> Dict[str, Any]:
    """PATCH /api/albums/{id}: правка релиза целиком.

    Порядок операций защитывает от «частичного успеха»:
    1. валидация прав на ВСЕ треки до любых изменений;
    2. запись файлов (каждый трек через mutate_track_metadata: lock, journal,
       safe replace, DB-sync трека) со сбором ошибок по треку;
    3. только после файлов — обновление записи альбома, merge идентичности
       и очистка осиротевших альбомов.
    """
    album = db.get_album(album_id)
    if not album:
        raise HTTPException(status_code=404, detail="Album not found")

    from repositories.artist_credits import normalize_artist_name, artist_id_for_name
    from services.artist_credit_service import set_album_artists
    hydrated = hydrate_album_credits([album])[0]
    track_rows = db.get_album_tracks(album_id)
    if not track_rows and current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав")
    conn = db.get_connection()
    try:
        permission_rows = conn.execute("SELECT id, added_by_user_id FROM tracks WHERE album_id = ?", (album_id,)).fetchall()
        for t in permission_rows:
            check_track_edit_permissions(dict(t), current_user)
    finally:
        conn.close()
    fs = set(getattr(payload, "model_fields_set", set()))
    changed = set()
    for field in fs & {"title", "year"}:
        value, old = getattr(payload, field, None), album.get(field)
        if ("" if value is None else str(value).strip()) != ("" if old is None else str(old).strip()):
            changed.add(field)
    if getattr(payload, "cover_action", "keep") != "keep" or getattr(payload, "cover_base64", None) or getattr(payload, "cover_url", None):
        changed.add("cover_action")
    if "album_artist" in fs:
        value = normalize_artist_name(getattr(payload, "album_artist", None))
        if value not in {normalize_artist_name(hydrated.get("album_artist")), normalize_artist_name(album.get("album_artist"))}:
            if len(hydrated.get("artists", [])) > 1:
                raise HTTPException(409, detail={"code": "structured_artists_required", "message": "Используйте редактор состава"})
            if changed:
                raise HTTPException(409, detail={"code": "artists_edit_separately", "message": "Измените состав отдельно"})
            selectors = [{"name": value}] if artist_id_for_name(value) else []
            detail = set_album_artists(album_id, selectors, hydrated["artists_revision"], current_user, base_url)
            return {"status": "success", "changed": True, "merged": False, "failed_tracks": [], **detail}
    fs.discard("album_artist")
    if not changed:
        return {"status": "success", "changed": False, "merged": False, "failed_tracks": [], **get_album_detail(album_id, current_user, base_url)}
    if not track_rows:
        raise HTTPException(status_code=400, detail="Album has no tracks")

    new_title = album["title"]
    if "title" in fs:
        candidate = (payload.title or "").strip()
        if not candidate:
            raise HTTPException(status_code=400, detail="Album title cannot be empty")
        new_title = candidate

    new_artist = album["album_artist"] or ""
    if "album_artist" in fs:
        new_artist = (payload.album_artist or "").strip()

    new_year = album["year"]
    if "year" in fs:
        new_year = _normalize_year(payload.year)

    cover_action = getattr(payload, "cover_action", "keep") or "keep"

    # Идентичность (title, album_artist): конфликт с существующим альбомом
    # означает merge — треки переезжают в уже существующую запись.
    existing = db.find_album_by_identity(new_title, new_artist)
    merge_mode = bool(existing and existing["id"] != album_id)
    canonical_id = existing["id"] if merge_mode else album_id
    if merge_mode:
        from repositories.artist_credits import merge_album_credits, AlbumCreditsConflict
        conn = db.get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            merge_album_credits(conn, album_id, canonical_id)
            conn.rollback()
        except AlbumCreditsConflict:
            conn.rollback()
            raise HTTPException(409, detail={"code": "album_credits_conflict", "message": "Составы альбомов конфликтуют"})
        finally:
            conn.close()

    prepare_cover_bytes(cover_action, getattr(payload, "cover_base64", None), getattr(payload, "cover_url", None))

    album_fields = {"album" if name == "title" else name for name in fs} & {"album", "album_artist", "year"}

    if not album_fields and cover_action == "keep":
        # В файлы писать нечего. Merge-only — переносим треки на уровне БД.
        if merge_mode:
            db.rebind_tracks_to_album([t["id"] for t in track_rows], canonical_id)
            db.merge_album_into(album_id, canonical_id)
            db.update_album_fields(canonical_id, year=new_year if "year" in fs else UNCHANGED)
            db.delete_empty_albums()
        else:
            db.update_album_fields(
                album_id,
                title=new_title if "title" in fs else None,
                album_artist=new_artist if "album_artist" in fs else None,
                year=new_year if "year" in fs else UNCHANGED,
            )
        detail = get_album_detail(canonical_id if merge_mode else album_id, current_user, base_url)
        return {"status": "success", "changed": True, "merged": merge_mode, "failed_tracks": [], **detail}

    track_payload = SimpleNamespace(
        model_fields_set=album_fields,
        title=None,
        artist=None,
        album=new_title,
        album_artist=new_artist,
        year=new_year,
        genre=None,
        track_number=None,
        disc_number=None,
        album_track_position=None,
        comment=None,
        lyrics=None,
        cover_action=cover_action,
        cover_base64=getattr(payload, "cover_base64", None),
        cover_url=getattr(payload, "cover_url", None),
        cover_mime=None,
    )

    succeeded: List[str] = []
    failed: List[Dict[str, Any]] = []
    for t in track_rows:
        try:
            mutate_track_metadata(
                t["id"], track_payload, current_user, base_url, target_album_id=canonical_id
            )
            succeeded.append(t["id"])
        except Exception as e:  # noqa: BLE001 — ошибка одного файла не валит релиз
            failed.append({"track_id": t["id"], "title": t.get("title"), "error": str(e)})

    if failed and not succeeded:
        raise HTTPException(
            status_code=500,
            detail=f"Не удалось обновить ни один трек альбома: {failed[0]['error']}",
        )

    # Инвариант: album_id каждого трека должен соответствовать его фактическим
    # тегам на диске. При частичном сбое успешные и упавшие треки расходятся по
    # идентичности, поэтому их нельзя оставлять в одной записи альбома.
    result_album_id = album_id
    if not failed:
        # Полный успех.
        if merge_mode:
            # Идентичность совпадает с целевой записью — её title/album_artist не трогаем.
            db.update_album_fields(canonical_id, year=new_year if "year" in fs else UNCHANGED)
            db.merge_album_into(album_id, canonical_id)
            result_album_id = canonical_id
        else:
            db.update_album_fields(
                album_id,
                title=new_title if "title" in fs else None,
                album_artist=new_artist if "album_artist" in fs else None,
                year=new_year if "year" in fs else UNCHANGED,
            )
    elif merge_mode:
        # Частичный успех при merge: упавшие треки остались в исходной записи со
        # старыми тегами, успешные уже перепривязаны к canonical_id. merge отложен.
        _split_album(album_id, new_title, new_artist, new_year, succeeded)
        db.update_album_fields(canonical_id, year=new_year if "year" in fs else UNCHANGED)
        result_album_id = canonical_id
    else:
        # Частичный успех без merge: успешные треки сейчас в исходной записи
        # (старая идентичность), упавшие — там же. Разводим их по идентичности:
        # успешные -> новый альбом с новой идентичностью, упавшие остаются в
        # исходном (старая идентичность, старые теги).
        new_album_id = _split_album(album_id, new_title, new_artist, new_year, succeeded)
        result_album_id = new_album_id

    db.delete_empty_albums()

    detail = get_album_detail(result_album_id, current_user, base_url)
    return {
        "status": "partial" if failed else "success",
        "changed": True,
        "merged": merge_mode and not failed,
        "failed_tracks": failed,
        **detail,
    }


def get_album_identities_conflict(album_id: int, title: str, album_artist: str) -> Optional[Dict[str, Any]]:
    """Публичный предпросмотр конфликта идентичности (для UI-подтверждения merge)."""
    existing = db.find_album_by_identity(title, album_artist)
    if existing and existing["id"] != album_id:
        return {"album_id": existing["id"], "title": existing["title"]}
    return None
