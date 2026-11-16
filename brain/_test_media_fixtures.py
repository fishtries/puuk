"""Synthetic audio and storage isolation for legacy stream contract tests."""
import test_db_path  # before any application import
import os
from pathlib import Path
import subprocess
import tempfile
from unittest import mock


def setup_media_class(test_class, module):
    root = tempfile.TemporaryDirectory(prefix='puuk_stream_contract_')
    test_class.addClassCleanup(root.cleanup)
    env = mock.patch.dict(os.environ, {
        'MUSIC_DIR': root.name,
        'PUUK_DB_PATH': str(Path(root.name) / 'test.db'),
    })
    env.start()
    test_class.addClassCleanup(env.stop)
    assert Path(os.environ['PUUK_DB_PATH']).is_relative_to(Path(tempfile.gettempdir()))
    sample = Path(root.name) / 'synthetic.mp3'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i',
                    'anullsrc=r=8000:cl=mono', '-t', '0.5', '-y', str(sample)], check=True)
    old = module.SAMPLE_MP3
    module.SAMPLE_MP3 = str(sample)
    test_class.addClassCleanup(setattr, module, 'SAMPLE_MP3', old)
    test_class.audio_root = Path(root.name)
    # Different permanent identities must never claim the same relative file path.
    test_class.audio_copy = staticmethod(lambda name: _copy(sample, name))


def _copy(sample, name):
    target = sample.parent / (name + '.mp3')
    target.write_bytes(sample.read_bytes())
    return str(target)
