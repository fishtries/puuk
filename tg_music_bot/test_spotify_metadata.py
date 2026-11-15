import pytest
from spotify_metadata import album_songs

ID='a'*22
TID='b'*22

def fixture(kind, ident):
    if kind=='album':
        return {'title':'Album','subtitle':'Lead','trackList':[{'uri':'spotify:track:'+TID}],
                'visualIdentity':{'image':[]}}
    return {'title':'Song','uri':'spotify:track:'+TID,'artists':[{'name':'A, B'},{'name':'C'}],
            'duration':91234,'isExplicit':True}


def test_preserves_exact_credits_duration_and_explicit():
    rows=album_songs('https://open.spotify.com/album/'+ID,fetch=fixture)
    assert rows[0]['artists']==['A, B','C']
    assert rows[0]['duration']==91.234 and rows[0]['explicit'] is True
    assert rows[0]['album_name']=='Album' and rows[0]['track_number']==1


def test_missing_credits_fails_whole_snapshot():
    def fetch(kind,ident):
        row=fixture(kind,ident)
        if kind=='track': row['artists']=[]
        return row
    with pytest.raises(ValueError): album_songs('https://open.spotify.com/album/'+ID,fetch=fetch)


def test_refuses_pagination_boundary():
    def fetch(kind,ident):
        row=fixture(kind,ident)
        row['trackList']*=100
        return row
    with pytest.raises(ValueError): album_songs('https://open.spotify.com/album/'+ID,fetch=fetch)
