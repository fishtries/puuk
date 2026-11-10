"""Regression checks for file binding, verified times and recovery."""
import test_db_path  # noqa: F401
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch
import pytest
import db
from services.word_lyrics_validator import compute_canonical_revision, validate_word_lyrics_payload
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/lyrics'))
from export_word_lyrics import build_word_lyrics_snapshot
from import_word_lyrics import import_word_lyrics_file

@pytest.fixture
def snapshot(tmp_path):
    import hashlib
    db.init_db()
    audio = tmp_path / 'audio.mp3'
    audio.write_bytes(b'audio fixture')
    tid = 'regression-' + tmp_path.name
    db.add_or_update_track(tid, str(audio), 'Fixture', None, 'Artist', '[00:01.00]One two', duration=3)
    payload = dict(schemaVersion=1, trackId=tid, audioSha256=hashlib.sha256(audio.read_bytes()).hexdigest(), durationMs=3000,
        lines=[dict(id='l', text='One two', startMs=1000, endMs=2500, words=[
            dict(id='a', **{'from':0,'to':3}, startMs=1500,endMs=2500),
            dict(id='b', **{'from':4,'to':7}, startMs=1000,endMs=1400)])])
    payload['revision'] = compute_canonical_revision(payload)
    path = tmp_path / 'snapshot.json'
    path.write_text(json.dumps(payload))
    return tid, audio, path, payload

def test_reimport_refreshes_stat(snapshot):
    tid, audio, path, _ = snapshot
    import_word_lyrics_file(str(path), apply_changes=True)
    st = audio.stat()
    os.utime(audio, ns=(st.st_atime_ns,st.st_mtime_ns+1000000000))
    assert db.get_track_word_lyrics(tid) is None
    import_word_lyrics_file(str(path), apply_changes=True)
    assert db.get_track_word_lyrics(tid) is not None

def test_current_audio_binding(snapshot, tmp_path):
    tid, audio, path, _ = snapshot
    import_word_lyrics_file(str(path), apply_changes=True)
    other = tmp_path / 'other.mp3'; other.write_bytes(b'another recording')
    conn=db.get_connection();conn.execute('UPDATE tracks SET file_path=? WHERE id=?',(str(other),tid));conn.commit();conn.close()
    assert db.get_track_word_lyrics(tid) is None
    with pytest.raises(ValueError, match='current track audio'):
        import_word_lyrics_file(str(path), audio_path=str(audio), apply_changes=True)

def test_corrupt_document_falls_back(snapshot):
    tid, _, path, payload = snapshot
    import_word_lyrics_file(str(path), apply_changes=True)
    payload['schemaVersion']=999
    conn=db.get_connection();conn.execute('UPDATE track_word_lyrics SET payload_json=? WHERE track_id=?',(json.dumps(payload),tid));conn.commit();conn.close()
    assert db.get_track_word_lyrics(tid) is None
    import_word_lyrics_file(str(path), apply_changes=True)
    assert db.get_track_word_lyrics(tid) is not None

def test_export_preserves_inverted_manual_times(snapshot):
    tid,audio,_,payload=snapshot
    ref=dict(duration=3,lines=[dict(text='One two',anchor=1)],words=[
        dict(id=0,line=0,text='One',char_start=0,char_end=3),dict(id=1,line=0,text='two',char_start=4,char_end=7)])
    aligned=[dict(id=0,start=1.5,end=2.5,locked=True),dict(id=1,start=1,end=1.4,locked=True)]
    with patch('export_word_lyrics.get_audio_duration_ms',return_value=3000):
        out,_,_=build_word_lyrics_snapshot(tid,str(audio),ref,aligned,'test','draft')
    assert [(w['startMs'],w['endMs']) for w in out['lines'][0]['words']]==[(1500,2500),(1000,1400)]
    assert validate_word_lyrics_payload(out)[0]

def test_deactivate_and_restore_cli(snapshot,tmp_path):
    import subprocess
    tid,_,path,payload=snapshot
    import_word_lyrics_file(str(path),apply_changes=True)
    payload['lines'][0]['text']='ONE two';payload['revision']=compute_canonical_revision(payload);path.write_text(json.dumps(payload))
    backups=tmp_path/'backups'
    import_word_lyrics_file(str(path),apply_changes=True,backup_dir=str(backups))
    cli=str(Path(__file__).resolve().parents[1]/'scripts/lyrics/import_word_lyrics.py')
    subprocess.run([sys.executable,cli,'--track-id',tid,'--deactivate','--apply'],check=True,capture_output=True)
    assert db.get_track_word_lyrics(tid) is None
    subprocess.run([sys.executable,cli,'--restore',str(next(backups.glob('*.json'))),'--apply'],check=True,capture_output=True)
    assert db.get_track_word_lyrics(tid)['lines'][0]['text']=='One two'


@pytest.mark.parametrize("words", [[None], [{"startMs": "bad"}], [1]])
def test_validator_rejects_malformed_words_without_throwing(snapshot, words):
    _, _, _, payload = snapshot
    payload['lines'][0]['words'] = words
    payload['revision'] = compute_canonical_revision(payload)
    assert validate_word_lyrics_payload(payload)[0] is False


def test_failed_replacement_keeps_previous_snapshot(snapshot, tmp_path):
    tid, _, path, payload = snapshot
    import_word_lyrics_file(str(path), apply_changes=True)
    original = db.get_track_word_lyrics_record(tid)
    payload['lines'][0]['text'] = 'ONE two'
    payload['revision'] = compute_canonical_revision(payload)
    path.write_text(json.dumps(payload))
    with patch('import_word_lyrics.db.upsert_track_word_lyrics', side_effect=RuntimeError('write failed')):
        with pytest.raises(RuntimeError, match='write failed'):
            import_word_lyrics_file(str(path), apply_changes=True, backup_dir=str(tmp_path / 'backups'))
    assert db.get_track_word_lyrics_record(tid) == original


def test_repeated_backup_does_not_overwrite_and_restores_inactive_state(snapshot, tmp_path):
    import subprocess
    tid, _, path, payload = snapshot
    backups = tmp_path / 'backups'
    import_word_lyrics_file(str(path), apply_changes=True)
    db.set_track_word_lyrics_active(tid, False)
    import_word_lyrics_file(str(path), apply_changes=True, backup_dir=str(backups))
    first = next(backups.glob('*.json'))
    first_bytes = first.read_bytes()
    db.set_track_word_lyrics_active(tid, False)
    import_word_lyrics_file(str(path), apply_changes=True, backup_dir=str(backups))
    assert len(list(backups.glob('*.json'))) == 2
    assert first.read_bytes() == first_bytes
    cli = str(Path(__file__).resolve().parents[1] / 'scripts/lyrics/import_word_lyrics.py')
    subprocess.run([sys.executable, cli, '--restore', str(first), '--apply', '--backup-dir', str(backups)], check=True, capture_output=True)
    assert db.get_track_word_lyrics_record(tid)['is_active'] == 0
    assert db.get_track_word_lyrics(tid) is None
