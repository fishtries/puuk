import asyncio
import os
import sys
import shutil
import tempfile
import unittest
import uuid

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../brain")))
sys.path.insert(0, os.path.dirname(__file__))

import test_db_path  # noqa: F401 — изолирует тестовую БД и отключает доставку в рабочий Qdrant

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
import db
from api import app
from bot import get_puuk_user, is_user_allowed, generate_otp_code, index_downloaded_tracks
from import_progress import progress_reporter, ytdlp_progress
from telegram_imports import TelegramImports

class TestPhase4TelegramBot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init_db()
        cls.client = TestClient(app)

        # Тестовый пользователь с Telegram ID
        existing = db.get_user_by_username("tg_tester")
        if existing:
            db.delete_user(existing["id"])

        cls.tg_id = 777888999
        cls.user_id = db.create_user("tg_tester", role="user", telegram_id=cls.tg_id)

    def test_01_user_lookup_and_permissions(self):
        user = get_puuk_user(self.tg_id)
        self.assertIsNotNone(user)
        self.assertEqual(user["id"], self.user_id)
        self.assertEqual(user["username"], "tg_tester")
        self.assertTrue(is_user_allowed(self.tg_id))

        # Неизвестный пользователь
        unknown_id = 999999999
        self.assertIsNone(get_puuk_user(unknown_id))
        self.assertFalse(is_user_allowed(unknown_id))

    def test_02_otp_code_generation_and_api_login(self):
        # Бот генерирует OTP код для пользователя
        code = generate_otp_code(self.user_id)
        self.assertEqual(len(code), 6)
        self.assertTrue(code.isdigit())

        # Пользователь вводит этот код в мобильном приложении / веб-клиенте
        login_resp = self.client.post("/api/auth/verify-code", json={"code": code})
        self.assertEqual(login_resp.status_code, 200)
        data = login_resp.json()
        self.assertIn("access_token", data)
        self.assertEqual(data["user"]["id"], self.user_id)
        self.assertEqual(data["user"]["username"], "tg_tester")

    def test_03_download_auto_favoriting(self):
        # Симулируем успешную загрузку трека ботом в режиме 'server'
        track_title = "Bot Downloaded Track"
        track_artist = "Bot Artist"
        rel_path = f"{track_title} - {track_artist}.mp3"
        track_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))

        # Действие, которое делает бот при скачивании
        db.add_or_update_track(
            track_id=track_uuid,
            file_path=rel_path,
            title=track_title,
            album_id=None,
            artist=track_artist,
            added_by_user_id=self.user_id
        )
        db.add_favorite(self.user_id, track_uuid)

        # Проверяем, что трек появился в базе и привязан к пользователю
        track = db.get_track(track_uuid)
        self.assertIsNotNone(track)
        self.assertEqual(track["added_by_user_id"], self.user_id)

        # Проверяем, что трек автоматически добавлен в Избранное пользователя
        self.assertTrue(db.is_favorite(self.user_id, track_uuid))

        # Чистим тестовый трек
        conn = db.get_connection()
        conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (track_uuid,))
        conn.commit()
        conn.close()

    def test_04_spotify_tracks_indexed_with_real_metadata(self):
        music_dir = tempfile.mkdtemp(prefix="puuk_spotify_idx_")
        self.addCleanup(shutil.rmtree, music_dir, ignore_errors=True)

        real_file = os.path.join(music_dir, "Artist One - Song One.mp3")
        with open(real_file, "wb") as handle:
            handle.write(b"x")

        track_info = {
            "is_spotify": True,
            "tracks": [
                {
                    "filepath": real_file,
                    "title": "Song One",
                    "artist": "Artist One",
                    "album": "Album One",
                    "album_artist": "Artist One",
                    "duration": 180,
                },
                {
                    "filepath": os.path.join(music_dir, "not-on-disk.mp3"),
                    "title": "Song Two",
                    "artist": "Artist Two",
                    "album": "",
                    "duration": 200,
                },
            ],
        }

        user = dict(db.get_user_by_telegram_id(self.tg_id))
        indexed = index_downloaded_tracks(track_info, user, music_dir=music_dir)
        self.assertEqual(indexed, 2)

        rel_path = os.path.relpath(real_file, music_dir)
        track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
        track = db.get_track(track_id)
        self.assertIsNotNone(track)
        self.assertEqual(track["title"], "Song One")
        self.assertEqual(track["artist"], "Artist One")
        self.assertNotEqual(track["artist"], "Spotify")
        self.assertIsNotNone(track["album_id"])
        self.assertTrue(db.is_favorite(self.user_id, track_id))

        conn = db.get_connection()
        second_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "Song Two - Artist Two.mp3"))
        for tid in (track_id, second_id):
            conn.cursor().execute("DELETE FROM user_favorites WHERE track_id = ?", (tid,))
            conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (tid,))
        conn.commit()
        conn.close()

    def test_05_tracks_outside_music_dir_are_not_indexed(self):
        music_dir = tempfile.mkdtemp(prefix="puuk_music_dir_")
        outside_dir = tempfile.mkdtemp(prefix="puuk_outside_")
        self.addCleanup(shutil.rmtree, music_dir, ignore_errors=True)
        self.addCleanup(shutil.rmtree, outside_dir, ignore_errors=True)

        outside_file = os.path.join(outside_dir, "evil.mp3")
        with open(outside_file, "wb") as handle:
            handle.write(b"x")

        track_info = {
            "is_spotify": True,
            "tracks": [{
                "filepath": outside_file,
                "title": "Evil",
                "artist": "Hacker",
                "album": "",
                "duration": 10,
            }],
        }

        user = dict(db.get_user_by_telegram_id(self.tg_id))
        indexed = index_downloaded_tracks(track_info, user, music_dir=music_dir)
        self.assertEqual(indexed, 0)

        phantom_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "Evil - Hacker.mp3"))
        self.assertIsNone(db.get_track(phantom_id))

    def test_06_spotify_playlist_indexed_but_not_favorited(self):
        music_dir = tempfile.mkdtemp(prefix="puuk_playlist_")
        self.addCleanup(shutil.rmtree, music_dir, ignore_errors=True)

        files = []
        for name in ("Playlist Artist - Track A.mp3", "Playlist Artist - Track B.mp3"):
            path = os.path.join(music_dir, name)
            with open(path, "wb") as handle:
                handle.write(b"x")
            files.append(path)

        track_info = {
            "is_spotify": True,
            "total_tracks": 2,
            "tracks": [
                {"filepath": files[0], "title": "Track A", "artist": "Playlist Artist",
                 "album": "Playlist Album", "album_artist": "Playlist Artist", "duration": 120},
                {"filepath": files[1], "title": "Track B", "artist": "Playlist Artist",
                 "album": "Playlist Album", "album_artist": "Playlist Artist", "duration": 130},
            ],
        }

        user = dict(db.get_user_by_telegram_id(self.tg_id))
        indexed = index_downloaded_tracks(track_info, user, music_dir=music_dir)
        self.assertEqual(indexed, 2)

        conn = db.get_connection()
        track_ids = []
        for path in files:
            rel_path = os.path.relpath(path, music_dir)
            track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
            track_ids.append(track_id)
            track = db.get_track(track_id)
            self.assertIsNotNone(track)
            self.assertEqual(track["artist"], "Playlist Artist")
            self.assertFalse(db.is_favorite(self.user_id, track_id))

        for track_id in track_ids:
            conn.cursor().execute("DELETE FROM user_favorites WHERE track_id = ?", (track_id,))
            conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
        conn.close()

    def test_07_downloaded_playlist_enqueues_only_real_files(self):
        music_dir = tempfile.mkdtemp(prefix="puuk_enqueue_")
        self.addCleanup(shutil.rmtree, music_dir, ignore_errors=True)

        real_file = os.path.join(music_dir, "A - One.mp3")
        with open(real_file, "wb") as handle:
            handle.write(b"x")

        track_info = {
            "is_spotify": True,
            "total_tracks": 2,
            "tracks": [
                {"filepath": real_file, "title": "One", "artist": "A", "album": "", "duration": 10},
                {"filepath": os.path.join(music_dir, "missing.mp3"),
                 "title": "Two", "artist": "B", "album": "", "duration": 20},
            ],
        }

        captured = {}

        def fake_enqueue(client, tracks, music_root, **kwargs):
            captured["tracks"] = list(tracks)
            captured["root"] = music_root
            return {"enqueued": len(captured["tracks"])}

        user = dict(db.get_user_by_telegram_id(self.tg_id))
        with patch.dict(os.environ, {"EMBEDDING_QUEUE_ENABLED": "true"}), \
             patch("services.embedding_queue_service.get_qdrant_client", return_value=object()), \
             patch("services.embedding_queue_service.enqueue_missing_tracks", side_effect=fake_enqueue):
            indexed = index_downloaded_tracks(track_info, user, music_dir=music_dir)

        self.assertEqual(indexed, 2)
        self.assertEqual(len(captured["tracks"]), 1)
        self.assertEqual(captured["tracks"][0]["file_path"], "A - One.mp3")
        self.assertEqual(captured["root"], music_dir)

        conn = db.get_connection()
        for rel in ("A - One.mp3", "Two - B.mp3"):
            track_id = str(uuid.uuid5(uuid.NAMESPACE_URL, rel))
            conn.cursor().execute("DELETE FROM user_favorites WHERE track_id = ?", (track_id,))
            conn.cursor().execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
        conn.close()

    def test_08_import_handlers_receive_the_linked_account(self):
        async def verify(imports):
            message = SimpleNamespace(
                from_user=SimpleNamespace(id=self.tg_id),
                chat=SimpleNamespace(id=self.tg_id),
                message_id=1,
                reply_to_message=None,
                answer=AsyncMock(return_value=SimpleNamespace(message_id=2)),
            )
            self.assertEqual(imports.mode(self.tg_id, 'chat'), 'chat')
            self.assertIsNone(imports._linked_owner(self.tg_id, self.user_id + 1))
            await imports.downloads(message)
            message.answer.assert_awaited_once_with(
                'Активных загрузок нет.', parse_mode='HTML', reply_markup=None, disable_notification=True,
            )
            message.answer.reset_mock()
            command = SimpleNamespace(command='puuk', args='https://open.spotify.com/track/' + 'a' * 22)
            await imports.override(message, command)
            message.answer.assert_awaited_once_with(
                '<b>Новая загрузка</b>\nВ очереди', parse_mode='HTML', disable_notification=True,
            )
            job, = imports.jobs.outstanding(self.tg_id, self.user_id)
            self.assertEqual(job['owner_id'], self.user_id)
            self.assertEqual(job['mode'], 'server')
            self.assertEqual(job['status_message'], 2)
            self.assertEqual(imports.mode(self.tg_id), 'chat')

        with tempfile.TemporaryDirectory() as state:
            imports = TelegramImports(None, get_puuk_user, os.path.join(state, 'queue.db'), state)
            asyncio.run(verify(imports))

    def test_09_import_cards_show_progress_and_partial_results(self):
        with tempfile.TemporaryDirectory() as state:
            root = Path(state)
            imports = TelegramImports(None, get_puuk_user, root / 'queue.db', state)
            job_id, _ = imports.jobs.submit(self.tg_id, self.user_id, self.tg_id, 1, {'url': 'track'}, 'server')
            imports.jobs.set_message(job_id, 2)
            imports.jobs.claim_snapshot()
            track = {'title': 'Teardrop & <Live>', 'artist': 'Massive Attack'}
            imports.jobs.snapshot(job_id, track['title'], 'track', [track])
            imports.jobs.claim_position()
            directory = imports.root / str(job_id) / 'position-1'
            directory.mkdir(parents=True)
            hook = ytdlp_progress(progress_reporter(directory / 'progress.txt'))
            hook({'status': 'downloading', 'downloaded_bytes': 42, 'total_bytes': 100})
            text, _ = imports._card(imports.jobs.job(job_id))
            self.assertEqual(
                text, '<b>Massive Attack — Teardrop &amp; &lt;Live&gt;</b>\n'
                      '<code>████░░░░░░ 42%</code>\nСкачиваю аудио',
            )
            self.assertIn('42%', imports._downloads_card(self.tg_id, self.user_id, 0)[0])
            hook({'status': 'finished'})
            self.assertIn('Проверяю аудио', imports._card(imports.jobs.job(job_id))[0])
            imports.jobs.downloaded(job_id, 1, {'path': '/tmp/audio.mp3', 'sha256': 'track'})
            self.assertIn('Добавляю в Puuk', imports._card(imports.jobs.job(job_id))[0])
            imports.jobs.delivered(job_id, 1, 'track-id', 'track-id')
            imports.jobs.settle(job_id)
            with patch('telegram_imports.catalog.is_saved', return_value=False):
                text, keys = imports._card(imports.jobs.job(job_id))
            self.assertTrue(text.endswith('\nДобавлено в Puuk'))
            self.assertEqual([button.text for button in keys.inline_keyboard[0]], ['Открыть трек', 'В избранное'])

            album, _ = imports.jobs.submit(self.tg_id, self.user_id, self.tg_id, 3, {'url': 'album'}, 'server')
            imports.jobs.set_message(album, 4)
            imports.jobs.claim_snapshot()
            songs = [{'title': str(n), 'album_artist': 'Massive Attack'} for n in range(1, 12)]
            songs[7]['title'] = 'Black Milk'
            imports.jobs.snapshot(album, 'Mezzanine', 'album', songs)
            for n in range(1, 12):
                imports.jobs.claim_position()
                if n == 8:
                    self.assertIn(
                        '64%</code>\nЗагружено 7 из 11 треков\nСейчас · 08. Black Milk',
                        imports._card(imports.jobs.job(album))[0],
                    )
                    imports.jobs.skip(album, n, 'Запись не найдена')
                else:
                    imports.jobs.downloaded(album, n, {'sha256': str(n)})
                    imports.jobs.delivered(album, n)
            imports.jobs.settle(album)
            text, keys = imports._card(imports.jobs.job(album))
            self.assertIn('Загружено 10 из 11 треков в Puuk', text)
            self.assertIn('08. Black Milk', text)
            self.assertEqual(
                [[button.text for button in row] for row in keys.inline_keyboard],
                [['Разобрать пропуски'], ['Повторить', 'Добавить файл или ссылку']],
            )

    def test_10_successful_chat_delivery_clears_the_progress_card(self):
        async def verify(root):
            bot = AsyncMock()
            imports = TelegramImports(bot, get_puuk_user, root / 'queue.db', root)
            job_id, _ = imports.jobs.submit(self.tg_id, self.user_id, self.tg_id, 1, {'url': 'track'}, 'chat')
            imports.jobs.set_message(job_id, 2)
            imports.jobs.claim_snapshot()
            imports.jobs.snapshot(job_id, 'Teardrop', 'track', [{'title': 'Teardrop'}])
            imports.jobs.claim_position()
            path = root / 'audio.mp3'
            path.touch()
            imports.jobs.downloaded(job_id, 1, {'path': str(path), 'sha256': 'track'})

            async def deleted(chat_id, message_id):
                self.assertEqual((chat_id, message_id), (self.tg_id, 2))
                bot.send_audio.assert_awaited_once()

            bot.delete_message.side_effect = deleted
            publisher = asyncio.create_task(imports._publisher())
            try:
                async with asyncio.timeout(5):
                    while imports.jobs.job(job_id)['status_message'] is not None:
                        await asyncio.sleep(.05)
            finally:
                publisher.cancel()
                await asyncio.gather(publisher, return_exceptions=True)
            bot.delete_message.assert_awaited_once()

        with tempfile.TemporaryDirectory() as state:
            asyncio.run(verify(Path(state)))

    def test_11_existing_vk_card_reopens_and_applies_selected_edition(self):
        async def verify(root):
            imports = TelegramImports(None, get_puuk_user, root / 'queue.db', root)
            url = 'https://vk.com/audio1_123'
            request = {'url': url}
            job_id, _ = imports.jobs.submit(self.tg_id, self.user_id, self.tg_id, 1, request, 'server')
            imports.jobs.set_message(job_id, 2)
            imports.jobs.claim_snapshot()
            source = {'type': 'vk', 'key': 'vk:track:1_123', 'title': 'Teardrop', 'artist': 'Massive Attack'}
            imports.jobs.snapshot(job_id, source['title'], 'track', [source])
            imports.jobs.claim_position()
            imports.jobs.downloaded(job_id, 1, {'sha256': 'vk-audio'})
            imports.jobs.delivered(job_id, 1, 'track-id', 'track-id')
            imports.jobs.settle(job_id)
            message = SimpleNamespace(from_user=SimpleNamespace(id=self.tg_id), chat=SimpleNamespace(id=self.tg_id),
                                      message_id=3, reply_to_message=None, text=url, answer=AsyncMock(),
                                      edit_text=AsyncMock())
            callback = SimpleNamespace(from_user=message.from_user, message=message, answer=AsyncMock(),
                                       data=f'imp:vkmeta:{job_id}')
            track = {'title': source['title'], 'artist': source['artist'], 'duration': 331}
            editions = [{'source': 'iTunes', 'album': 'Mezzanine', 'year': year} for year in ('1998', '2018')]
            with (patch('telegram_imports.catalog.vk_metadata_target', return_value=track),
                  patch('telegram_imports.get_track', return_value=track),
                  patch('telegram_imports.catalog.update_vk_metadata', return_value=True) as apply,
                  patch.object(imports, '_child', new=AsyncMock(side_effect=[editions, '/tmp/cover.jpg'])) as child):
                await imports.link(message)
                buttons = message.answer.await_args.kwargs['reply_markup'].inline_keyboard
                self.assertEqual(buttons[-1][0].callback_data, callback.data)
                self.assertEqual(imports.jobs.outstanding(self.tg_id, self.user_id), [])

                await imports.callback(callback)
                apply.assert_not_called()
                options = message.edit_text.await_args.kwargs['reply_markup'].inline_keyboard
                self.assertEqual(options[1][0].text, '2018 · Mezzanine')
                callback.data = options[1][0].callback_data
                await imports.callback(callback)
                self.assertEqual(child.await_args.args[2], editions[1])
                self.assertEqual(apply.call_args.args[3:5], (track, editions[1]))
                self.assertIn('Метаданные обновлены', message.edit_text.await_args.args[0])

        with tempfile.TemporaryDirectory() as state:
            asyncio.run(verify(Path(state)))

    def test_12_vk_playlist_metadata_updates_unique_tracks_and_offers_edition_review(self):
        async def verify(root):
            bot = AsyncMock()
            imports = TelegramImports(bot, get_puuk_user, root / 'queue.db', root)
            job_id, _ = imports.jobs.submit(self.tg_id, self.user_id, self.tg_id, 1,
                                            {'url': 'https://vk.com/music/playlist/1_2'}, 'server')
            imports.jobs.set_message(job_id, 2)
            imports.jobs.claim_snapshot()
            sources = [{'type': 'vk', 'key': f'vk:track:1_{number}', 'title': f'Track {number}', 'artist': 'Artist'}
                       for number in (1, 2, 1)]
            imports.jobs.snapshot(job_id, 'Big Wave', 'playlist', sources)
            for position, ident in enumerate(('a', 'b', 'a'), 1):
                imports.jobs.claim_position()
                imports.jobs.downloaded(job_id, position, {'sha256': ident})
                imports.jobs.delivered(job_id, position, ident)
            imports.jobs.settle(job_id)
            job = imports.jobs.job(job_id)
            message = SimpleNamespace(message_id=3, chat=SimpleNamespace(id=self.tg_id), edit_text=AsyncMock())
            callback = SimpleNamespace(from_user=SimpleNamespace(id=self.tg_id), message=message, answer=AsyncMock(),
                                       data='imp:vklist:0:0')
            await imports.callback(callback)
            playlist_button, *_ = message.edit_text.await_args.kwargs['reply_markup'].inline_keyboard
            callback.data = playlist_button[0].callback_data
            await imports.callback(callback)
            buttons = message.edit_text.await_args.kwargs['reply_markup'].inline_keyboard
            refresh = next(button for row in buttons for button in row if button.text == 'Обновить метаданные')
            callback.data = refresh.callback_data
            await imports.callback(callback)
            self.assertIn('Проверяю метаданные · 0 из 2', message.edit_text.await_args.args[0])

            from services.telegram_import_service import CATALOG_REVISION_FIELDS
            track = {**dict.fromkeys(CATALOG_REVISION_FIELDS), 'duration': 210, 'album_track_position': None}
            initial = {'album': 'Big Wave', 'source': 'iTunes', 'cover_url': 'https://img.example/a'}
            special = {**initial, 'album': 'Remaster', 'year': '2020'}

            async def child(action, directory, request, _timeout):
                if action == 'catalog-cover':
                    return str(root / 'cover.jpg')
                return [initial] if request['title'] == 'Track 1' else [initial, special]

            imports.metadata_batch.run_child = child
            with (patch('vk_metadata_batch.SEARCH_INTERVAL', 0),
                  patch('vk_metadata_batch.catalog.vk_metadata_target', return_value=track),
                  patch('vk_metadata_batch.catalog.update_vk_metadata', return_value=True) as save):
                worker = asyncio.create_task(imports.metadata_batch.run())
                try:
                    async with asyncio.timeout(5):
                        while [row['state'] for row in imports.jobs.metadata_entries(job_id)] != ['updated', 'review']:
                            await asyncio.sleep(.02)
                    text, buttons = imports._card(job)
                    self.assertIn('Метаданные обновлены · 1 из 2', text)
                    callback.data = next(button.callback_data for row in buttons.inline_keyboard for button in row
                                         if button.text == 'Выбрать издания · 1')
                    await imports.callback(callback)
                    self.assertIn('02. Track 2', message.edit_text.await_args.args[0])
                    callback.data = message.edit_text.await_args.kwargs['reply_markup'].inline_keyboard[1][0].callback_data
                    await imports.callback(callback)
                    async with asyncio.timeout(5):
                        while [row['state'] for row in imports.jobs.metadata_entries(job_id)] != ['updated', 'updated']:
                            await asyncio.sleep(.02)
                    self.assertEqual([call.args[1] for call in save.call_args_list], ['a', 'b'])
                    self.assertEqual(save.call_args.args[4], special)
                    self.assertIn('Метаданные обновлены · 2 из 2', imports._card(job)[0])
                finally:
                    worker.cancel()
                    await asyncio.gather(worker, return_exceptions=True)

        with tempfile.TemporaryDirectory() as state:
            asyncio.run(verify(Path(state)))

    @classmethod
    def tearDownClass(cls):
        db.delete_user(cls.user_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
