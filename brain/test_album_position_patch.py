"""Position-only edits update tags and SQLite, including explicit clearing."""
import sys
from pathlib import Path
from contextlib import nullcontext

sys.path.insert(0, str(Path(__file__).parent))
import test_db_path  # noqa: F401

import pytest
import db
from metadata import read_audio_metadata, mutate_audio_file
from routers.tracks import TrackEditPayload
from services import track_metadata_service as service


@pytest.mark.parametrize(('fields', 'expected_number', 'expected_position'), [
    ({'album_track_position': 5}, '5', 5),
    ({'album_track_position': None}, None, None),
    ({'album_track_position': 2}, '2', 2),
    ({'track_number': '5/12', 'album_track_position': 5}, '5/12', 5),
    ({'track_number': '6/12'}, '6/12', 6),
    ({'track_number': None}, None, None),
    ({'title': 'Renamed'}, '2/12', 2),
])
def test_position_patch(tmp_path, monkeypatch, fields, expected_number, expected_position):
    monkeypatch.setenv('PUUK_DB_PATH', str(tmp_path / 'test.db'))
    db.init_db()
    audio = tmp_path / 'track.mp3'
    frame = bytes([0xFF, 0xFB, 0x90, 0x44]) + b'\x00' * 413
    audio.write_bytes(frame * 10)
    from metadata import MetadataPatch
    mutate_audio_file(str(audio), MetadataPatch(
        fields_set={'title', 'artist', 'track_number'},
        title='Song', artist='Artist', track_number='2/12',
    ))
    meta = read_audio_metadata(str(audio))
    db.add_or_update_track('position-test', 'track.mp3', meta.title, None, meta.artist,
                           track_number=meta.track_number, album_track_position=2)
    monkeypatch.setattr(service, 'resolve_track_file_path', lambda row: (str(audio), str(tmp_path)))
    monkeypatch.setattr(service, 'track_mutation_lock', lambda *args: nullcontext())
    # Exercise real tag writing without the independent file-replacement machinery.
    def write(path, patch):
        mutate_audio_file(path, patch)
        return read_audio_metadata(path)
    monkeypatch.setattr(service, 'safe_replace_audio_file', write)
    monkeypatch.setattr(service, 'get_track_metadata_details', lambda *args: db.get_track('position-test'))
    result = service.mutate_track_metadata('position-test', TrackEditPayload(**fields), {'id': 1, 'role': 'admin'})
    assert read_audio_metadata(str(audio)).track_number == expected_number
    assert result['track_number'] == expected_number
    assert result['album_track_position'] == expected_position
