from dataclasses import replace
from soundcloud_source import RecordingSoundcloudIE, RecordingSearchIE, publisher_fields
from source_selection import assess
from source_worker import soundcloud_candidate


def song():
    return {'name':'CRUSH (with Travis Scott)','artists':['Playboi Carti','Travis Scott'],
            'duration':173.32,'explicit':True}


def test_adapter_keeps_publisher_facts_in_search_and_download(monkeypatch):
    from yt_dlp.extractor.soundcloud import SoundcloudBaseIE
    monkeypatch.setattr(SoundcloudBaseIE,'_extract_info_dict',lambda self, raw, *a, **k: {'id':str(raw['id'])})
    raw={'id':123,'publisher_metadata':{'artist':'Playboi Carti','explicit':True}}
    for cls in (RecordingSoundcloudIE,RecordingSearchIE):
        result=cls()._extract_info_dict(raw,extract_flat=True)
        assert result['explicit'] is True and result['publisher_artist']=='Playboi Carti'
    assert RecordingSoundcloudIE.ie_key()=='Soundcloud'
    assert RecordingSearchIE.ie_key()=='SoundcloudSearch'


def test_explicit_false_and_unknown_are_not_promoted():
    assert publisher_fields({'publisher_metadata':{'explicit':False}})['explicit'] is False
    assert publisher_fields({})['explicit'] is None
    assert publisher_fields({'publisher_metadata':{'explicit':'true'}})['explicit'] is None


def test_soundcloud_combined_publisher_credits_and_title():
    raw={'id':'123','title':'CRUSH','publisher_artist':'Playboi Carti feat. Travis Scott',
         'duration':173.5,'explicit':True,'webpage_url':'https://soundcloud.com/playboicarti/crush'}
    c=soundcloud_candidate(raw,song())
    assert c.artists==('Playboi Carti','Travis Scott')
    assert assess(song(),c)[1] is None
    assert assess(song(),replace(c,explicit=False))[1] is None
    assert assess(song(),replace(c,title='CRUSH live'))[1]


def test_uploader_cannot_supply_missing_publisher_credits():
    c=soundcloud_candidate({'id':'123','title':'CRUSH','uploader':'Playboi Carti',
        'duration':173.5,'explicit':True,'webpage_url':'https://soundcloud.com/fake/crush'},song())
    assert not c.artists and assess(song(),c)[1]
