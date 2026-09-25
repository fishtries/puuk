"""Тесты хранения автоматических жанров в SQLite (миграция 005, tracks repository).

Проверяет:
- запись пустого auto_genres (None / []);
- запись валидного списка auto_genres в JSON;
- устойчивость чтения трека при поврежденном JSON;
- сохранение ручного genre при обновлении auto-жанров;
- повторный запуск обновляет только auto-поля (auto_genres, auto_genre_model, auto_genre_updated_at).
"""
import json
import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД

import db
from repositories.tracks import (
    update_track_auto_genres,
    get_track,
    get_pending_auto_genre_syncs,
    mark_auto_genre_sync_complete,
    mark_auto_genre_failed,
    reset_failed_auto_genres,
)


class TestAutoGenresRepository(unittest.TestCase):
    def setUp(self):
        self.track_id = f"test-track-{uuid.uuid4().hex[:8]}"
        # Создаем трек с ручным жанром
        db.add_or_update_track(
            track_id=self.track_id,
            file_path=f"test/{self.track_id}.mp3",
            title="Auto Genre Test Track",
            album_id=None,
            artist="Test Artist",
            genre="Indie Rock",
        )

    def test_empty_auto_genres(self):
        """Запись пустого / None auto_genres сохраняет NULL в базе."""
        update_track_auto_genres(self.track_id, None, "test-model-v1")
        track = get_track(self.track_id)
        self.assertIsNotNone(track)
        self.assertIsNone(track.get("auto_genres"))
        self.assertEqual(track.get("auto_genre_model"), "test-model-v1")
        self.assertIsNotNone(track.get("auto_genre_updated_at"))

        # Пустой список []
        update_track_auto_genres(self.track_id, [], "test-model-v1")
        track = get_track(self.track_id)
        self.assertEqual(track.get("auto_genres"), "[]")

    def test_valid_json_auto_genres(self):
        """Запись валидного списка словарей с жанрами и confidence."""
        genres = [
            {"name": "Deep House", "confidence": 0.82},
            {"name": "House", "confidence": 0.64},
            {"name": "Electronic", "confidence": 0.51},
        ]
        update_track_auto_genres(self.track_id, genres, "genre_discogs400-discogs-effnet-1")
        track = get_track(self.track_id)
        self.assertIsNotNone(track)
        self.assertEqual(track.get("auto_genre_model"), "genre_discogs400-discogs-effnet-1")
        self.assertIsNotNone(track.get("auto_genre_updated_at"))

        parsed = json.loads(track["auto_genres"])
        self.assertEqual(len(parsed), 3)
        self.assertEqual(parsed[0]["name"], "Deep House")
        self.assertAlmostEqual(parsed[0]["confidence"], 0.82)
        self.assertEqual(parsed[1]["name"], "House")
        self.assertEqual(parsed[2]["name"], "Electronic")

    def test_corrupted_json_does_not_break_track_reading(self):
        """Поврежденный JSON в auto_genres не ломает чтение записи трека."""
        conn = db.get_connection()
        cur = conn.cursor()
        cur.execute(
            "UPDATE tracks SET auto_genres = ? WHERE id = ?",
            ("{corrupted_json: not valid [}", self.track_id),
        )
        conn.commit()
        conn.close()

        track = get_track(self.track_id)
        self.assertIsNotNone(track)
        self.assertEqual(track["id"], self.track_id)
        self.assertEqual(track["title"], "Auto Genre Test Track")
        self.assertEqual(track["auto_genres"], "{corrupted_json: not valid [}")

    def test_manual_genre_not_overwritten(self):
        """Ручной genre не изменяется при обновлении автоматических жанров."""
        track_before = get_track(self.track_id)
        self.assertEqual(track_before["genre"], "Indie Rock")

        genres = [{"name": "Electronic", "confidence": 0.95}]
        update_track_auto_genres(self.track_id, genres, "test-model")

        track_after = get_track(self.track_id)
        self.assertEqual(track_after["genre"], "Indie Rock")
        parsed = json.loads(track_after["auto_genres"])
        self.assertEqual(parsed[0]["name"], "Electronic")

    def test_repeated_run_updates_only_auto_fields(self):
        """Повторный запуск обновляет только auto-поля и updated_at."""
        first_genres = [{"name": "House", "confidence": 0.70}]
        update_track_auto_genres(self.track_id, first_genres, "model-v1")
        track_1 = get_track(self.track_id)
        ts_1 = track_1["auto_genre_updated_at"]

        second_genres = [{"name": "Techno", "confidence": 0.88}]
        update_track_auto_genres(self.track_id, second_genres, "model-v2")
        track_2 = get_track(self.track_id)

        # Ручной жанр, название, исполнитель остались нетронутыми
        self.assertEqual(track_2["genre"], "Indie Rock")
        self.assertEqual(track_2["title"], "Auto Genre Test Track")
        self.assertEqual(track_2["artist"], "Test Artist")

        # Auto-поля обновились
        self.assertEqual(track_2["auto_genre_model"], "model-v2")
        parsed = json.loads(track_2["auto_genres"])
        self.assertEqual(parsed[0]["name"], "Techno")
        self.assertEqual(parsed[0]["confidence"], 0.88)

    def test_sync_pending_can_be_retried_without_reclassifying(self):
        genres = [{"name": "House", "confidence": 0.70}]
        update_track_auto_genres(self.track_id, genres, "model-v1", "2026-01-01T00:00:00+00:00", sync_pending=True)

        pending = get_pending_auto_genre_syncs()
        row = next(row for row in pending if row["id"] == self.track_id)
        self.assertEqual(json.loads(row["auto_genres"]), genres)

        mark_auto_genre_sync_complete(self.track_id)
        self.assertFalse(any(row["id"] == self.track_id for row in get_pending_auto_genre_syncs()))

    def test_failed_classification_can_be_explicitly_requeued(self):
        update_track_auto_genres(
            self.track_id,
            [{"name": "Stale", "confidence": 0.9}],
            "old-model",
        )
        mark_auto_genre_failed(self.track_id)
        failed = get_track(self.track_id)
        self.assertEqual(failed["auto_genre_status"], "failed")
        self.assertIsNone(failed["auto_genres"])

        self.assertEqual(reset_failed_auto_genres(), 1)
        self.assertIsNone(get_track(self.track_id)["auto_genre_status"])


if __name__ == "__main__":
    unittest.main()
