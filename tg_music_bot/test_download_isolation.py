"""Checked downloads must preserve isolation, provenance and partial results."""
import asyncio
from dataclasses import asdict
import json
from pathlib import Path
import sys

import pytest
from mutagen.id3 import ID3, TXXX, WOAS
import downloader
from source_selection import Candidate, POLICY_VERSION
from test_audio_tags import _make_mp3


def checked_file(directory, name='first'):
    path = Path(_make_mp3(str(Path(directory) / (name + '.mp3')), name, 'Artist'))
    duration = downloader.read_audio_tags(str(path)).duration
    song = {'name': name, 'artists': ['Artist'], 'duration': duration, 'explicit': True,
            'url': 'https://open.spotify.com/track/' + name}
    receipt = {'policy': POLICY_VERSION, 'spotify_url': song['url'],
               'candidate': asdict(Candidate('aaaaaaaaaaa', name, ('Artist',), duration, explicit=True))}
    tags = ID3(path)
    tags.add(WOAS(url=song['url']))
    tags.add(TXXX(encoding=3, desc='PUUK_SOURCE_V1', text=json.dumps(receipt)))
    tags.save(path)
    return song, path


def test_legacy_spotify_tag_does_not_prove_audio_identity(tmp_path):
    song, path = checked_file(tmp_path)
    assert len(downloader._existing_spotify_tracks(str(tmp_path), [song], set())) == 1
    tags = ID3(path)
    tags.delall('TXXX:PUUK_SOURCE_V1')
    tags.save(path)
    before = path.read_bytes()
    assert downloader._existing_spotify_tracks(str(tmp_path), [song], set()) == []
    assert path.read_bytes() == before


def test_vk_reuse_requires_acoustic_evidence(tmp_path):
    song, path = checked_file(tmp_path)
    tags = ID3(path)
    receipt = json.loads(str(tags['TXXX:PUUK_SOURCE_V1']))
    receipt['candidate'].update(provider='vk', video_id='-1_2', source_url='https://vk.ru/audio-1_2')
    tags.add(TXXX(encoding=3, desc='PUUK_SOURCE_V1', text=json.dumps(receipt)))
    tags.save(path)
    assert downloader._existing_spotify_tracks(str(tmp_path), [song], set()) == []
    receipt['audio_match'] = 'spotify-preview-original-speed'
    tags.add(TXXX(encoding=3, desc='PUUK_SOURCE_V1', text=json.dumps(receipt)))
    tags.save(path)
    assert len(downloader._existing_spotify_tracks(str(tmp_path), [song], set())) == 1


def test_soundcloud_reuse_with_missing_guest_requires_acoustic_receipt(tmp_path):
    song, path = checked_file(tmp_path)
    song['artists'].append('Guest')
    song['require_audio_match'] = True
    tags = ID3(path)
    receipt = json.loads(str(tags['TXXX:PUUK_SOURCE_V1']))
    receipt['candidate'].update(provider='soundcloud', video_id='123', verified_publisher=True,
                                source_url='https://soundcloud.com/artist/first')
    tags.add(TXXX(encoding=3, desc='PUUK_SOURCE_V1', text=json.dumps(receipt)))
    tags.save(path)
    assert downloader._existing_spotify_tracks(str(tmp_path), [song], set()) == []
    receipt['audio_match'] = 'spotify-preview-original-speed'
    tags.add(TXXX(encoding=3, desc='PUUK_SOURCE_V1', text=json.dumps(receipt)))
    tags.save(path)
    assert len(downloader._existing_spotify_tracks(str(tmp_path), [song], set())) == 1


def test_publication_never_substitutes_filename_collision(tmp_path):
    library, stage = tmp_path / 'library', tmp_path / 'stage'
    library.mkdir(); stage.mkdir()
    target = Path(_make_mp3(str(library / 'same.mp3'), 'Old', 'Artist'))
    source = Path(_make_mp3(str(stage / 'same.mp3'), 'New', 'Artist'))
    old = target.read_bytes()
    result = downloader._publish_tracks([{'filepath': str(source), 'verified_metadata': {}}], str(library))
    assert target.read_bytes() == old
    assert Path(result[0]['filepath']).read_bytes() == source.read_bytes()
    assert result[0]['filepath'] != str(target)


def test_concurrent_imports_and_partial_failures(monkeypatch, tmp_path):
    library = tmp_path / 'library'; library.mkdir()
    _make_mp3(str(library / 'unrelated.mp3'), 'Other', 'Other')
    staging = []
    async def process(cmd, log, timeout):
        if '-m' in cmd:
            name = cmd[4].rsplit('/', 1)[-1]
            metadata_path = Path(cmd[cmd.index('--save-file') + 1])
            staging.append(metadata_path.parent)
            song, fixture = checked_file(metadata_path.parent, name)
            fixture.unlink()
            songs = [song, {**song, 'name': 'Missing', 'url': 'https://open.spotify.com/track/missing'}]
            metadata_path.write_text(json.dumps(songs))
        else:
            song = json.loads(Path(cmd[cmd.index('--song') + 1]).read_text())
            result_path = Path(cmd[cmd.index('--result') + 1])
            if song['name'] == 'Missing':
                result = {'error': 'Не подтверждена версия explicit без цензуры'}
            else:
                _, path = checked_file(cmd[cmd.index('--output') + 1], song['name'])
                result = {'track': downloader._existing_spotify_tracks(str(path.parent), [song], set())[0]}
            result_path.write_text(json.dumps(result))
        await asyncio.sleep(0)
    monkeypatch.setattr(downloader, '_run_download_process', process)
    async def run():
        return await asyncio.gather(*[
            downloader.download_spotify('https://open.spotify.com/playlist/' + name, str(library))
            for name in ('first', 'second')])
    results = asyncio.run(run())
    for name, result in zip(('first', 'second'), results):
        assert result['total_tracks'] == 1
        assert result['failed_tracks'] == 1
        assert result['expected_tracks'] == 2
        assert Path(result['tracks'][0]['filepath']).name == name + '.mp3'
    assert all(not p.exists() for p in staging)
    assert sorted(p.name for p in library.iterdir()) == ['first.mp3', 'second.mp3', 'unrelated.mp3']


def test_timeout_kills_real_child(tmp_path):
    pid_path = tmp_path / 'pid'
    code = 'import os,time,pathlib; pathlib.Path(' + repr(str(pid_path)) + ').write_text(str(os.getpid())); time.sleep(30)'
    async def run():
        with pytest.raises(TimeoutError):
            await downloader._run_download_process([sys.executable, '-c', code], str(tmp_path / 'log'), .3)
    asyncio.run(run())
    import os
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid_path.read_text()), 0)


def test_cancellation_cleans_staging(monkeypatch, tmp_path):
    staged = []
    async def process(cmd, log, timeout):
        staged.append(Path(log).parent)
        await asyncio.sleep(30)
    monkeypatch.setattr(downloader, '_run_download_process', process)
    async def run():
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(.03):
                await downloader.download_spotify('https://open.spotify.com/playlist/test', str(tmp_path / 'library'))
    asyncio.run(run())
    assert staged and all(not p.exists() for p in staged)


def test_restart_preserves_metadata_and_completed_songs(monkeypatch, tmp_path):
    library = tmp_path / 'library'; library.mkdir()
    checkpoint = tmp_path / 'checkpoint'; checkpoint.mkdir()
    first, path = checked_file(library, 'first')
    second = {**first, 'name': 'second', 'url': 'https://open.spotify.com/track/second'}
    (checkpoint / 'metadata.spotdl').write_text(json.dumps([first, second]))
    before = path.read_bytes()
    calls = []
    async def process(cmd, log, timeout):
        assert '-m' not in cmd  # cached Spotify snapshot survives restart
        s = json.loads(Path(cmd[cmd.index('--song') + 1]).read_text())
        calls.append(s['name'])
        assert s['name'] == 'second'  # completed first track is not downloaded
        _, p = checked_file(cmd[cmd.index('--output') + 1], 'second')
        track = downloader._existing_spotify_tracks(str(p.parent), [second], set())[0]
        Path(cmd[cmd.index('--result') + 1]).write_text(json.dumps({'track': track}))
    monkeypatch.setattr(downloader, '_run_download_process', process)
    result = asyncio.run(downloader.download_spotify('https://open.spotify.com/playlist/test',
        str(library), checkpoint_dir=str(checkpoint)))
    assert calls == ['second'] and result['total_tracks'] == 2 and result['reused_tracks'] == 1
    assert path.read_bytes() == before
    assert (library / 'second.mp3').exists()
