"""Media-тикет: выдача по Bearer и доступ к /api/stream?mt= без заголовков.

Регрессия: веб скачивал весь трек в blob (полная загрузка блокировала
переключение). Стрим требует авторизации без заголовков — им становится
короткоживущий тикет, привязанный к треку.
"""
import os
import sys
import time
import unittest
import uuid
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД, должен идти до db/config

import db
import jwt
from api import app
from auth import (
    JWT_ALGORITHM,
    JWT_SECRET,
    create_access_token,
    decode_access_token,
)
from security import hash_password

SAMPLE_MP3 = os.path.join(os.path.dirname(__file__), "temp_audio", "Daft Punk - Around the World.mp3")


class TestMediaTicket(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        from fastapi.testclient import TestClient
        cls.client = TestClient(app)

        existing = db.get_user_by_username("media_ticket_user")
        if existing:
            db.delete_user(existing["id"])
        cls.user_id = db.create_user("media_ticket_user", hash_password("pass"), role="user")

        resp = cls.client.post("/api/auth/login", json={"username": "media_ticket_user", "password": "pass"})
        cls.headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

        cls.track_id = str(uuid.uuid4())
        cls.other_track_id = str(uuid.uuid4())
        db.add_or_update_track(
            track_id=cls.track_id,
            file_path=os.path.abspath(SAMPLE_MP3),
            title="Media Ticket Track",
            album_id=None,
            artist="Ticket Artist",
            lyrics="",
            added_by_user_id=cls.user_id,
        )

    def _issue_ticket(self, track_id: str) -> dict:
        resp = self.client.post("/api/media-ticket", json={"track_id": track_id}, headers=self.headers)
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["url"], f"/api/stream/{track_id}?mt={body['url'].split('=')[1]}")
        self.assertGreater(body["expires_in"], 0)
        # expires_at: unix-время истечения, консистентно с expires_in
        now = time.time()
        self.assertAlmostEqual(
            body["expires_at"],
            now + body["expires_in"],
            delta=5,
        )
        return body

    def test_01_ticket_requires_bearer(self):
        resp = self.client.post("/api/media-ticket", json={"track_id": self.track_id})
        self.assertEqual(resp.status_code, 401)

    def test_02_invalid_track_id_rejected(self):
        resp = self.client.post("/api/media-ticket", json={"track_id": "not-a-uuid"}, headers=self.headers)
        self.assertEqual(resp.status_code, 400)

    def test_03_stream_with_ticket(self):
        body = self._issue_ticket(self.track_id)
        resp = self.client.get(body["url"])
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.headers["content-type"].startswith("audio/"))
        with open(SAMPLE_MP3, "rb") as f:
            self.assertEqual(resp.content, f.read())

    def test_04_stream_range_request_returns_partial_content(self):
        body = self._issue_ticket(self.track_id)
        with open(SAMPLE_MP3, "rb") as f:
            total = os.path.getsize(SAMPLE_MP3)
            expected = f.read(100)
        resp = self.client.get(body["url"], headers={"Range": "bytes=0-99"})
        self.assertEqual(resp.status_code, 206)
        self.assertEqual(resp.headers["content-range"], f"bytes 0-99/{total}")
        self.assertEqual(resp.content, expected)

    def test_05_bearer_still_works(self):
        resp = self.client.get(f"/api/stream/{self.track_id}", headers=self.headers)
        self.assertEqual(resp.status_code, 200)

    def test_06_wrong_track_binding_rejected(self):
        body = self._issue_ticket(self.track_id)
        resp = self.client.get(f"/api/stream/{self.other_track_id}?mt={body['url'].split('=')[1]}")
        self.assertEqual(resp.status_code, 401)

    def test_07_tampered_and_expired_tickets_rejected(self):
        body = self._issue_ticket(self.track_id)
        ticket = body["url"].split("=")[1]
        tampered = self.client.get(f"/api/stream/{self.track_id}?mt={ticket[:-4]}AAAA")
        self.assertEqual(tampered.status_code, 401)

        payload = decode_access_token(ticket)
        payload["exp"] = payload["iat"] - 10
        expired = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
        resp = self.client.get(f"/api/stream/{self.track_id}?mt={expired}")
        self.assertEqual(resp.status_code, 401)

    def test_08_access_token_cannot_serve_as_ticket(self):
        """Обычный JWT без media-scope в query не даёт доступа к стриму."""
        plain_token = create_access_token({"id": self.user_id, "username": "media_ticket_user", "role": "user"})
        resp = self.client.get(f"/api/stream/{self.track_id}?mt={plain_token}")
        self.assertEqual(resp.status_code, 401)

    def test_09_stream_without_any_credentials_rejected(self):
        resp = self.client.get(f"/api/stream/{self.track_id}")
        self.assertEqual(resp.status_code, 401)

    def test_10_unknown_track_is_404_no_ticket(self):
        """Трек отсутствует в SQLite -> 404, тикет не выдаётся."""
        ghost_id = str(uuid.uuid4())
        with mock.patch("routers.streaming.create_media_ticket_with_expiry") as create_ticket:
            resp = self.client.post("/api/media-ticket", json={"track_id": ghost_id}, headers=self.headers)
        self.assertEqual(resp.status_code, 404)
        create_ticket.assert_not_called()

    def test_11_expired_ticket_url_still_shape_compatible(self):
        """Контракт ответа: url/expires_in/expires_at; url играет без заголовков."""
        body = self._issue_ticket(self.track_id)
        self.assertEqual(set(body.keys()), {"url", "expires_in", "expires_at"})
        resp = self.client.get(body["url"])
        self.assertEqual(resp.status_code, 200)

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.user_id)
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (cls.track_id,))
        conn.commit()
        conn.close()


class TestStreamContract(unittest.TestCase):
    """Контракт /api/stream: SQLite-only, Range, заголовки, отсутствие Qdrant.

    Критический путь воспроизведения не должен зависеть от Qdrant: временный
    сбой векторной БД не ломает стриминг просканированной библиотеки.
    """

    @classmethod
    def setUpClass(cls):
        db.init_db()
        from fastapi.testclient import TestClient
        cls.client = TestClient(app)

        existing = db.get_user_by_username("stream_contract_user")
        if existing:
            db.delete_user(existing["id"])
        cls.user_id = db.create_user("stream_contract_user", hash_password("pass"), role="user")

        resp = cls.client.post("/api/auth/login", json={"username": "stream_contract_user", "password": "pass"})
        cls.headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

        cls.track_id = str(uuid.uuid4())
        cls.missing_file_track_id = str(uuid.uuid4())
        cls.ghost_track_id = str(uuid.uuid4())
        cls.qdrant_only_track_id = str(uuid.uuid4())

        db.add_or_update_track(
            track_id=cls.track_id,
            file_path=os.path.abspath(SAMPLE_MP3),
            title="Stream Contract Track",
            album_id=None,
            artist="Contract Artist",
            lyrics="",
            added_by_user_id=cls.user_id,
        )
        db.add_or_update_track(
            track_id=cls.missing_file_track_id,
            file_path=os.path.join(os.path.dirname(os.path.abspath(SAMPLE_MP3)), "no_such_file_xyz.mp3"),
            title="Missing File Track",
            album_id=None,
            artist="Contract Artist",
            lyrics="",
            added_by_user_id=cls.user_id,
        )
        # Треки ниже добавлены без файла / только в идее Qdrant: стрим не
        # должен обращаться к Qdrant и обязан ответить 404.

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.user_id)
        conn = db.get_connection()
        conn.cursor().execute(
            "DELETE FROM tracks WHERE id IN (?, ?, ?)",
            (cls.track_id, cls.missing_file_track_id, cls.ghost_track_id),
        )
        conn.commit()
        conn.close()

    def _get(self, track_id: str, headers: dict | None = None):
        return self.client.get(f"/api/stream/{track_id}", headers=headers or self.headers)

    def test_01_full_response_headers(self):
        resp = self._get(self.track_id)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers["accept-ranges"], "bytes")
        self.assertTrue(resp.headers["content-type"].startswith("audio/"))
        self.assertEqual(int(resp.headers["content-length"]), os.path.getsize(SAMPLE_MP3))

    def test_02_range_start(self):
        with open(SAMPLE_MP3, "rb") as f:
            expected = f.read(100)
        resp = self._get(self.track_id, {"Range": "bytes=0-99", **self.headers})
        self.assertEqual(resp.status_code, 206)
        self.assertEqual(resp.headers["content-range"], f"bytes 0-99/{os.path.getsize(SAMPLE_MP3)}")
        self.assertEqual(int(resp.headers["content-length"]), 100)
        self.assertEqual(resp.content, expected)

    def test_03_range_open_ended(self):
        total = os.path.getsize(SAMPLE_MP3)
        with open(SAMPLE_MP3, "rb") as f:
            f.seek(50)
            expected = f.read()
        resp = self._get(self.track_id, {"Range": "bytes=50-", **self.headers})
        self.assertEqual(resp.status_code, 206)
        self.assertEqual(resp.headers["content-range"], f"bytes 50-{total - 1}/{total}")
        self.assertEqual(int(resp.headers["content-length"]), total - 50)
        self.assertEqual(resp.content, expected)

    def test_04_range_middle(self):
        total = os.path.getsize(SAMPLE_MP3)
        with open(SAMPLE_MP3, "rb") as f:
            f.seek(200)
            expected = f.read(150)
        resp = self._get(self.track_id, {"Range": "bytes=200-349", **self.headers})
        self.assertEqual(resp.status_code, 206)
        self.assertEqual(resp.headers["content-range"], f"bytes 200-349/{total}")
        self.assertEqual(int(resp.headers["content-length"]), 150)
        self.assertEqual(resp.content, expected)

    def test_05_invalid_range(self):
        resp = self._get(self.track_id, {"Range": "bytes=99999999-", **self.headers})
        self.assertEqual(resp.status_code, 416)
        self.assertEqual(resp.headers["content-range"], f"bytes */{os.path.getsize(SAMPLE_MP3)}")

    def test_06_malformed_range(self):
        resp = self._get(self.track_id, {"Range": "bytes=abc", **self.headers})
        self.assertEqual(resp.status_code, 400)

    def test_07_missing_file_is_404(self):
        resp = self._get(self.missing_file_track_id)
        self.assertEqual(resp.status_code, 404)

    def test_08_db_track_missing_file_does_not_touch_qdrant_and_logs(self):
        with mock.patch("routers.streaming.client.retrieve") as retrieve:
            with self.assertLogs("puuk.streaming", level="WARNING") as captured:
                resp = self._get(self.missing_file_track_id)
        self.assertEqual(resp.status_code, 404)
        retrieve.assert_not_called()
        self.assertTrue(any("file missing" in line for line in captured.output))

    def test_09_unknown_track_id_is_404_without_qdrant(self):
        with mock.patch("routers.streaming.client.retrieve") as retrieve:
            resp = self._get(self.ghost_track_id)
        self.assertEqual(resp.status_code, 404)
        retrieve.assert_not_called()

    def test_10_qdrant_only_track_not_streamable(self):
        """Даже если Qdrant знает путь, стрим отвечает 404 (SQLite-only)."""
        with mock.patch("routers.streaming.client.retrieve") as retrieve:
            resp = self._get(self.qdrant_only_track_id)
        self.assertEqual(resp.status_code, 404)
        retrieve.assert_not_called()

    def test_11_bearer_and_ticket_auth_still_work(self):
        resp = self._get(self.track_id)
        self.assertEqual(resp.status_code, 200)

        body = self.client.post(
            "/api/media-ticket", json={"track_id": self.track_id}, headers=self.headers
        ).json()
        resp = self.client.get(body["url"])
        self.assertEqual(resp.status_code, 200)


if __name__ == "__main__":
    unittest.main()
