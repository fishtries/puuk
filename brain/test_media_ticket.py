"""Media-тикет: выдача по Bearer и доступ к /api/stream?mt= без заголовков.

Регрессия: веб скачивал весь трек в blob (полная загрузка блокировала
переключение). Стрим требует авторизации без заголовков — им становится
короткоживущий тикет, привязанный к треку.
"""
import os
import sys
import unittest
import uuid

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

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.user_id)
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (cls.track_id,))
        conn.commit()
        conn.close()


if __name__ == "__main__":
    unittest.main()
