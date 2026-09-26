import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

from fastapi.testclient import TestClient
import db
import auth  # noqa: F401 — единообразие с test_phase3
from security import hash_password
from api import app


class TestPlaylistOrder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)

        for name in ["erin_po", "frank_po"]:
            existing = db.get_user_by_username(name)
            if existing:
                db.delete_user(existing["id"])

        cls.owner_id = db.create_user("erin_po", hash_password("pass_erin"), role="user")
        cls.stranger_id = db.create_user("frank_po", hash_password("pass_frank"), role="user")

        resp_owner = cls.client.post("/api/auth/login", json={"username": "erin_po", "password": "pass_erin"})
        cls.headers_owner = {"Authorization": f"Bearer {resp_owner.json()['access_token']}"}

        resp_stranger = cls.client.post("/api/auth/login", json={"username": "frank_po", "password": "pass_frank"})
        cls.headers_stranger = {"Authorization": f"Bearer {resp_stranger.json()['access_token']}"}

        # Три трека для основного плейлиста + один для проверки изоляции удаления
        cls.tracks = {}
        for idx in range(3):
            track_id = str(uuid.uuid4())
            cls.tracks[f"t{idx + 1}"] = track_id
            db.add_or_update_track(
                track_id=track_id,
                file_path=f"music/order_{idx}.mp3",
                title=f"Order Track {idx + 1}",
                album_id=None,
                artist="Order Artist",
                lyrics="",
                added_by_user_id=cls.owner_id,
            )

        # Владелец создаёт плейлист (имя с пробелами -> trim заодно проверится в test_05)
        create_resp = cls.client.post("/api/playlists", json={"name": "Order Mix"}, headers=cls.headers_owner)
        assert create_resp.status_code == 200, create_resp.text
        cls.playlist_id = create_resp.json()["id"]

    # --- helpers -----------------------------------------------------------

    def _add_track(self, track_id: str):
        return self.client.post(
            f"/api/playlists/{self.playlist_id}/tracks",
            json={"track_id": track_id},
            headers=self.headers_owner,
        )

    def _track_order(self) -> list:
        details = self.client.get(f"/api/playlists/{self.playlist_id}", headers=self.headers_owner)
        self.assertEqual(details.status_code, 200)
        return [t["id"] for t in details.json()["tracks"]]

    def _reorder(self, track_ids, headers=None):
        # headers={} (аноним) валиден: проверяем именно None, а не falsy
        if headers is None:
            headers = self.headers_owner
        return self.client.put(
            f"/api/playlists/{self.playlist_id}/tracks/order",
            json={"track_ids": track_ids},
            headers=headers,
        )

    # --- tests -------------------------------------------------------------

    def test_01_new_tracks_appended_in_addition_order(self):
        order = [self.tracks["t1"], self.tracks["t2"], self.tracks["t3"]]
        for track_id in order:
            add_resp = self._add_track(track_id)
            self.assertEqual(add_resp.status_code, 200)
            self.assertEqual(add_resp.json()["status"], "added")
        self.assertEqual(self._track_order(), order)

    def test_02_reorder_full_list_persists(self):
        new_order = [self.tracks["t3"], self.tracks["t1"], self.tracks["t2"]]
        resp = self._reorder(new_order)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"status": "success"})
        # Повторный GET: порядок сохранился
        self.assertEqual(self._track_order(), new_order)
        self.assertEqual(self._track_order(), new_order)

    def test_03_reorder_invalid_composition_returns_400_and_keeps_order(self):
        t1, t2, t3 = self.tracks["t1"], self.tracks["t2"], self.tracks["t3"]
        before = self._track_order()
        invalid_payloads = [
            [t1, t2],                      # неполный список
            [t1, t1, t2, t3],              # дубликат
            [t1, t2, t3, "no-such-track"], # неизвестный track_id
            [],                            # пустой список
        ]
        for payload in invalid_payloads:
            resp = self._reorder(payload)
            self.assertEqual(resp.status_code, 400, f"payload={payload}")
        self.assertEqual(self._track_order(), before)

    def test_04_reorder_permissions(self):
        t1, t2, t3 = self.tracks["t1"], self.tracks["t2"], self.tracks["t3"]
        before = self._track_order()  # порядок из test_02, не предполагаем [t1,t2,t3]
        # Чужой пользователь -> 403, порядок не изменился
        resp_stranger = self._reorder([t2, t3, t1], headers=self.headers_stranger)
        self.assertEqual(resp_stranger.status_code, 403)
        self.assertEqual(self._track_order(), before)
        # Аноним -> 401
        resp_anon = self._reorder(before, headers={})
        self.assertEqual(resp_anon.status_code, 401)
        # Несуществующий плейлист -> 404
        resp_missing = self.client.put(
            "/api/playlists/99999999/tracks/order",
            json={"track_ids": [t1]},
            headers=self.headers_owner,
        )
        self.assertEqual(resp_missing.status_code, 404)

    def test_05_name_validation(self):
        # Пустое имя / только пробелы / слишком длинное -> 422
        for bad_name in ["", "   ", "x" * 101]:
            resp = self.client.post("/api/playlists", json={"name": bad_name}, headers=self.headers_owner)
            self.assertEqual(resp.status_code, 422, f"name={bad_name!r}")
        # Валидное имя с пробелами -> trim
        resp = self.client.post(
            "/api/playlists", json={"name": "  Spaced Name  "}, headers=self.headers_owner
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["name"], "Spaced Name")
        # PATCH с невалидным именем тоже 422
        patch_resp = self.client.patch(
            f"/api/playlists/{self.playlist_id}",
            json={"name": "  "},
            headers=self.headers_owner,
        )
        self.assertEqual(patch_resp.status_code, 422)

    def test_06_duplicate_add_keeps_order_and_position(self):
        before = self._track_order()
        dup_resp = self._add_track(self.tracks["t1"])
        self.assertEqual(dup_resp.status_code, 200)
        self.assertEqual(dup_resp.json()["status"], "already_exists")
        # Порядок (и позиции) не изменились
        self.assertEqual(self._track_order(), before)

    def test_08_list_returns_track_count(self):
        # track_count в списке совпадает с фактическим числом треков плейлиста
        lists = self.client.get("/api/playlists", headers=self.headers_owner).json()
        by_id = {p["id"]: p for p in lists}
        self.assertIn(self.playlist_id, by_id)
        details = self.client.get(f"/api/playlists/{self.playlist_id}", headers=self.headers_owner).json()
        self.assertEqual(by_id[self.playlist_id]["track_count"], len(details["tracks"]))
        # После удаления связи счётчик уменьшается
        remove_resp = self.client.delete(
            f"/api/playlists/{self.playlist_id}/tracks/{self.tracks['t3']}",
            headers=self.headers_owner,
        )
        self.assertEqual(remove_resp.status_code, 200)
        lists = self.client.get("/api/playlists", headers=self.headers_owner).json()
        by_id = {p["id"]: p for p in lists}
        self.assertEqual(by_id[self.playlist_id]["track_count"], len(details["tracks"]) - 1)
        # Восстанавливаем связь для остальных тестов
        self.assertEqual(self._add_track(self.tracks["t3"]).json()["status"], "added")

    def test_07_removing_link_keeps_track_in_library_and_other_playlist(self):
        # Отдельный трек сразу в двух плейлистах
        track_id = str(uuid.uuid4())
        db.add_or_update_track(
            track_id=track_id,
            file_path="music/shared_track.mp3",
            title="Shared Track",
            album_id=None,
            artist="Order Artist",
            lyrics="",
            added_by_user_id=self.owner_id,
        )
        self.addCleanup(self._delete_track, track_id)

        playlist_ids = [self.playlist_id]
        for _ in range(1):
            create_resp = self.client.post(
                "/api/playlists", json={"name": "Second Mix"}, headers=self.headers_owner
            )
            self.assertEqual(create_resp.status_code, 200)
            second_id = create_resp.json()["id"]
            playlist_ids.append(second_id)
            self.addCleanup(self._delete_playlist, second_id)

        for pid in playlist_ids:
            add_resp = self.client.post(
                f"/api/playlists/{pid}/tracks", json={"track_id": track_id}, headers=self.headers_owner
            )
            self.assertEqual(add_resp.status_code, 200)

        # Удаляем связь из первого плейлиста
        remove_resp = self.client.delete(
            f"/api/playlists/{self.playlist_id}/tracks/{track_id}", headers=self.headers_owner
        )
        self.assertEqual(remove_resp.status_code, 200)

        # Трек остался в библиотеке
        lib_resp = self.client.get("/api/tracks?limit=500", headers=self.headers_owner)
        self.assertEqual(lib_resp.status_code, 200)
        self.assertTrue(any(t["id"] == track_id for t in lib_resp.json()))
        # И остался во втором плейлисте
        second_details = self.client.get(f"/api/playlists/{second_id}", headers=self.headers_owner)
        self.assertTrue(any(t["id"] == track_id for t in second_details.json()["tracks"]))

    # --- cleanup helpers ----------------------------------------------------

    def _delete_playlist(self, playlist_id: int):
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
        conn.commit()
        conn.close()

    def _delete_track(self, track_id: str):
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
        conn.close()

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.owner_id)
        db.delete_user(cls.stranger_id)
        conn = db.get_connection()
        for track_id in cls.tracks.values():
            conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
        conn.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
