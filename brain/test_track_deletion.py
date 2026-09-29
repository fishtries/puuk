"""Тесты удаления трека (repositories.tracks.delete_track + services.track_deletion_service).

Проверяет:
- удаление строки трека и журнала мутаций одной транзакцией;
- FK-каскады (плейлисты, избранное, история) и очистку пустых альбомов;
- RBAC: админ / владелец / чужой пользователь;
- строгий резолв файла: отсутствие файла не блокирует удаление записи,
  неоднозначный basename отменяет удаление (409);
- сбой Qdrant (502) и сбой удаления файла (500) оставляют БД нетронутой.
"""
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД

import db
from fastapi import HTTPException
from repositories.tracks import delete_track


class DeleteTrackRepositoryTest(unittest.TestCase):
    def setUp(self):
        self.track_id = f"del-track-{uuid.uuid4().hex[:8]}"
        db.add_or_update_track(
            track_id=self.track_id,
            file_path=f"test/{self.track_id}.mp3",
            title="Delete Me",
            album_id=None,
            artist="Test Artist",
        )

    def test_delete_track_removes_row_and_journal(self):
        journal_id = db.log_mutation_journal(self.track_id, "prepared", 123, 456)

        self.assertTrue(delete_track(self.track_id))
        self.assertIsNone(db.get_track(self.track_id))
        conn = db.get_connection()
        rows = conn.execute(
            "SELECT COUNT(*) AS c FROM track_mutation_journal WHERE id = ?", (journal_id,)
        ).fetchone()
        conn.close()
        self.assertEqual(rows["c"], 0)

    def test_delete_missing_track_returns_false(self):
        self.assertFalse(delete_track("no-such-track-id"))

    def test_delete_cascades_and_cleans_empty_album(self):
        album_id = db.resolve_album("Delete Cascade Album", album_artist="Artist", year=2020)
        db.add_or_update_track(
            track_id=self.track_id,
            file_path=f"test/{self.track_id}.mp3",
            title="Delete Me",
            album_id=album_id,
            artist="Test Artist",
        )
        db.add_track_to_playlist(db.create_playlist("Delete Cascades"), self.track_id)
        db.add_favorite(1, self.track_id)
        db.add_history(1, self.track_id)

        self.assertTrue(delete_track(self.track_id))

        conn = db.get_connection()
        try:
            cur = conn.cursor()
            self.assertEqual(
                cur.execute("SELECT COUNT(*) AS c FROM playlist_tracks WHERE track_id = ?", (self.track_id,)).fetchone()["c"], 0
            )
            self.assertEqual(
                cur.execute("SELECT COUNT(*) AS c FROM user_favorites WHERE track_id = ?", (self.track_id,)).fetchone()["c"], 0
            )
            self.assertEqual(
                cur.execute("SELECT COUNT(*) AS c FROM user_history WHERE track_id = ?", (self.track_id,)).fetchone()["c"], 0
            )
        finally:
            conn.close()

    def test_delete_keeps_non_empty_album(self):
        album_id = db.resolve_album("Survivor Album", album_artist="Artist", year=2020)
        db.add_or_update_track(
            track_id=self.track_id,
            file_path=f"test/{self.track_id}.mp3",
            title="Delete Me",
            album_id=album_id,
            artist="Test Artist",
        )
        survivor_id = f"survivor-{uuid.uuid4().hex[:8]}"
        db.add_or_update_track(
            track_id=survivor_id,
            file_path=f"test/{survivor_id}.mp3",
            title="Survivor",
            album_id=album_id,
            artist="Test Artist",
        )

        delete_track(self.track_id)

        self.assertIsNotNone(db.get_album(album_id))
        delete_track(survivor_id)


class DeleteTrackEverywhereTest(unittest.TestCase):
    def setUp(self):
        self.music_dir = tempfile.mkdtemp(prefix="puuk-del-music-")
        self._old_music_dir = os.environ.get("MUSIC_DIR")
        os.environ["MUSIC_DIR"] = self.music_dir

        self.owner_id = db.create_user(f"owner-{uuid.uuid4().hex[:8]}", role="user")
        self.admin_id = db.create_user(f"admin-{uuid.uuid4().hex[:8]}", role="admin")
        self.stranger_id = db.create_user(f"stranger-{uuid.uuid4().hex[:8]}", role="user")

        self.track_id = f"del-svc-{uuid.uuid4().hex[:8]}"
        self.file_name = f"{self.track_id}.mp3"
        self.file_path = os.path.join(self.music_dir, self.file_name)
        with open(self.file_path, "wb") as f:
            f.write(b"audio")
        db.add_or_update_track(
            track_id=self.track_id,
            file_path=self.file_name,
            title="Delete Everywhere",
            album_id=None,
            artist="Test Artist",
            added_by_user_id=self.owner_id,
        )
        self.admin = {"id": self.admin_id, "role": "admin"}
        self.owner = {"id": self.owner_id, "role": "user"}
        self.stranger = {"id": self.stranger_id, "role": "user"}

    def tearDown(self):
        if self._old_music_dir is None:
            os.environ.pop("MUSIC_DIR", None)
        else:
            os.environ["MUSIC_DIR"] = self._old_music_dir
        shutil.rmtree(self.music_dir, ignore_errors=True)

    def _service(self):
        from services.track_deletion_service import delete_track_everywhere
        return delete_track_everywhere

    def test_owner_deletes_track_and_file(self):
        with patch("services.track_deletion_service.qdrant_client") as mock_qdrant:
            result = self._service()(self.track_id, self.owner)

        self.assertEqual(result["status"], "success")
        self.assertTrue(result["file_deleted"])
        self.assertFalse(os.path.exists(self.file_path))
        self.assertIsNone(db.get_track(self.track_id))
        mock_qdrant.delete.assert_called_once()

    def test_admin_deletes_system_track(self):
        conn = db.get_connection()
        conn.execute("UPDATE tracks SET added_by_user_id = NULL WHERE id = ?", (self.track_id,))
        conn.commit()
        conn.close()

        with patch("services.track_deletion_service.qdrant_client"):
            result = self._service()(self.track_id, self.admin)

        self.assertEqual(result["status"], "success")
        self.assertIsNone(db.get_track(self.track_id))

    def test_stranger_forbidden(self):
        with patch("services.track_deletion_service.qdrant_client"):
            with self.assertRaises(HTTPException) as ctx:
                self._service()(self.track_id, self.stranger)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIsNotNone(db.get_track(self.track_id))
        self.assertTrue(os.path.exists(self.file_path))

    def test_service_cleans_empty_album(self):
        album_id = db.resolve_album("Svc Empty Album", album_artist="Artist", year=2020)
        db.add_or_update_track(
            track_id=self.track_id,
            file_path=self.file_name,
            title="Delete Everywhere",
            album_id=album_id,
            artist="Test Artist",
            added_by_user_id=self.owner_id,
        )

        with patch("services.track_deletion_service.qdrant_client"):
            self._service()(self.track_id, self.owner)

        self.assertIsNone(db.get_album(album_id))

    def test_missing_file_still_deletes_stale_record(self):
        os.remove(self.file_path)

        with patch("services.track_deletion_service.qdrant_client"):
            result = self._service()(self.track_id, self.owner)

        self.assertEqual(result["file_deleted"], False)
        self.assertIsNone(db.get_track(self.track_id))

    def test_ambiguous_basename_aborts(self):
        fake_temp_audio = tempfile.mkdtemp(prefix="puuk-del-temp-")
        self.addCleanup(shutil.rmtree, fake_temp_audio, ignore_errors=True)
        duplicate_path = os.path.join(fake_temp_audio, self.file_name)
        with open(duplicate_path, "wb") as f:
            f.write(b"other")
        with patch("services.track_deletion_service._temp_audio_dir", return_value=fake_temp_audio), \
             patch("services.track_deletion_service.qdrant_client"):
            with self.assertRaises(HTTPException) as ctx:
                self._service()(self.track_id, self.owner)

        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIsNotNone(db.get_track(self.track_id))
        self.assertTrue(os.path.exists(self.file_path))
        self.assertTrue(os.path.exists(duplicate_path))

    def test_qdrant_failure_keeps_file_and_record(self):
        failing = Mock()
        failing.delete.side_effect = RuntimeError("connection refused")
        with patch("services.track_deletion_service.qdrant_client", failing):
            with self.assertRaises(HTTPException) as ctx:
                self._service()(self.track_id, self.owner)

        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIsNotNone(db.get_track(self.track_id))
        self.assertTrue(os.path.exists(self.file_path))

    def test_file_remove_failure_keeps_record(self):
        with patch("services.track_deletion_service.qdrant_client"), \
             patch("os.remove", side_effect=OSError(1, "permission denied")):
            with self.assertRaises(HTTPException) as ctx:
                self._service()(self.track_id, self.owner)

        self.assertEqual(ctx.exception.status_code, 500)
        self.assertIsNotNone(db.get_track(self.track_id))

    def test_traversal_path_degrades_to_stale_record_deletion(self):
        conn = db.get_connection()
        conn.execute("UPDATE tracks SET file_path = ? WHERE id = ?", ("../../etc/passwd", self.track_id))
        conn.commit()
        conn.close()

        with patch("services.track_deletion_service.qdrant_client"):
            result = self._service()(self.track_id, self.owner)

        self.assertEqual(result["file_deleted"], False)
        self.assertIsNone(db.get_track(self.track_id))


if __name__ == "__main__":
    unittest.main()
