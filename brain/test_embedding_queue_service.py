"""Tests for the server-side embedding queue service (SQLite -> Qdrant).

Uses a fake Qdrant client and an isolated temporary SQLite (test_db_path), so
the suite never reads or writes the live instance. Covers the recovery
contract: absent points are created with the same id, existing vectors and
processing state are preserved, and Qdrant errors are never mistaken for
"point absent".
"""
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import test_db_path  # noqa: F401 — isolates test DB, disables live queue delivery

import db
from services import embedding_queue_service as svc


class FakeQdrant:
    """Minimal in-memory stand-in for the Qdrant client methods we use."""

    def __init__(self, existing=None, fail_retrieve=False, fail_upsert=False):
        self.points = {str(key): {"needs_embedding": False} for key in (existing or [])}
        self.fail_retrieve = fail_retrieve
        self.fail_upsert = fail_upsert
        self.upsert_calls = []

    def retrieve(self, collection_name, ids, with_payload=False, with_vectors=False):
        if self.fail_retrieve:
            raise RuntimeError("qdrant down")
        return [
            SimpleNamespace(id=pid, payload=self.points[str(pid)])
            for pid in ids
            if str(pid) in self.points
        ]

    def upsert(self, collection_name, points, wait=False):
        if self.fail_upsert:
            raise RuntimeError("upsert down")
        self.upsert_calls.append(points)
        for point in points:
            self.points[str(point.id)] = point.payload


class EmbeddingQueueTestCase(unittest.TestCase):
    def setUp(self):
        self.music_dir = tempfile.mkdtemp(prefix="puuk_embed_queue_")
        self.addCleanup(shutil.rmtree, self.music_dir, ignore_errors=True)
        self._old_music_dir = os.environ.get("MUSIC_DIR")
        os.environ["MUSIC_DIR"] = self.music_dir

    def tearDown(self):
        if self._old_music_dir is None:
            os.environ.pop("MUSIC_DIR", None)
        else:
            os.environ["MUSIC_DIR"] = self._old_music_dir

    def make_file(self, rel_path: str, content: bytes = b"audio") -> str:
        path = os.path.join(self.music_dir, rel_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(content)
        return path

    def make_track(self, rel_path: str, **overrides) -> dict:
        track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
        track = {
            "id": track_id,
            "file_path": rel_path,
            "title": "Song",
            "artist": "Artist",
            "duration": 120.0,
            "genre": "House",
        }
        track.update(overrides)
        return track


class TestEnqueueMissingTracks(EmbeddingQueueTestCase):
    def test_absent_track_is_enqueued_with_matching_id(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track("Artist - Song.mp3")
        client = FakeQdrant()

        counters = svc.enqueue_missing_tracks(client, [track], self.music_dir)

        self.assertEqual(counters["examined"], 1)
        self.assertEqual(counters["existing"], 0)
        self.assertEqual(counters["enqueued"], 1)
        self.assertEqual(counters["failed"], 0)

        point = client.upsert_calls[0][0]
        self.assertEqual(point.id, track["id"])
        self.assertEqual(len(point.vector), 400)
        self.assertTrue(all(v == 0.0 for v in point.vector))
        self.assertTrue(point.payload["needs_embedding"])
        self.assertEqual(point.payload["file_path"], "Artist - Song.mp3")
        self.assertEqual(point.payload["title"], "Song")
        self.assertEqual(point.payload["artist"], "Artist")
        self.assertEqual(point.payload["loudness_status"], "pending")
        self.assertIsNone(point.payload["normalization_gain_db"])

    def test_existing_processed_point_is_untouched(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track("Artist - Song.mp3")
        client = FakeQdrant(existing=[track["id"]])

        counters = svc.enqueue_missing_tracks(client, [track], self.music_dir)

        self.assertEqual(counters["existing"], 1)
        self.assertEqual(counters["enqueued"], 0)
        self.assertEqual(client.upsert_calls, [])

    def test_repeat_reconcile_creates_no_new_points(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track("Artist - Song.mp3")
        client = FakeQdrant()

        svc.enqueue_missing_tracks(client, [track], self.music_dir)
        second = svc.enqueue_missing_tracks(client, [track], self.music_dir)

        self.assertEqual(second["existing"], 1)
        self.assertEqual(second["enqueued"], 0)
        self.assertEqual(len(client.upsert_calls), 1)

    def test_existing_pending_point_is_not_reset(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track("Artist - Song.mp3")
        client = FakeQdrant(existing=[track["id"]])
        client.points[str(track["id"])] = {"needs_embedding": True, "marker": "keep"}

        svc.enqueue_missing_tracks(client, [track], self.music_dir)

        self.assertEqual(client.points[str(track["id"])], {"needs_embedding": True, "marker": "keep"})
        self.assertEqual(client.upsert_calls, [])

    def test_missing_file_is_skipped(self):
        track = self.make_track("not-on-disk.mp3")
        client = FakeQdrant()

        counters = svc.enqueue_missing_tracks(client, [track], self.music_dir)

        self.assertEqual(counters["missing_file"], 1)
        self.assertEqual(counters["enqueued"], 0)
        self.assertEqual(client.upsert_calls, [])

    def test_path_outside_music_root_is_skipped(self):
        outside_dir = tempfile.mkdtemp(prefix="puuk_outside_")
        self.addCleanup(shutil.rmtree, outside_dir, ignore_errors=True)
        with open(os.path.join(outside_dir, "evil.mp3"), "wb") as handle:
            handle.write(b"x")

        client = FakeQdrant()
        tracks = [
            self.make_track("../evil.mp3"),
            self.make_track(os.path.join(outside_dir, "evil.mp3")),
            self.make_track("/etc/passwd"),
        ]
        counters = svc.enqueue_missing_tracks(client, tracks, self.music_dir)

        self.assertEqual(counters["missing_file"], 3)
        self.assertEqual(client.upsert_calls, [])

    def test_invalid_id_is_skipped(self):
        self.make_file("weird.mp3")
        track = self.make_track("weird.mp3", id="test_api_track_123")
        client = FakeQdrant()

        counters = svc.enqueue_missing_tracks(client, [track], self.music_dir)

        self.assertEqual(counters["invalid_id"], 1)
        self.assertEqual(counters["enqueued"], 0)

    def test_integer_id_is_supported(self):
        self.make_file("numeric.mp3")
        track = self.make_track("numeric.mp3", id="12345")
        client = FakeQdrant()

        counters = svc.enqueue_missing_tracks(client, [track], self.music_dir)

        self.assertEqual(counters["enqueued"], 1)
        self.assertEqual(client.upsert_calls[0][0].id, 12345)

    def test_qdrant_read_error_is_not_treated_as_absent(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track("Artist - Song.mp3")
        client = FakeQdrant(fail_retrieve=True)

        with self.assertRaises(svc.EmbeddingQueueError):
            svc.enqueue_missing_tracks(client, [track], self.music_dir)
        self.assertEqual(client.upsert_calls, [])

    def test_qdrant_upsert_error_is_counted(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track("Artist - Song.mp3")
        client = FakeQdrant(fail_upsert=True)

        counters = svc.enqueue_missing_tracks(client, [track], self.music_dir)

        self.assertEqual(counters["enqueued"], 0)
        self.assertEqual(counters["failed"], 1)

    def test_limit_caps_created_points(self):
        tracks = []
        for name in ("a.mp3", "b.mp3", "c.mp3"):
            self.make_file(name)
            tracks.append(self.make_track(name))
        client = FakeQdrant()

        counters = svc.enqueue_missing_tracks(client, tracks, self.music_dir, limit=1)

        self.assertEqual(counters["would_enqueue"], 1)
        self.assertEqual(counters["enqueued"], 1)
        self.assertEqual(len(client.upsert_calls[0]), 1)

    def test_dry_run_writes_nothing(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track("Artist - Song.mp3")
        client = FakeQdrant()

        counters = svc.enqueue_missing_tracks(client, [track], self.music_dir, dry_run=True)

        self.assertEqual(counters["would_enqueue"], 1)
        self.assertEqual(counters["enqueued"], 0)
        self.assertEqual(client.upsert_calls, [])

    def test_analyzed_loudness_matching_file_is_preserved(self):
        path = self.make_file("Artist - Song.mp3")
        stat = os.stat(path)
        track = self.make_track(
            "Artist - Song.mp3",
            loudness_status="analyzed",
            loudness_lufs=-9.5,
            normalization_gain_db=1.5,
            loudness_file_size=stat.st_size,
            loudness_file_mtime_ns=stat.st_mtime_ns,
        )
        client = FakeQdrant()

        svc.enqueue_missing_tracks(client, [track], self.music_dir)

        payload = client.upsert_calls[0][0].payload
        self.assertEqual(payload["loudness_status"], "analyzed")
        self.assertEqual(payload["normalization_gain_db"], 1.5)
        self.assertEqual(payload["loudness_lufs"], -9.5)

    def test_stale_loudness_is_reset_to_pending(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track(
            "Artist - Song.mp3",
            loudness_status="analyzed",
            loudness_lufs=-9.5,
            normalization_gain_db=1.5,
            loudness_file_size=1,
            loudness_file_mtime_ns=1,
        )
        client = FakeQdrant()

        svc.enqueue_missing_tracks(client, [track], self.music_dir)

        payload = client.upsert_calls[0][0].payload
        self.assertEqual(payload["loudness_status"], "pending")
        self.assertIsNone(payload["normalization_gain_db"])
        self.assertIsNone(payload["loudness_lufs"])


class TestReconcileEmbeddingQueue(EmbeddingQueueTestCase):
    def test_reconcile_recovers_track_already_present_in_sqlite(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track("Artist - Song.mp3")
        client = FakeQdrant()

        with patch.object(db, "get_tracks_for_embedding_reconcile", return_value=[track]):
            counters = svc.reconcile_embedding_queue(client)

        self.assertEqual(counters["examined"], 1)
        self.assertEqual(counters["enqueued"], 1)
        self.assertEqual(client.upsert_calls[0][0].id, track["id"])

    def test_reconcile_skips_unrecoverable_tracks(self):
        # Tracks without a present file must not be recreated (deleted audio).
        client = FakeQdrant()
        with patch.object(db, "get_tracks_for_embedding_reconcile", return_value=[
            {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "gone.mp3")), "file_path": "gone.mp3"},
        ]):
            counters = svc.reconcile_embedding_queue(client)

        self.assertEqual(counters["missing_file"], 1)
        self.assertEqual(counters["enqueued"], 0)

    def test_next_pass_recovers_after_qdrant_outage(self):
        self.make_file("Artist - Song.mp3")
        track = self.make_track("Artist - Song.mp3")

        with patch.object(db, "get_tracks_for_embedding_reconcile", return_value=[track]):
            with self.assertRaises(svc.EmbeddingQueueError):
                svc.reconcile_embedding_queue(FakeQdrant(fail_retrieve=True))

            client = FakeQdrant()
            counters = svc.reconcile_embedding_queue(client)

        self.assertEqual(counters["enqueued"], 1)


class TestCoercePointId(unittest.TestCase):
    def test_uuid_is_canonicalized(self):
        value = "9C200BC4-99D6-55A5-B95D-69BA3B788F29"
        self.assertEqual(svc.coerce_point_id(value), str(uuid.UUID(value)))

    def test_unsigned_integer(self):
        self.assertEqual(svc.coerce_point_id("42"), 42)

    def test_non_numeric_string_is_invalid(self):
        self.assertIsNone(svc.coerce_point_id("test_api_track_123"))

    def test_none_is_invalid(self):
        self.assertIsNone(svc.coerce_point_id(None))


if __name__ == "__main__":
    unittest.main()
