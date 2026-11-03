# Import test path report

Added the sibling `tg_music_bot` directory to the import test module's Python path after importing `test_db_path`, keeping the brain directory ahead of it. All existing format, file fingerprint, and override tests remain intact; no production code changed.

From `brain`, `env -u PYTHONPATH venv/bin/python -m pytest -xq test_multi_artist_import.py` passed: exit 0, 35 tests. An initial edit used a path relative to the repository root while already in `brain` and failed; its subsequent pre-fix test reproduced the reported missing `audio_tags` import (exit 1).
