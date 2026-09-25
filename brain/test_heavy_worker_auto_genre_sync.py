"""Focused tests for empty classifications and durable Qdrant delivery."""
import json
import os
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.dirname(__file__))
import test_db_path  # noqa: F401

import db
import heavy_worker


class TestHeavyWorkerAutoGenreSync(unittest.TestCase):
    def setUp(self):
        self.track_id = "sync-test-track"
        db.add_or_update_track(
            self.track_id,
            "sync-test-track.mp3",
            "Sync test",
            None,
            "Artist",
        )

    def test_empty_classification_is_marked_completed(self):
        client = Mock()
        heavy_worker.update_database_records(
            client,
            self.track_id,
            [0.1] * 400,
            {"file_path": "sync-test-track.mp3"},
            [],
            "genre-model",
            "2026-01-01T00:00:00+00:00",
        )

        track = db.get_track(self.track_id)
        self.assertEqual(json.loads(track["auto_genres"]), [])
        self.assertEqual(track["auto_genre_status"], "classified")
        self.assertEqual(track["auto_genre_sync_pending"], 0)
        self.assertEqual(client.upsert.call_count, 1)

    def test_qdrant_failure_leaves_durable_pending_record(self):
        client = Mock()
        client.upsert.side_effect = RuntimeError("qdrant unavailable")

        with self.assertRaises(RuntimeError):
            heavy_worker.update_database_records(
                client,
                self.track_id,
                [0.1] * 400,
                {"file_path": "sync-test-track.mp3"},
                [],
                "genre-model",
                "2026-01-01T00:00:00+00:00",
            )

        track = db.get_track(self.track_id)
        self.assertEqual(track["auto_genre_status"], "classified")
        self.assertEqual(track["auto_genre_sync_pending"], 1)

    def test_resync_retries_from_sqlite_without_overwriting_it_from_qdrant(self):
        db.update_track_auto_genres(
            self.track_id,
            [],
            "genre-model",
            "2026-01-01T00:00:00+00:00",
            sync_pending=True,
        )
        point = Mock()
        point.id = self.track_id
        point.vector = [0.1] * 400
        point.payload = {"file_path": "sync-test-track.mp3", "old": True}
        client = Mock()
        client.retrieve.return_value = [point]

        self.assertEqual(heavy_worker.resync_auto_genres_to_qdrant(client), 1)
        payload = client.upsert.call_args.kwargs["points"][0].payload
        self.assertEqual(payload["auto_genres"], [])
        self.assertEqual(payload["auto_genre_status"], "classified")
        self.assertFalse(db.get_pending_auto_genre_syncs())

    def test_backfill_skips_completed_empty_classification(self):
        completed_empty = Mock(id="completed-empty", payload={
            "needs_embedding": False,
            "auto_genre_status": "classified",
            "auto_genres": [],
        })
        not_yet_classified = Mock(id="not-classified", payload={
            "needs_embedding": False,
        })
        failed = Mock(id="failed", payload={
            "needs_embedding": False,
            "auto_genre_status": "failed",
        })
        client = Mock()
        client.scroll.return_value = ([completed_empty, failed, not_yet_classified], None)

        tracks = heavy_worker.get_backfill_tracks(client)

        self.assertEqual([track.id for track in tracks], ["not-classified"])

    def test_backfill_skips_legacy_qdrant_payload_with_auto_genres(self):
        legacy = Mock(id="legacy", payload={
            "needs_embedding": False,
            "auto_genres": [{"name": "House", "confidence": 0.8}],
        })
        client = Mock()
        client.scroll.return_value = ([legacy], None)

        self.assertEqual(heavy_worker.get_backfill_tracks(client), [])

    def test_retry_failed_backfill_includes_stale_qdrant_genres(self):
        failed_with_stale_genres = Mock(id="failed-stale", payload={
            "needs_embedding": False,
            "auto_genre_status": "failed",
            "auto_genres": [{"name": "Stale", "confidence": 0.9}],
        })
        client = Mock()
        client.scroll.return_value = ([failed_with_stale_genres], None)

        tracks = heavy_worker.get_backfill_tracks(client, include_failed=True)

        self.assertEqual([track.id for track in tracks], ["failed-stale"])

    def test_failed_classification_clears_stale_qdrant_and_sqlite_genres(self):
        db.update_track_auto_genres(
            self.track_id,
            [{"name": "Stale", "confidence": 0.9}],
            "old-model",
        )
        payload = {
            "needs_embedding": False,
            "auto_genres": [{"name": "Stale", "confidence": 0.9}],
            "auto_genre_model": "old-model",
        }
        client = Mock()
        heavy_worker.update_database_records(
            client,
            self.track_id,
            [0.1] * 400,
            payload,
            None,
            None,
        )

        stored = db.get_track(self.track_id)
        self.assertIsNone(stored["auto_genres"])
        self.assertEqual(stored["auto_genre_status"], "failed")
        sent_payload = client.upsert.call_args.kwargs["points"][0].payload
        self.assertNotIn("auto_genres", sent_payload)
        self.assertEqual(sent_payload["auto_genre_status"], "failed")

    def test_qdrant_pull_does_not_overwrite_sqlite_pending_values(self):
        db.update_track_auto_genres(
            self.track_id,
            [{"name": "Local", "confidence": 0.9}],
            "local-model",
            "2026-01-01T00:00:00+00:00",
            sync_pending=True,
        )
        record = Mock(id=self.track_id, payload={
            "auto_genre_status": "classified",
            "auto_genres": [{"name": "Stale", "confidence": 0.3}],
            "auto_genre_model": "stale-model",
        })
        client = Mock()
        client.scroll.return_value = ([record], None)

        heavy_worker.resync_auto_genres_from_qdrant_to_sqlite(client)

        stored = db.get_track(self.track_id)
        self.assertEqual(json.loads(stored["auto_genres"])[0]["name"], "Local")
        self.assertEqual(stored["auto_genre_sync_pending"], 1)

    def test_qdrant_only_track_is_created_before_auto_genre_update(self):
        track_id = "qdrant-only-track"
        payload = {
            "file_path": "Artist - New Song.mp3",
            "title": "New Song",
            "artist": "Artist",
        }
        client = Mock()

        heavy_worker.update_database_records(
            client,
            track_id,
            [0.1] * 400,
            payload,
            [{"name": "House", "confidence": 0.8}],
            "genre-model",
            "2026-01-01T00:00:00+00:00",
        )

        track = db.get_track(track_id)
        self.assertIsNotNone(track)
        self.assertEqual(track["title"], "New Song")
        self.assertEqual(track["artist"], "Artist")
        self.assertEqual(json.loads(track["auto_genres"])[0]["name"], "House")


if __name__ == "__main__":
    unittest.main()
