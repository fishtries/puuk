"""Transactional, database-only artist credit edits."""
import sqlite3
from fastapi import HTTPException
from repositories.base import get_connection, bump_catalog_version
from repositories.artist_credits import (CreditConflict, CreditNotFound, CreditValidationError,
    get_credit_states, replace_artist_credits, hydrate_track_credits)
from serializers import serialize_track
from services.artist_credit_lock import serialize_artist_credit_mutation
from services.track_metadata_service import check_track_edit_permissions


def _error(exc):
    if isinstance(exc, CreditConflict):
        state = exc.current_state
        return HTTPException(409, detail={'code': 'artists_revision_conflict', 'message': 'Состав изменился. Обновите данные и повторите правку.', 'current_revision': state['revision'], 'artists': state['artists']})
    if isinstance(exc, CreditNotFound):
        return HTTPException(404, detail={'code': 'entity_not_found', 'message': 'Объект не найден'})
    if isinstance(exc, CreditValidationError):
        return HTTPException(422, detail={'code': exc.code, 'message': exc.message})
    if isinstance(exc, sqlite3.OperationalError) and ('locked' in str(exc).lower() or 'busy' in str(exc).lower()):
        return HTTPException(503, detail={'code': 'credits_busy', 'message': 'База занята'}, headers={'Retry-After': '1'})
    return HTTPException(500, detail={'code': 'credits_error', 'message': 'Не удалось сохранить состав'})


@serialize_artist_credit_mutation
def _replace(entity_type, entity_id, artists, expected_revision, current_user):
    conn = None
    try:
        conn = get_connection()
        conn.execute('BEGIN IMMEDIATE')
        if entity_type == 'track':
            row = conn.execute('SELECT * FROM tracks WHERE id = ?', (entity_id,)).fetchone()
            if row is None:
                raise CreditNotFound(entity_type, entity_id)
            check_track_edit_permissions(dict(row), current_user)
        else:
            row = conn.execute('SELECT id FROM albums WHERE id = ?', (entity_id,)).fetchone()
            if row is None:
                raise CreditNotFound(entity_type, entity_id)
            tracks = conn.execute('SELECT * FROM tracks WHERE album_id = ?', (entity_id,)).fetchall()
            if not tracks and current_user.get('role') != 'admin':
                raise HTTPException(403, detail='Недостаточно прав')
            for track in tracks:
                check_track_edit_permissions(dict(track), current_user)
        before = get_credit_states(entity_type, [entity_id], conn=conn)[str(entity_id)]
        after = replace_artist_credits(conn, entity_type, entity_id, artists, expected_revision=expected_revision)
        if after['revision'] != before['revision']:
            bump_catalog_version(conn)
        conn.commit()
    except (CreditConflict, CreditNotFound, CreditValidationError, sqlite3.OperationalError) as exc:
        if conn is not None:
            conn.rollback()
        raise _error(exc)
    except Exception:
        if conn is not None:
            conn.rollback()
        raise
    finally:
        if conn is not None:
            conn.close()


def set_track_artists(track_id, artists, expected_revision, current_user, base_url):
    _replace('track', track_id, artists, expected_revision, current_user)
    import db
    row = hydrate_track_credits([db.get_track(track_id)])[0]
    return serialize_track(row, base_url, db.get_favorite_track_ids(current_user['id']))


def set_album_artists(album_id, artists, expected_revision, current_user, base_url):
    _replace('album', album_id, artists, expected_revision, current_user)
    from services.album_service import get_album_detail
    return get_album_detail(album_id, current_user, base_url)
