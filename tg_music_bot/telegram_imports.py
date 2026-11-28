"""Telegram controls and execution for the durable import queue."""
import asyncio
from collections import Counter, defaultdict
from html import escape
import json
import logging
import secrets
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import time
from weakref import WeakValueDictionary
from zipfile import ZIP_STORED, ZipFile

from aiogram import F, Router
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest, TelegramRetryAfter
from aiogram.filters import Command
from aiogram.types import ForceReply, FSInputFile, InlineKeyboardButton, InlineKeyboardMarkup

from db import get_track
from downloader import _run_download_process
from import_jobs import ImportJobs
from import_progress import progress_bar, read_progress
from import_sources import MAX_FILE_BYTES, canonical_link
from recovery_review import RECOVERY_ACTIONS, RecoveryReview
from repositories import imported_playlists, recording_reviews
from services.embedding_queue_service import publish_import_analysis
from services import telegram_import_service as catalog
from vk_metadata_batch import VkMetadataBatch


logger = logging.getLogger(__name__)
PAGE_SIZE = 8
WORK_SCRIPT = Path(__file__).with_name('import_sources.py')
PUBLIC_WEB = 'https://web.puuk.fun'
QUEUE_CARD = '<b>Новая загрузка</b>\nВ очереди'
STATUS = {'new': 'В очереди', 'resolving': 'Читаю ссылку', 'active': 'Жду загрузки',
          'paused': 'На паузе', 'cancelled': 'Импорт отменён', 'finished': 'Готово',
          'failed': 'Остановлено', 'review': 'Проверьте изменения'}


def _button(label, data):
    return InlineKeyboardButton(text=label, callback_data=data)


def _keyboard(buttons):
    return InlineKeyboardMarkup(inline_keyboard=buttons) if buttons else None


class SourceError(ValueError):
    def __init__(self, message, temporary=False, alternative=None):
        super().__init__(message)
        self.temporary = temporary
        self.alternative = alternative


class TelegramImports:
    def __init__(self, bot, owner_for_telegram, queue_path, music_dir, *, workers=3):
        self.bot = bot
        self.owner = owner_for_telegram
        self.jobs = ImportJobs(queue_path)
        self.root = self.jobs.path.parent / (self.jobs.path.stem + '-artifacts')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.music_dir = music_dir
        self.workers = workers
        self.pending = defaultdict(set)
        self.message_locks = WeakValueDictionary()
        self.dirty = set()
        self.delivery_after = {}
        self.recovery = RecoveryReview(self.bot, self.jobs, self.root, self._child, self._mark_dirty, self._linked_owner)
        self.catalog_slots = asyncio.Semaphore(2)
        self.catalog_choices = {}
        self.metadata_batch = VkMetadataBatch(self.jobs, self.root, self._linked_owner, self._child,
                                              self.catalog_slots, self._notify_metadata_batch)
        self.router = Router()
        self.router.message.register(self.downloads, Command('downloads'))
        self.router.message.register(self.override, Command('tg', 'puuk'))
        self.router.message.register(self.start_album, Command('album'))
        self.router.message.register(self.finish_album, F.text.func(lambda text: text and text.strip().casefold() == 'готово'))
        self.router.message.register(self.attachment, F.audio | F.document)
        self.router.message.register(self.link, F.text.regexp(r'^\s*https?://'))
        self.router.callback_query.register(self.callback, F.data.startswith('imp:'))

    def _mark_dirty(self, job_id):
        self.dirty.add(job_id)

    def _linked_owner(self, telegram_id, expected_owner=None) -> dict | None:
        user = self.owner(telegram_id)
        if user is None or (expected_owner is not None and user['id'] != expected_owner):
            return None
        return user

    def _lock(self, job_id):
        lock = self.message_locks.get(job_id)
        if lock is None:
            lock = self.message_locks[job_id] = asyncio.Lock()
        return lock

    def mode(self, telegram_id, mode=None):
        user = self._linked_owner(telegram_id)
        if not user:
            raise ValueError('Привяжите Telegram к аккаунту Puuk')
        return self.jobs.mode(user['id'], mode)

    async def attachment(self, message):
        file = message.audio or message.document
        filename = Path(file.file_name or ('audio.mp3' if message.audio else 'attachment')).name[:240]
        if not message.audio and Path(filename).suffix.lower() not in {'.mp3', '.flac', '.m4a', '.zip'}:
            await message.answer('Пришлите MP3, FLAC, M4A или ZIP с альбомом.')
            return
        if file.file_size and file.file_size > MAX_FILE_BYTES:
            await message.answer('Размер файла превышает 2000 МБ.')
            return
        if file.file_size and file.file_size > 20 * 1024 * 1024 and not self.bot.session.api.is_local:
            await message.answer('Файл превышает лимит облачного Bot API в 20 МБ. Для него нужен локальный Bot API.')
            return
        request = {'file_id': file.file_id, 'filename': filename}
        if not message.reply_to_message and Path(filename).suffix.lower() != '.zip':
            telegram_id = message.from_user.id
            user = self._linked_owner(telegram_id)
            if user:
                try:
                    added = self.jobs.add_batch_file(message.chat.id, telegram_id, user['id'],
                                                     message.message_id, request)
                except ValueError as exc:
                    await message.answer(str(exc))
                    return
                if added is not None:
                    await message.answer(f'Файлов в альбоме · {added}', disable_notification=True)
                    return
        await self._submit(message, request, 'server')

    async def start_album(self, message):
        telegram_id = message.from_user.id
        user = self._linked_owner(telegram_id)
        if not user:
            await message.answer('Привяжите Telegram к аккаунту Puuk. Подробности в /start.')
            return
        self.jobs.start_batch(message.chat.id, telegram_id, user['id'])
        await message.answer('Пришлите дорожки альбома отдельными файлами. Когда закончите, напишите «Готово».')

    async def finish_album(self, message):
        telegram_id = message.from_user.id
        user = self._linked_owner(telegram_id)
        if not user:
            await message.answer('Привяжите Telegram к аккаунту Puuk. Подробности в /start.')
            return
        files = self.jobs.batch_files(message.chat.id, telegram_id, user['id'])
        if not files:
            await message.answer('Чтобы собрать альбом из нескольких файлов, начните с /album.')
            return
        if await self._submit(message, {'attachments': list(files.values())}, 'server'):
            self.jobs.finish_batch(message.chat.id, telegram_id, user['id'])

    async def link(self, message):
        await self._submit_link(message, message.text)

    async def override(self, message, command):
        mode = 'chat' if command.command == 'tg' else 'server'
        await self._submit_link(message, command.args or '', mode)

    async def search_selection(self, callback, url):
        telegram_id = callback.from_user.id
        user = self._linked_owner(telegram_id)
        if not user:
            await callback.answer('Нет доступа.', show_alert=True)
            return
        message = callback.message
        try:
            request = {'url': canonical_link(url)}
            job_id, _ = self.jobs.submit(telegram_id, user['id'], message.chat.id,
                                         message.message_id, request, self.jobs.mode(user['id']))
        except ValueError as exc:
            await callback.answer(str(exc), show_alert=True)
            return
        async with self._lock(job_id):
            if self.jobs.job(job_id)['status_message'] is None:
                await message.edit_text(QUEUE_CARD, parse_mode='HTML', reply_markup=None)
                self.jobs.set_message(job_id, message.message_id)
        await callback.answer()

    async def _submit_link(self, message, url, mode=None):
        try:
            url = canonical_link(url)
        except ValueError as exc:
            await message.answer(str(exc) if url else 'Отправьте команду и ссылку в одном сообщении.')
            return
        await self._submit(message, {'url': url}, mode)

    async def _submit(self, message, request, mode):
        telegram_id = message.from_user.id
        user = self._linked_owner(telegram_id)
        if not user:
            await message.answer('Привяжите Telegram к аккаунту Puuk. Подробности в /start.')
            return
        mode = mode or self.jobs.mode(user['id'])
        try:
            if message.reply_to_message:
                repaired = self.jobs.repair(message.chat.id, message.reply_to_message.message_id,
                                            message.message_id, telegram_id, user['id'], request)
                if repaired:
                    self.dirty.add(repaired)
                    return True
            if mode == 'server' and 'url' in request:
                completed = self.jobs.completed_vk_track(telegram_id, user['id'], message.chat.id, request)
                source = self._vk_source(completed) if completed else None
                if source and catalog.vk_metadata_target(user, completed['result_id'], source['key']):
                    text, keyboard = self._card(completed)
                    await message.answer(text, parse_mode='HTML', reply_markup=keyboard, disable_notification=True)
                    return True
            job_id, outcome = self.jobs.submit(telegram_id, user['id'], message.chat.id,
                                               message.message_id, request, mode)
        except ValueError as exc:
            await message.answer(str(exc))
            return
        async with self._lock(job_id):
            job = self.jobs.job(job_id)
            if job['status_message'] is None:
                reply = await message.answer(QUEUE_CARD, parse_mode='HTML', disable_notification=True)
                self.jobs.set_message(job_id, reply.message_id)
            elif outcome == 'resumed':
                try:
                    await self._edit(job)
                except TelegramBadRequest as exc:
                    if 'message to edit not found' not in str(exc).lower():
                        raise
                    text, keyboard = self._card(job)
                    reply = await message.answer(text, parse_mode='HTML', reply_markup=keyboard,
                                                 disable_notification=True)
                    self.jobs.set_message(job_id, reply.message_id)
        return True

    def _vk_source(self, job, rows=None):
        if job['state'] != 'finished' or job['kind'] != 'track' or job['mode'] != 'server' or not job['result_id']:
            return None
        rows = self.jobs.positions(job['id']) if rows is None else rows
        if len(rows) == 1 and rows[0]['state'] == 'done':
            source = json.loads(rows[0]['source'])
            if source.get('type') == 'vk' and source.get('key', '').startswith('vk:track:'):
                return source
        return None

    async def _vk_metadata(self, callback, job, user, action, argument):
        job_id, track_id = job['id'], job['result_id']
        source = self._vk_source(job)
        if not source or not (track := catalog.vk_metadata_target(user, track_id, source['key'])):
            await callback.answer('У вас нет доступа к изменению этого трека.', show_alert=True)
            return

        lock = self._lock(job_id)
        if lock.locked() or (action != 'vkback' and self.catalog_slots.locked()):
            await callback.answer('Поиск уже идёт. Попробуйте чуть позже.')
            return
        async with lock:
            message_key = (callback.message.chat.id, callback.message.message_id, job_id)
            if action == 'vkback':
                self.catalog_choices.pop(message_key, None)
                await self._edit_callback(callback, *self._card(job))
                return
            now = time.monotonic()
            if action == 'vkpick':
                expiry, choices, before = self.catalog_choices.get(message_key, (0, {}, None))
                edition = choices.get(argument)
                if now >= expiry or not edition:
                    await self._edit_callback(callback, *self._card(job, note='Выбор устарел. Запустите поиск снова.'))
                    return
            else:
                self.catalog_choices.pop(message_key, None)
                edition, before = None, track

            async with self.catalog_slots:
                await callback.answer('Ищу метаданные' if edition is None else 'Обновляю метаданные')
                with tempfile.TemporaryDirectory(prefix='vk-metadata-', dir=self.root) as directory:
                    directory = Path(directory)
                    try:
                        if edition is None:
                            request = {'title': source['title'], 'artist': source.get('artist') or track['artist'],
                                       'duration': track['duration']}
                            editions = await self._child('vk-metadata', directory, request, 24)
                            if not editions:
                                await self._edit_callback_message(
                                    callback.message, *self._card(job, note='Подходящих изданий не найдено.'))
                                return
                            if len(editions) > 1 or editions[0].get('confirm'):
                                self.catalog_choices = {key: entry for key, entry in self.catalog_choices.items()
                                                        if entry[0] > now}
                                if len(self.catalog_choices) >= 100:
                                    self.catalog_choices.pop(next(iter(self.catalog_choices)))
                                choices = {secrets.randbits(63): item for item in editions}
                                self.catalog_choices[message_key] = (time.monotonic() + 300, choices, before)
                                buttons = []
                                for token, item in choices.items():
                                    label = ' · '.join(filter(None, (
                                        item.get('year'), item.get('album') or item['source'],
                                        'Ремастер' if item.get('confirm') else '',
                                    )))
                                    buttons.append([_button(label[:60], f'imp:vkpick:{job_id}:{token}')])
                                buttons.append([_button('Назад', f'imp:vkback:{job_id}')])
                                text, _ = self._card(job, note='Какое издание выбрать?')
                                await self._edit_callback_message(callback.message, text, _keyboard(buttons))
                                return
                            edition = editions[0]

                        cover = await self._child('catalog-cover', directory, edition, 16)
                        if not cover:
                            note = 'Не удалось загрузить обложку. Попробуйте снова.'
                        elif await asyncio.to_thread(catalog.update_vk_metadata, user, track_id, source['key'],
                                                     before, edition, cover):
                            self.catalog_choices.pop(message_key, None)
                            note = 'Метаданные обновлены'
                        else:
                            note = 'Данные трека изменились. Запустите поиск снова.'
                    except (OSError, RuntimeError, ValueError, sqlite3.Error) as exc:
                        self._log_error(job_id, exc)
                        note = 'Не удалось обновить метаданные. Попробуйте снова.'
            await self._edit_callback_message(callback.message, *self._card(job, note=note))

    async def _notify_metadata_batch(self, job_id):
        async with self._lock(job_id):
            batch = self.jobs.metadata_batch(job_id)
            text, keyboard = self._card(self.jobs.job(job_id))
            try:
                await self.bot.edit_message_text(text, chat_id=batch['chat_id'], message_id=batch['message_id'],
                                                 parse_mode='HTML', reply_markup=keyboard)
            except TelegramBadRequest as exc:
                if 'message is not modified' not in str(exc).lower():
                    raise

    async def _vk_batch(self, callback, job, action, argument):
        job_id = job['id']
        async with self._lock(job_id):
            rows = self.jobs.positions(job_id)
            positions = self.metadata_batch.positions(job, rows)
            if not positions:
                await callback.answer('Нет загруженных VK-треков для обновления.', show_alert=True)
                return
            if action == 'vkbstart':
                try:
                    started = self.jobs.start_metadata_batch(
                        job_id, callback.message.chat.id, callback.message.message_id, positions,
                    )
                except ValueError as exc:
                    await callback.answer(str(exc), show_alert=True)
                    return
                if not started:
                    await callback.answer('Обновление метаданных уже идёт.')
                    return
            elif action == 'vkbpick':
                if not self.jobs.select_metadata_edition(job_id, argument):
                    await self._edit_callback(callback, *self._card(job, note='Выбор устарел. Откройте список изданий.'))
                    return
            else:
                reviews = [row for row in self.jobs.metadata_entries(job_id) if row['state'] == 'review']
                if reviews:
                    review = next((row for row in reviews if row['position'] > argument), reviews[0])
                    position = review['position']
                    source = json.loads(next(row for row in rows if row['position'] == position)['source'])
                    text = (f"<b>{escape(job['title'][:180])}</b>\n\n"
                            f"Выберите издание · {reviews.index(review) + 1} из {len(reviews)}\n"
                            f"{position:02d}. {escape(source['title'][:150])}")
                    buttons = []
                    for item in json.loads(review['editions']):
                        edition = item['edition']
                        name = ' · '.join(filter(None, (edition.get('year'), edition.get('album') or edition['source'],
                                                        'Ремастер' if edition.get('confirm') else '')))
                        buttons.append([_button(name[:60], f"imp:vkbpick:{job_id}:{item['token']}")])
                    nav = [_button('К загрузке', f'imp:show:{job_id}:0')]
                    if len(reviews) > 1:
                        nav.insert(0, _button('Другой трек', f'imp:vkbnext:{job_id}:{position}'))
                    await self._edit_callback(callback, text, _keyboard(buttons + [nav]))
                    return
            await self._edit_callback(callback, *self._card(job))

    def _vk_batch_status(self, job_id):
        entries = self.jobs.metadata_entries(job_id)
        counts = Counter(row['state'] for row in entries)
        if not entries:
            return [], [[_button('Обновить метаданные', f'imp:vkbstart:{job_id}')]]
        total, pending = len(entries), counts['pending']
        if pending:
            checked = total - pending
            return (['', f'<code>{progress_bar(round(checked * 100 / total))}</code>',
                     f'Проверяю метаданные · {checked} из {total}'], [])
        lines = ['', f"Метаданные обновлены · {counts['updated']} из {total}"]
        for state, label in (('review', 'Нужно выбрать издание'), ('no_match', 'Нет совпадения'),
                             ('restricted', 'Нет доступа к изменению'), ('failed', 'Не удалось обновить')):
            if counts[state]:
                lines.append(f'{label} · {counts[state]}')
        buttons = []
        if counts['review']:
            buttons.append([_button(f"Выбрать издания · {counts['review']}", f'imp:vkbnext:{job_id}:0')])
        buttons.append([_button('Обновить метаданные', f'imp:vkbstart:{job_id}')])
        return lines, buttons

    def _vk_collections_card(self, telegram_id, owner_id, page):
        jobs = self.jobs.completed_vk_collections(telegram_id, owner_id, page * PAGE_SIZE, PAGE_SIZE + 1)
        buttons = [[_button((job['title'] or 'Плейлист')[:60], f"imp:listshow:{job['id']}:0")]
                   for job in jobs[:PAGE_SIZE]]
        nav = []
        if page:
            nav.append(_button('Назад', f'imp:vklist:0:{page - 1}'))
        if len(jobs) > PAGE_SIZE:
            nav.append(_button('Дальше', f'imp:vklist:0:{page + 1}'))
        if nav:
            buttons.append(nav)
        buttons.append([_button('Мои загрузки', 'imp:list:0:0')])
        return '<b>Готовые альбомы и плейлисты VK</b>', _keyboard(buttons)

    def _position_progress(self, job_id, position):
        return read_progress(self.root / str(job_id) / f'position-{position}' / 'progress.txt')

    @staticmethod
    def _title(job, rows):
        title = job['title'] or 'Новая загрузка'
        if rows and job['kind'] in {'track', 'album'}:
            source = json.loads(rows[0]['source'])
            metadata = source.get('metadata') or {}
            song = source.get('song') or {}
            if job['kind'] == 'album':
                artist = (metadata.get('album_artist') or source.get('album_artist')
                          or song.get('album_artist') or song.get('artist'))
            else:
                artist = metadata.get('artist') or source.get('artist') or song.get('artist')
                title = metadata.get('title') or source.get('music_title') or title
            if artist and not title.casefold().startswith(artist.casefold() + ' '):
                title = f'{artist} — {title}'
        return ' '.join(title.split())

    def _status(self, job, rows, count, missing):
        mode = 'в Puuk' if job['mode'] == 'server' else 'в Telegram'
        state = job['state']
        if state == 'finished' and any(row['state'] in {'pending', 'downloading', 'ready', 'sending'} for row in rows):
            state = 'active'
        if state == 'finished':
            if job['kind'] == 'track':
                if missing:
                    return 'Не удалось загрузить трек', None
                return ('Добавлено в Puuk' if job['mode'] == 'server' else 'Отправлено в Telegram'), None
            return f'Загружено {count} из {len(rows)} треков {mode}', None
        if state not in {'active', 'paused'}:
            return STATUS[state], None

        if job['kind'] == 'track':
            if any(row['state'] in {'ready', 'sending'} for row in rows):
                return ('Добавляю в Puuk' if job['mode'] == 'server' else 'Отправляю аудио'), None
            downloading = next((row for row in rows if row['state'] == 'downloading'), None)
            if downloading:
                return self._position_progress(job['id'], downloading['position'])
            return STATUS[state], None

        progress = round(count * 100 / len(rows)) if rows else None
        summary = f'Загружено {count} из {len(rows)} треков'
        if state == 'paused':
            return f'На паузе · {count} из {len(rows)} треков', progress
        current = next((row for row in rows if row['state'] in {'downloading', 'ready', 'sending'}), None)
        if current:
            label = json.loads(current['source'])['title'][:110]
            summary += f"\nСейчас · {current['position']:02d}. {label}"
        return summary, progress

    def _card(self, job, page=0, *, note=None):
        job_id = job['id']
        if job['state'] == 'review':
            review = json.loads(job['review'])
            if review.get('options'):
                text = [f"<b>{escape(job['title'][:200])}</b>", 'Какое издание добавить?']
                buttons = []
                for index, option in enumerate(review['options'], 1):
                    label = option.get('label') or ' · '.join(value for value in (
                        option.get('artist') or option.get('album_artist'), option.get('album'), option.get('year')
                    ) if value)
                    buttons.append([_button(label[:60], f'imp:metadata:{job_id}:{index}')])
                if review['options'][0].get('label'):
                    text[1] = 'Выберите данные для медиатеки'
                return '\n'.join(text), _keyboard(buttons + [[_button('Отмена', f'imp:cancel:{job_id}')]])
            lines = review['lines']
            page = max(0, min(page, (len(lines) - 1) // PAGE_SIZE))
            text = [f"<b>{escape(job['title'][:200])}</b>", 'Изменения в плейлисте']
            added = sum(line.rpartition(' · ')[2].startswith('появится на ') for line in lines)
            removed = sum(line.rpartition(' · ')[2].startswith('уйдёт с ') for line in lines)
            if added or removed:
                text.append(f'Добавятся · {added}   Удалятся · {removed}')
            text.append('')
            text.extend(escape(line[:220]) for line in lines[page * PAGE_SIZE:(page + 1) * PAGE_SIZE])
            nav = []
            if page:
                nav.append(_button('Назад', f'imp:show:{job_id}:{page-1}'))
            if (page + 1) * PAGE_SIZE < len(lines):
                nav.append(_button('Дальше', f'imp:show:{job_id}:{page+1}'))
            buttons = [[_button('Обновить', f'imp:confirm:{job_id}'), _button('Отмена', f'imp:cancel:{job_id}')]]
            return '\n'.join(text), _keyboard(buttons + ([nav] if nav else []))
        rows = self.jobs.positions(job_id)
        count = sum(row['state'] == 'done' for row in rows)
        missing = [row for row in rows if row['state'] == 'skipped']
        status, percent = self._status(job, rows, count, missing)
        title = self._title(job, rows)
        vk_source = self._vk_source(job, rows)
        if vk_source:
            track = get_track(job['result_id'])
            if track:
                title = f"{track['artist']} — {track['title']}" if track['artist'] else track['title']
        lines = [f'<b>{escape(title[:250])}</b>']
        if percent is not None:
            lines.append(f'<code>{progress_bar(percent)}</code>')
        lines.append(escape(status))
        if note:
            lines.extend(('', escape(note)))
        if job['error']:
            lines.append(escape(job['error'][:400]))
        if missing and job['kind'] != 'track':
            lines.extend(('', '<b>Пропущенные треки</b>'))
        buttons = []
        if job['kind'] == 'playlist' and job['state'] in {'paused', 'active'}:
            action, label = ('resume', 'Продолжить') if job['state'] == 'paused' else ('pause', 'Пауза')
            buttons.append([_button(label, f'imp:{action}:{job_id}'),
                            _button('Отменить', f'imp:cancel:{job_id}')])
        if missing and job['state'] in {'active', 'finished'}:
            buttons.append([_button('Разобрать пропуски', f'imp:recover:{job_id}')])
        page = max(0, min(page, (len(missing) - 1) // PAGE_SIZE))
        shown = missing[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]
        for row in shown:
            source = json.loads(row['source'])
            if job['kind'] == 'track':
                lines.append(escape(row['error'][:220]))
            else:
                lines.append(f"{row['position']:02d}. {escape(source['title'][:110])}")
            if row['run_after']:
                lines.append('Повторю автоматически')
            if row['run_after'] == 0 and job['state'] in {'active', 'finished'}:
                position = row['position']
                suffix = f' № {position}' if len(missing) > 1 else ''
                buttons.append([_button(f'Повторить{suffix}', f'imp:retry:{job_id}:{position}'),
                                _button(f'Добавить файл или ссылку{suffix}', f'imp:repair:{job_id}:{position}')])
        manual = sum(row['run_after'] == 0 for row in missing)
        if manual > 1 and job['state'] in {'active', 'finished'}:
            buttons.append([_button(f'Повторить все {manual}', f'imp:retry:{job_id}:0')])
        navigation = []
        if page > 0:
            navigation.append(_button('Назад', f'imp:show:{job_id}:{page - 1}'))
        if (page + 1) * PAGE_SIZE < len(missing):
            navigation.append(_button('Дальше', f'imp:show:{job_id}:{page + 1}'))
        if navigation:
            buttons.append(navigation)
        if count and job['mode'] == 'server' and job['result_id'] and job['kind'] in {'album', 'track'}:
            kind = job['kind']
            buttons.append([InlineKeyboardButton(text='Открыть альбом' if kind == 'album' else 'Открыть трек',
                           url=f"{PUBLIC_WEB}/{kind}/{job['result_id']}")])
            if job['state'] == 'finished':
                saved = catalog.is_saved(job['owner_id'], kind, job['result_id'])
                label = 'В медиатеке' if saved else 'В медиатеку'
                if kind == 'track':
                    label = 'В избранном' if saved else 'В избранное'
                buttons[-1].append(_button(label, f'imp:save:{job_id}'))
        if job['state'] == 'finished' and job['playlist_id'] and count:
            saved = catalog.is_saved(job['owner_id'], 'playlist', job['playlist_id'])
            buttons.append([_button(('♥' if saved else '♡') + ' В медиатеку', f'imp:save:{job_id}')])
        if count and job['kind'] == 'track' and job['state'] == 'finished' and len(rows) == 1:
            source = json.loads(rows[0]['source'])
            if source.get('key', '').startswith('youtube:') and 'url' in json.loads(job['request']):
                buttons.append([_button('Найти альбомную версию', f'imp:albumversion:{job_id}')])
        if vk_source:
            buttons.append([_button('Обновить метаданные', f'imp:vkmeta:{job_id}')])
        if self.metadata_batch.positions(job, rows):
            metadata_lines, metadata_buttons = self._vk_batch_status(job_id)
            lines.extend(metadata_lines)
            buttons.extend(metadata_buttons)
        return '\n'.join(lines), _keyboard(buttons)

    async def _edit(self, job):
        if job['status_message'] is None:
            return
        text, keyboard = self._card(job)
        try:
            await self.bot.edit_message_text(text=text, chat_id=job['chat_id'],
                                             message_id=job['status_message'], parse_mode='HTML', reply_markup=keyboard)
        except TelegramBadRequest as exc:
            if 'message is not modified' not in str(exc).lower():
                raise

    def _downloads_card(self, telegram_id, owner_id, page):
        rows = self.jobs.outstanding(telegram_id, owner_id)
        completed_vk = self.jobs.completed_vk_collections(telegram_id, owner_id, 0, 1)
        vk_button = [[_button('Готовые альбомы и плейлисты VK', 'imp:vklist:0:0')]] if completed_vk else []
        if not rows:
            return 'Активных загрузок нет.', _keyboard(vk_button)
        page = max(0, min(page, (len(rows) - 1) // PAGE_SIZE))
        buttons = []
        lines = ['<b>Мои загрузки</b>']
        for job in rows[page * PAGE_SIZE:(page + 1) * PAGE_SIZE]:
            job_id = job['id']
            positions = self.jobs.positions(job_id)
            completed = sum(row['state'] == 'done' for row in positions)
            missing = any(row['state'] == 'skipped' for row in positions)
            status, percent = self._status(job, positions, completed, missing)
            name = self._title(job, positions)[:110]
            detail = status.split('\n', 1)[0]
            if percent is not None:
                detail += f' · {percent}%'
            lines.extend(('', f'<b>{escape(name)}</b>', escape(detail)))
            controls = [_button(name[:45], f'imp:listshow:{job_id}:0')]
            if job['state'] == 'paused':
                controls.append(_button('Продолжить', f'imp:resume:{job_id}'))
            buttons.append(controls)
        nav = []
        if page:
            nav.append(_button('Назад', f'imp:list:0:{page - 1}'))
        if (page + 1) * PAGE_SIZE < len(rows):
            nav.append(_button('Дальше', f'imp:list:0:{page + 1}'))
        return '\n'.join(lines), _keyboard(buttons + ([nav] if nav else []) + vk_button)

    async def downloads(self, message):
        user = self._linked_owner(message.from_user.id)
        if not user:
            await message.answer('Привяжите Telegram к аккаунту Puuk. Подробности в /start.')
            return
        text, keyboard = self._downloads_card(message.from_user.id, user['id'], 0)
        await message.answer(text, parse_mode='HTML', reply_markup=keyboard, disable_notification=True)

    async def callback(self, callback):
        telegram_id = callback.from_user.id
        user = self._linked_owner(telegram_id)
        if not user:
            await callback.answer('Нет доступа.', show_alert=True)
            return
        parts = callback.data.split(':')
        if len(parts) not in {3, 4}:
            await callback.answer('Действие недоступно.', show_alert=True)
            return
        _, action, raw_id, *args = parts
        if not raw_id.isdecimal() or (args and not args[0].isdecimal()):
            await callback.answer('Действие недоступно.', show_alert=True)
            return
        job_id, argument = int(raw_id), int(args[0]) if args else 0
        if action == 'list':
            text, keyboard = self._downloads_card(telegram_id, user['id'], argument)
        elif action == 'vklist':
            text, keyboard = self._vk_collections_card(telegram_id, user['id'], argument)
        else:
            job = self.jobs.job(job_id)
            if not job or job['user_id'] != telegram_id or job['owner_id'] != user['id']:
                await callback.answer('Нет доступа.', show_alert=True)
                return
            if action in RECOVERY_ACTIONS:
                await self.recovery.handle(callback, job, action, argument)
                return
            if action in {'vkbstart', 'vkbnext', 'vkbpick'}:
                await self._vk_batch(callback, job, action, argument)
                return
            if action in {'vkmeta', 'vkpick', 'vkback'}:
                await self._vk_metadata(callback, job, user, action, argument)
                return
            if action == 'save':
                result_id = job['playlist_id'] or job['result_id']
                if job['state'] == 'finished' and result_id and job['mode'] == 'server':
                    catalog.save_result(user['id'], job['kind'], result_id)
            elif action == 'repair':
                row = next((row for row in self.jobs.positions(job_id)
                            if row['position'] == argument and row['state'] == 'skipped'), None)
                if not row or job['state'] not in {'active', 'finished'}:
                    await callback.answer('Эта позиция больше не ждёт добора', show_alert=True)
                    return
                instruction = f'Ответьте файлом или точной ссылкой для № {argument}.'
                if json.loads(row['source']).get('song'):
                    instruction += ' Бот добавит выбранную вами версию.'
                prompt = await callback.message.answer(instruction,
                                                       reply_markup=ForceReply(),
                                                       disable_notification=True)
                self.jobs.remember_repair(prompt.chat.id, prompt.message_id, job_id, argument)
                await callback.answer()
                return
            elif action == 'albumversion':
                row = next((row for row in self.jobs.positions(job_id)
                            if row['position'] == 1), None)
                if not row or job['kind'] != 'track' or row['state'] != 'done':
                    await callback.answer('Этот вариант недоступен.', show_alert=True)
                    return
                request = {'album_version': json.loads(row['source'])}
                try:
                    new_job, _ = self.jobs.submit(telegram_id, user['id'], job['chat_id'],
                                                  -(job_id * 1001 + argument), request, job['mode'])
                except ValueError as exc:
                    await callback.answer(str(exc), show_alert=True)
                    return
                async with self._lock(new_job):
                    if self.jobs.job(new_job)['status_message'] is None:
                        reply = await callback.message.answer(QUEUE_CARD, parse_mode='HTML', disable_notification=True)
                        self.jobs.set_message(new_job, reply.message_id)
                await callback.answer()
                return
            elif action == 'confirm':
                await callback.answer('Сверяю изменения')
                async with self._lock(job_id):
                    job = self.jobs.job(job_id)
                    if job['state'] == 'review':
                        await self._confirm(job)
                self.dirty.add(job_id)
                return
            elif action == 'metadata':
                async with self._lock(job_id):
                    job = self.jobs.job(job_id)
                    options = json.loads(job['review'] or '{}').get('options', [])
                    if job['state'] == 'review' and 0 < argument <= len(options):
                        selected = options[argument - 1]
                        sources = [json.loads(row['source']) for row in self.jobs.positions(job_id)]
                        for source in sources:
                            source['metadata'] = selected
                        title = selected.get('album') if job['kind'] == 'album' else selected.get('title')
                        self.jobs.snapshot(job_id, title or job['title'], job['kind'], sources)
                self.dirty.add(job_id)
            elif action not in {'listshow', 'show'}:
                changed = self.jobs.control(job_id, telegram_id, user['id'], action, argument)
                if changed and action in {'pause', 'cancel'}:
                    tasks = list(self.pending.get(job_id, ()))
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
                if changed and action == 'cancel':
                    self._clean_cancelled(job)
                self.dirty.add(job_id)
            async with self._lock(job_id):
                text, keyboard = self._card(self.jobs.job(job_id), argument if action in {'listshow', 'show'} else 0)
                if callback.message.message_id != job['status_message'] and callback.message.chat.id == job['chat_id']:
                    rows = keyboard.inline_keyboard if keyboard else []
                    keyboard = _keyboard(rows + [[_button('Мои загрузки', 'imp:list:0:0')]])
                    if action == 'listshow' and argument == 0 and keyboard:
                        for row in keyboard.inline_keyboard:
                            for button in row:
                                if button.callback_data and button.callback_data.startswith('imp:show:'):
                                    button.callback_data = button.callback_data.replace('imp:show:', 'imp:listshow:')
                await self._edit_callback(callback, text, keyboard)
            return
        await self._edit_callback(callback, text, keyboard)

    @staticmethod
    async def _edit_callback(callback, text, keyboard):
        await callback.answer()
        await TelegramImports._edit_callback_message(callback.message, text, keyboard)

    @staticmethod
    async def _edit_callback_message(message, text, keyboard):
        try:
            await message.edit_text(text, parse_mode='HTML', reply_markup=keyboard)
        except TelegramBadRequest as exc:
            if 'message is not modified' not in str(exc).lower():
                raise

    async def _child(self, action, directory, request, timeout, *, progress=False):
        directory.mkdir(parents=True, exist_ok=True)
        request_path, result_path = directory / 'request.json', directory / 'result.json'
        request_path.write_text(json.dumps(request))
        try:
            command = [sys.executable, str(WORK_SCRIPT), action, str(directory), str(request_path), str(result_path)]
            if progress:
                progress_path = directory / 'progress.txt'
                progress_path.unlink(missing_ok=True)
                command.extend(('--progress', str(progress_path)))
            await _run_download_process(command, str(directory / 'worker.log'), timeout)
            result = json.loads(result_path.read_text())
            if 'error' in result:
                raise SourceError(result['error'], result.get('temporary', False), result.get('alternative'))
            return result['data']
        finally:
            request_path.unlink(missing_ok=True)
            result_path.unlink(missing_ok=True)

    async def _resolve(self, job):
        job_id = job['id']
        directory = self.root / str(job_id) / 'snapshot'
        try:
            if not self._linked_owner(job['user_id'], job['owner_id']):
                raise SourceError('Доступ к загрузке отозван')
            request = json.loads(job['request'])
            if 'url' in request:
                title, kind, sources = await self._child('link', directory, request, 240)
            elif 'selection' in request:
                source = request['selection']
                title, kind, sources = source['title'], 'track', [source]
            elif 'album_version' in request:
                title, kind, sources = await self._child('album-version', directory, request['album_version'], 90)
            else:
                directory.mkdir(parents=True, exist_ok=True)
                if shutil.disk_usage(directory).free < MAX_FILE_BYTES * 2:
                    raise SourceError('Недостаточно места для вложения')
                filename = request.get('filename') or 'album.zip'
                file = directory / ('original-' + filename)
                if not file.exists():
                    if 'attachments' in request:
                        await self._assemble_attachments(file, request['attachments'])
                    else:
                        temp = file.with_name(file.name + '.part')
                        await self.bot.download(request['file_id'], destination=temp, timeout=300)
                        temp.rename(file)
                title, kind, sources = await self._child('attachment', directory, {'path': str(file)}, 180)
            playlist_id = None
            created, review, retained = False, None, None
            if sources and (options := sources[0].pop('metadata_options', None)):
                review = {'options': options}
            if kind == 'playlist' and job['mode'] == 'server':
                playlist_id, created = catalog.prepare_playlist(job['owner_id'], request['url'], title)
                if created:
                    imported_playlists.apply_playlist(job['owner_id'], playlist_id, sources)
                else:
                    retained = imported_playlists.retained_tracks(job['owner_id'], playlist_id)
                    revision, lines = imported_playlists.playlist_preview(job['owner_id'], playlist_id, sources)
                    if lines:
                        review = {'revision': revision, 'lines': lines}
            self.jobs.snapshot(job_id, title, kind, sources, playlist_id, initial=created,
                               review=review, retained=retained)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._log_error(job_id, exc)
            self.jobs.fail(job_id, str(exc)[:400] if isinstance(exc, SourceError)
                           else 'Не удалось прочитать ссылку или вложение')
            shutil.rmtree(directory, ignore_errors=True)
        finally:
            self.dirty.add(job_id)

    async def _assemble_attachments(self, output, attachments):
        files = []
        total = 0
        for index, attachment in enumerate(attachments, 1):
            name = attachment['filename']
            if Path(name).suffix.lower() not in {'.flac', '.mp3', '.m4a'}:
                raise SourceError('Для сборки альбома нужны дорожки MP3, FLAC или M4A')
            path = output.parent / f'batch-{index}'
            if not path.exists():
                temporary = path.with_suffix('.part')
                await self.bot.download(attachment['file_id'], destination=temporary, timeout=300)
                temporary.rename(path)
            total += path.stat().st_size
            if total > MAX_FILE_BYTES:
                raise SourceError('Общий размер файлов альбома превышает 2000 МБ')
            files.append((path, f'{index}/{name}'))

        def pack():
            temporary = output.with_suffix('.part')
            with ZipFile(temporary, 'w', ZIP_STORED) as archive:
                for path, name in files:
                    archive.write(path, name)
            temporary.rename(output)
            for path, _ in files:
                path.unlink()

        await asyncio.to_thread(pack)

    async def _confirm(self, job):
        job_id, playlist_id, owner_id = job['id'], job['playlist_id'], job['owner_id']
        directory = self.root / str(job_id) / 'confirm'
        try:
            title, kind, sources = await self._child('link', directory, json.loads(job['request']), 240)
            if kind != 'playlist' or self.jobs.job(job_id)['state'] != 'review':
                return
            shown = json.loads(job['review'])
            proposed = [json.loads(row['source']) for row in self.jobs.positions(job_id)]
            signature = lambda items: [(item['slot'], item['title']) for item in items]
            revision, lines = imported_playlists.playlist_preview(owner_id, playlist_id, sources)
            if signature(proposed) != signature(sources) or revision != shown['revision']:
                review = {'revision': revision, 'lines': lines} if lines else None
            elif imported_playlists.apply_playlist(owner_id, playlist_id, sources, revision):
                review = None
            else:
                return
            retained = imported_playlists.retained_tracks(owner_id, playlist_id)
            self.jobs.snapshot(job_id, title, kind, sources, playlist_id, review=review, retained=retained)
        except Exception as exc:
            self._log_error(job_id, exc)
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    @staticmethod
    def _log_error(job_id, exc):
        logger.warning('Import %s: %s', job_id, type(exc).__name__)

    def _clean_cancelled(self, job):
        current = self.jobs.job(job['id'])
        if current['playlist_id'] and current['initial_playlist']:
            catalog.cancel_playlist(current['owner_id'], current['playlist_id'])
            self.jobs.cancellation_cleaned(current['id'])
        shutil.rmtree(self.root / str(current['id']), ignore_errors=True)

    async def _download(self, row, job):
        job_id, position = row['job_id'], row['position']
        directory = self.root / str(job_id) / f'position-{position}'
        try:
            if not self._linked_owner(job['user_id'], job['owner_id']):
                self.jobs.fail(job_id, 'Доступ к загрузке отозван')
                return
            if shutil.disk_usage(self.root).free < MAX_FILE_BYTES:
                raise SourceError('Недостаточно места для загрузки', temporary=True)
            source = json.loads(row['source'])
            replacement = source.get('replacement') or {}
            if replacement.get('file_id'):
                directory.mkdir(parents=True, exist_ok=True)
                path = directory / ('repair-' + replacement['filename'])
                if not path.exists():
                    temporary = path.with_name(path.name + '.part')
                    await self.bot.download(replacement['file_id'], destination=temporary, timeout=300)
                    temporary.replace(path)
                source['replacement'] = {'path': str(path)}
            if job['kind'] == 'album' and source['type'] == 'spotify':
                source['local_flac'] = catalog.find_release_flac(source, self.music_dir)
            artifact = await self._child('audio', directory, source, 240, progress=job['kind'] == 'track')
            self.jobs.downloaded(job_id, position, artifact)
        except asyncio.CancelledError:
            self.jobs.interrupt(job_id, position)
            raise
        except Exception as exc:
            self._log_error(job_id, exc)
            temporary = not isinstance(exc, SourceError) or exc.temporary
            reason = str(exc) if isinstance(exc, SourceError) else 'Источнику не удалось передать файл'
            self.jobs.skip(job_id, position, reason[:400], temporary=temporary,
                           alternative=exc.alternative if isinstance(exc, SourceError) else None)
            shutil.rmtree(directory, ignore_errors=True)
        finally:
            self.dirty.add(job_id)

    async def _deliver(self, job):
        job_id = job['id']
        if job['mode'] == 'chat' and self.delivery_after.get(job['chat_id'], 0) > time.monotonic():
            self.dirty.add(job_id)
            return
        while job['state'] in {'active', 'finished'}:
            row = self.jobs.deliverable(job_id, job['mode'])
            if row is None:
                break
            position = row['position']
            artifact, source = json.loads(row['artifact']), json.loads(row['source'])
            path = Path(artifact['path'])
            try:
                if not self._linked_owner(job['user_id'], job['owner_id']):
                    self.jobs.fail(job_id, 'Доступ к загрузке отозван')
                    break
                track_id = result_id = None
                if job['mode'] == 'server':
                    track_id, album_id = catalog.publish(
                        job['owner_id'], source, artifact, self.music_dir, position=position,
                        playlist_id=job['playlist_id'], album=job['kind'] == 'album',
                        selected_album_id=job['result_id'] if job['kind'] == 'album' else None)
                    result_id = album_id if job['kind'] == 'album' else track_id if job['kind'] == 'track' else None
                else:
                    count = len(self.jobs.positions(job_id))
                    caption = f"{job['title'][:250]} · Трек {position} из {count}" if count > 1 else None
                    title = source['title'][:150]
                    filename = title.replace('/', '_').replace('\\', '_') + path.suffix
                    file = FSInputFile(path, filename=filename)
                    if not self.jobs.chat_sending(job_id, position):
                        break
                    if path.suffix.lower() in {'.mp3', '.m4a'}:
                        await self.bot.send_audio(job['chat_id'], file, title=title, caption=caption,
                                                  disable_notification=True)
                    else:
                        await self.bot.send_document(job['chat_id'], file, caption=caption, disable_notification=True)
                self.jobs.delivered(job_id, position, track_id, result_id)
            except TelegramRetryAfter as exc:
                self.jobs.chat_sending(job_id, position, delayed=True)
                self.delivery_after[job['chat_id']] = time.monotonic() + min(exc.retry_after, 60)
                self.dirty.add(job_id)
                break
            except Exception as exc:
                self._log_error(job_id, exc)
                self.jobs.skip(job_id, position, 'Не удалось опубликовать готовый файл')
            shutil.rmtree(self.root / str(job_id) / f'position-{position}', ignore_errors=True)
            job = self.jobs.job(job_id)
            if job['mode'] == 'chat' and self.jobs.deliverable(job_id, job['mode']):
                self.dirty.add(job_id)
                break
        self.jobs.settle(job_id)
        job = self.jobs.job(job_id)
        if job['state'] == 'finished' and all(row['state'] == 'done' for row in self.jobs.positions(job_id)):
            shutil.rmtree(self.root / str(job_id), ignore_errors=True)

    async def _resolver(self):
        while True:
            job = self.jobs.claim_snapshot()
            if job:
                self.dirty.add(job['id'])
                await self._resolve(job)
            else:
                await asyncio.sleep(0.5)

    async def _loader(self):
        while True:
            row = self.jobs.claim_position()
            if row:
                job_id = row['job_id']
                task = asyncio.create_task(self._download(row, self.jobs.job(job_id)))
                self.pending[job_id].add(task)
                self.dirty.add(job_id)
                try:
                    await asyncio.gather(task, return_exceptions=True)
                finally:
                    self.pending[job_id].discard(task)
                    if not self.pending[job_id]:
                        del self.pending[job_id]
            else:
                await asyncio.sleep(0.5)

    async def _publisher(self):
        self.dirty.update(self.jobs.recoverable())
        last_progress = {}
        next_progress_check = 0.0
        while True:
            await asyncio.sleep(0.7)
            pending, self.dirty = self.dirty, set()
            now = time.monotonic()
            if now >= next_progress_check:
                active_progress = {}
                for job_id in self.pending:
                    job = self.jobs.job(job_id)
                    if job['kind'] == 'track' and job['state'] in {'active', 'finished'}:
                        active_progress[job_id] = self._position_progress(job_id, 1)
                pending.update(job_id for job_id, value in active_progress.items()
                               if last_progress.get(job_id) != value)
                last_progress = active_progress
                next_progress_check = now + 2.5
            pending.update(self.jobs.expire_retries())
            jobs = sorted((self.jobs.job(job_id) for job_id in pending),
                          key=lambda job: (job['kind'] != 'track', job['id']))
            for job in jobs:
                job_id = job['id']
                if job['kind'] == 'track' and job['state'] in {'active', 'finished'}:
                    if self.jobs.deliverable(job_id, job['mode']):
                        try:
                            async with self._lock(job_id):
                                await self._edit(self.jobs.job(job_id))
                        except TelegramAPIError as exc:
                            self._log_error(job_id, exc)
                await self._deliver(job)
                try:
                    async with self._lock(job_id):
                        job = self.jobs.job(job_id)
                        if (job['mode'] == 'chat' and job['kind'] == 'track' and job['state'] == 'finished'
                                and job['status_message'] is not None
                                and all(row['state'] == 'done' for row in self.jobs.positions(job_id))):
                            try:
                                await self.bot.delete_message(job['chat_id'], job['status_message'])
                            except TelegramBadRequest as exc:
                                if 'message to delete not found' not in str(exc).lower():
                                    raise
                            self.jobs.set_message(job_id, None)
                        else:
                            await self._edit(job)
                except Exception as exc:
                    self._log_error(job_id, exc)

    async def _reviewer(self):
        while True:
            review = recording_reviews.claim()
            if not review:
                await asyncio.sleep(3)
                continue
            directory = self.root / f"review-{review['id']}"
            root = Path(self.music_dir).resolve()
            path = (root / review['file_path']).resolve()
            result = 'unavailable'
            try:
                if path.is_relative_to(root) and path.is_file():
                    request = {**json.loads(review['source']), 'path': str(path),
                               'revision': review['revision']}
                    result = await self._child('review', directory, request, 90)
            except Exception as exc:
                self._log_error(f"review-{review['id']}", exc)
            finally:
                shutil.rmtree(directory, ignore_errors=True)
            if recording_reviews.finish(review, result) == 'mismatch':
                self.dirty.update(self.jobs.mark_wrong_version(review['track_id']))

    async def _analysis_delivery(self):
        while True:
            try:
                await asyncio.to_thread(publish_import_analysis, self.music_dir)
            except Exception as exc:
                logger.warning('Import analysis delivery: %s', type(exc).__name__)
            await asyncio.sleep(10)

    async def run(self):
        self.jobs.start_worker()
        try:
            for job in self.jobs.pending_cancellations():
                self._clean_cancelled(job)
            recording_reviews.recover()
            async with asyncio.TaskGroup() as workers:
                workers.create_task(self._resolver())
                workers.create_task(self._resolver())
                workers.create_task(self._publisher())
                workers.create_task(self._reviewer())
                workers.create_task(self._analysis_delivery())
                workers.create_task(self.recovery.run())
                workers.create_task(self.metadata_batch.run())
                for _ in range(self.workers):
                    workers.create_task(self._loader())
        finally:
            self.jobs.close()
