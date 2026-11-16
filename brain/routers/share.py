"""Authenticated, bounded permanent-entity resolver. No filesystem/editor IO."""
import re
import uuid
from fastapi import APIRouter, HTTPException, Request
from repositories.base import get_connection, check_deadline
from repositories import share_entities
from repositories.artist_credits import hydrate_track_credits, hydrate_album_credits
from serializers import serialize_track, share_track
from services.album_service import serialize_album
from services.delivery_service import executor, authenticate

router=APIRouter(tags=['share'])


def validate_id(kind,value):
    if kind=='track':
        try:
            if str(uuid.UUID(value))==value:
                return value
        except ValueError:
            pass
    elif kind=='album':
        if re.fullmatch(r'[1-9][0-9]{0,18}',value) and int(value)<=2**63-1:
            return value
    elif kind=='artist' and re.fullmatch(r'art_[0-9a-f]{32}',value):
        return value
    raise HTTPException(400,detail='Invalid entity')


def resolve_share(request,kind,value,deadline,cancel):
    user=authenticate(request)
    validate_id(kind,value)
    # Fixed public origin: request Host/forwarding cannot inject DTO URLs.
    base='https://web.puuk.fun'
    conn=get_connection(deadline=deadline,cancel=cancel)
    try:
        canonical,state=share_entities.resolve(conn,kind,value)
        if canonical is None:
            raise HTTPException(410 if state=='deleted' else 404,detail='Entity unavailable')
        tracks=[]; albums=[]
        if kind=='track':
            rows=conn.execute('SELECT t.*,a.title AS album FROM tracks t LEFT JOIN albums a ON a.id=t.album_id WHERE t.id=?',(canonical,)).fetchall()
            if not rows:
                raise HTTPException(404,detail='Entity unavailable')
            tracks=hydrate_track_credits(rows,conn=conn)
        elif kind=='album':
            row=conn.execute('SELECT * FROM albums WHERE id=?',(canonical,)).fetchone()
            if row is None:
                raise HTTPException(404,detail='Entity unavailable')
            from repositories.albums import TRACKS_ORDER_SQL
            rows=conn.execute('SELECT t.*,a.title AS album FROM tracks t LEFT JOIN albums a ON a.id=t.album_id WHERE t.album_id=? '+TRACKS_ORDER_SQL+' LIMIT 5001',(canonical,)).fetchall()
            if len(rows)>5000:
                raise HTTPException(422,detail={'code':'entity_too_large','message':'Entity too large'})
            tracks=hydrate_track_credits(rows,conn=conn)
            hydrated=hydrate_album_credits([row],conn=conn)[0]
            entity=serialize_album({**hydrated,'track_count':len(tracks),'total_duration':sum(t.get('duration') or 0 for t in tracks),
                'cover_track_id':tracks[0]['id'] if tracks else None},base)
        else:
            from repositories.artists import public_artist
            row=conn.execute("""SELECT ar.*,
                (SELECT COUNT(*) FROM track_artists WHERE artist_id=ar.id) AS track_count,
                (SELECT COUNT(*) FROM album_artists aa WHERE artist_id=ar.id AND EXISTS(SELECT 1 FROM tracks t WHERE t.album_id=aa.album_id)) AS album_count,
                COALESCE((SELECT CASE WHEN has_artwork THEN version ELSE 0 END FROM artist_artwork WHERE artist_id=ar.id),0) AS artwork_version
                FROM artists ar WHERE ar.id=?""",(canonical,)).fetchone()
            if row is None:
                raise HTTPException(404,detail='Entity unavailable')
            entity=public_artist(dict(row),base)
            rows=conn.execute("""SELECT t.*,a.title AS album FROM tracks t JOIN track_artists ta ON ta.track_id=t.id
                LEFT JOIN albums a ON a.id=t.album_id WHERE ta.artist_id=? ORDER BY
                (SELECT COUNT(*) FROM artist_play_starts p WHERE p.track_id=t.id) DESC,t.title,t.id LIMIT 10""",(canonical,)).fetchall()
            tracks=hydrate_track_credits(rows,conn=conn)
            from repositories.albums import REPRESENTATIVE_TRACK_SQL
            rows=conn.execute(f"""SELECT a.*,
                (SELECT COUNT(*) FROM tracks t WHERE t.album_id=a.id) AS track_count,
                (SELECT SUM(duration) FROM tracks t WHERE t.album_id=a.id) AS total_duration,
                ({REPRESENTATIVE_TRACK_SQL}) AS cover_track_id FROM albums a
                JOIN album_artists aa ON aa.album_id=a.id WHERE aa.artist_id=?
                AND EXISTS(SELECT 1 FROM tracks t WHERE t.album_id=a.id) ORDER BY a.year DESC,a.title,a.id LIMIT 1001""",(canonical,)).fetchall()
            if len(rows)>1000:
                raise HTTPException(422,detail={'code':'entity_too_large','message':'Entity too large'})
            albums=[serialize_album(r,base) for r in hydrate_album_credits(rows,conn=conn)]
        favorites={r[0] for r in conn.execute('SELECT track_id FROM user_favorites WHERE user_id=? AND track_id IN ('+','.join('?' for _ in tracks)+')',(user['id'],*(t['id'] for t in tracks)))} if tracks else set()
        # Explicit DTO filtering prevents file/provenance/editor or stream fields
        # entering a share response as existing serializers evolve.
        tracks=[share_track(serialize_track(r,base,favorites,include_lyrics=False)) for r in tracks]
        if kind=='track':
            entity=tracks[0]
        check_deadline(deadline,cancel)
        return {'type':kind,'requested_id':value,'canonical_id':canonical,'canonical_path':f'/{kind}/{canonical}',
            'entity':entity,'tracks':tracks,'albums':albums}
    finally:
        conn.close()


@router.get('/api/share/{entity_type}/{entity_id}')
async def get_share(entity_type: str,entity_id: str,request: Request):
    from services.delivery_service import executor
    return await executor.run(request,lambda deadline,cancel: resolve_share(request,entity_type,entity_id,deadline,cancel),budget=5)
