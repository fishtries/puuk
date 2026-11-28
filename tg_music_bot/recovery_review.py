"""Temporary Telegram player for reviewing skipped import positions."""
import asyncio
from dataclasses import dataclass, field
from html import escape
import json
import logging
from pathlib import Path
import secrets
import sqlite3
from tempfile import TemporaryDirectory
import time

from aiogram.exceptions import TelegramAPIError, TelegramBadRequest, TelegramForbiddenError
from aiogram.types import (
    ForceReply, FSInputFile, InlineKeyboardButton, InlineKeyboardMarkup, InputMediaAudio, ReplyParameters,
)

from recovery_candidates import PROVIDER_NAMES


logger = logging.getLogger(__name__)
REVIEW_TTL = 15 * 60
MAX_REVIEWS = 64
RECOVERY_ACTIONS = {'recover', 'revnext', 'revskip', 'revadd', 'revretry', 'revfile', 'revback', 'remaster'}


def reviewable_positions(rows):
    return [row for row in rows if row['state'] == 'skipped']


@dataclass
class Review:
    job_id: int
    owner_id: int
    reply_to: int
    position: int = 0
    options: list = field(default_factory=list)
    index: int = 0
    message_id: int | None = None
    audio: bool = False
    token: int = 0
    expires_at: float = 0
    waiting: bool = False


class RecoveryReview:
    def __init__(self, bot, jobs, root, run_child, mark_dirty, linked_owner):
        self.bot = bot
        self.jobs = jobs
        self.root = root
        self.run_child = run_child
        self.mark_dirty = mark_dirty
        self.linked_owner = linked_owner
        self.reviews = {}
        self.busy = set()
        self.slots = asyncio.Semaphore(2)

    async def handle(self, callback, job, action, token):
        if action == 'remaster':
            action = 'recover'
        chat_id, telegram_id = callback.message.chat.id, callback.from_user.id
        key = chat_id, telegram_id
        current = self.reviews.get(key)
        if action != 'recover' and (not current or current.job_id != job['id'] or current.token != token
                                    or current.message_id != callback.message.message_id
                                    or current.expires_at <= time.time()):
            await callback.answer('Просмотр устарел. Откройте пропуски в карточке загрузки.', show_alert=True)
            return
        if key in self.busy or self.slots.locked() or (current is None and len(self.reviews) >= MAX_REVIEWS):
            await callback.answer('Бот готовит фрагмент. Попробуйте чуть позже.')
            return

        self.busy.add(key)
        try:
            async with self.slots:
                await callback.answer('Готовлю варианты' if action in {'recover', 'revnext', 'revskip'} else None)
                await self._handle(key, current, job, action, token, callback.message.message_id)
        except (OSError, RuntimeError, ValueError, sqlite3.Error, TelegramAPIError) as exc:
            logger.warning('Import %s recovery review: %s', job['id'], type(exc).__name__)
        finally:
            self.busy.discard(key)

    async def _handle(self, key, current, job, action, token, reply_to):
        if action == 'revback':
            await self._close(key)
            return
        if job['state'] not in {'active', 'finished'}:
            await self._close(key)
            return
        missing = reviewable_positions(self.jobs.positions(job['id']))
        if action == 'recover':
            if not missing:
                return
            await self._close(key)
            current = Review(job['id'], job['owner_id'], reply_to)
            self.reviews[key] = current
            await self._open_position(key, current, missing, max(0, token - 1))
            return

        row = next((row for row in missing if row['position'] == current.position), None)
        if row is None or action == 'revskip':
            await self._open_position(key, current, missing, current.position)
        elif action == 'revnext' and current.options:
            current.index = (current.index + 1) % len(current.options)
            await self._show_option(key, current, row, missing)
        elif action == 'revfile':
            await self._close(key)
            is_vk = json.loads(row['source']).get('type') == 'vk'
            material = 'исходной ссылкой VK' if is_vk else 'аудиофайлом или ссылкой'
            prompt = await asyncio.wait_for(self.bot.send_message(
                key[0], f"Ответьте {material} для позиции № {row['position']}.",
                reply_markup=ForceReply(), disable_notification=True,
                reply_parameters=ReplyParameters(message_id=current.reply_to, allow_sending_without_reply=True),
            ), timeout=10)
            self.jobs.remember_repair(key[0], prompt.message_id, job['id'], row['position'])
        elif action in {'revadd', 'revretry'}:
            changed = self.jobs.control(job['id'], key[1], current.owner_id, 'retry', current.position) \
                if action == 'revretry' else (
                    current.options and self.jobs.choose_recovery_candidate(
                        job['id'], current.position, key[1], current.owner_id, current.options[current.index],
                    )
                )
            if changed:
                self.mark_dirty(job['id'])
                current.waiting = True
                text = f"<b>{self._heading(row)}</b>\nДобавляю в позицию № {current.position}"
                await self._render(key, current, text, self._buttons(current, [[('К загрузке', 'revback')]]),
                                   keep_audio=True)

    async def _open_position(self, key, current, missing, previous):
        if not missing:
            await self._close(key)
            return
        row = next((row for row in missing if row['position'] > previous), missing[0])
        current.position = row['position']
        current.index = 0
        current.options = []
        current.waiting = False
        source = json.loads(row['source'])
        with TemporaryDirectory(prefix='recovery-', dir=self.root) as directory:
            try:
                result = await self.run_child('recovery-options', Path(directory), {
                    'source': source, 'alternative': json.loads(row['alternative'] or 'null'),
                }, 40)
            except (OSError, RuntimeError, ValueError):
                result = {'options': [], 'unavailable': True}
        current.options = result['options']
        await self._show_option(key, current, row, missing, unavailable=result['unavailable'])

    async def _show_option(self, key, current, row, missing, *, unavailable=False, failed=False):
        count = next(index for index, item in enumerate(missing, 1) if item['position'] == row['position'])
        text = f"<b>{self._heading(row)}</b>\nПропуск {count} из {len(missing)}"
        if failed:
            text += '\nНе удалось добавить выбранный вариант.'
        if len(missing) > 1:
            next_row = [('Другой пропуск', 'revskip')]
        else:
            next_row = []
        manual = 'Исходная ссылка VK' if json.loads(row['source']).get('type') == 'vk' else 'Файл или ссылка'
        footer = [(manual, 'revfile'), ('К загрузке', 'revback')]
        if not current.options:
            reason = (row['error'] or '').casefold()
            transient = row['run_after'] or unavailable or 'временно' in reason or 'каталог недоступен' in reason
            text += '\n\n' + ('Площадка временно недоступна.' if transient else 'Подходящих версий пока нет.')
            if row['run_after']:
                text += '\nБот повторит попытку автоматически.'
            rows = [[('Повторить', 'revretry')]] if row['run_after'] == 0 else []
            if next_row:
                rows.append(next_row)
            await self._render(key, current, text, self._buttons(current, [*rows, footer]))
            return

        option = current.options[current.index]
        provider = PROVIDER_NAMES.get(option.get('provider'), 'Источник')
        duration = option.get('duration')
        length = f' · {int(duration) // 60}:{int(duration) % 60:02d}' if duration else ''
        text += (f"\n\nВариант {current.index + 1} из {len(current.options)}"
                 f"\n<b>{escape(option['title'][:160])}</b>"
                 f"\n{provider}{length} · {escape(option['description'])}")
        add = [(f"Добавить в позицию № {row['position']:02d}", 'revadd')]
        navigation = ([('Следующая версия', 'revnext')] if len(current.options) > 1 else []) + next_row
        with TemporaryDirectory(prefix='recovery-', dir=self.root) as directory:
            try:
                audio = await self.run_child('recovery-preview', Path(directory), option, 32)
            except (OSError, RuntimeError, ValueError):
                audio = None
            if not audio:
                text += '\nФрагмент недоступен.'
            buttons = self._buttons(current, [add, navigation, footer])
            if not audio:
                buttons.inline_keyboard.insert(1, [InlineKeyboardButton(text='Открыть на площадке', url=option['url'])])
            await self._render(key, current, text, buttons, audio=audio)

    @staticmethod
    def _heading(row):
        source = json.loads(row['source'])
        song = source.get('song') or {}
        artist = source.get('artist') or song.get('artist')
        title = source['title']
        label = f'{artist} — {title}' if artist else title
        return f"{row['position']:02d}. {escape(label[:180])}"

    @staticmethod
    def _buttons(current, rows):
        current.token = secrets.randbits(63)
        return InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text=label, callback_data=f'imp:{action}:{current.job_id}:{current.token}')
             for label, action in row] for row in rows if row
        ])

    async def _render(self, key, current, text, buttons, *, audio=None, keep_audio=False):
        chat_id, telegram_id = key
        reply = ReplyParameters(message_id=current.reply_to, allow_sending_without_reply=True)
        async with asyncio.timeout(15):
            if current.message_id and (audio or keep_audio or not current.audio):
                if audio:
                    await self.bot.edit_message_media(
                        InputMediaAudio(media=FSInputFile(audio, filename='preview.mp3'), caption=text, parse_mode='HTML',
                                        title='Фрагмент записи'),
                        chat_id=chat_id, message_id=current.message_id, reply_markup=buttons,
                    )
                elif current.audio:
                    await self.bot.edit_message_caption(chat_id=chat_id, message_id=current.message_id,
                                                        caption=text, parse_mode='HTML', reply_markup=buttons)
                else:
                    await self.bot.edit_message_text(text, chat_id=chat_id, message_id=current.message_id,
                                                     parse_mode='HTML', reply_markup=buttons)
            else:
                if current.message_id:
                    await self._delete(key)
                    current.message_id = None
                if audio:
                    message = await self.bot.send_audio(
                        chat_id, FSInputFile(audio, filename='preview.mp3'), title='Фрагмент записи', caption=text,
                        parse_mode='HTML', reply_markup=buttons, disable_notification=True, reply_parameters=reply,
                    )
                else:
                    message = await self.bot.send_message(chat_id, text, parse_mode='HTML', reply_markup=buttons,
                                                          disable_notification=True, reply_parameters=reply)
                current.message_id = message.message_id
        current.audio = bool(audio) or (keep_audio and current.audio)
        current.expires_at = time.time() + REVIEW_TTL
        self.jobs.remember_preview_message(chat_id, telegram_id, current.message_id, current.expires_at)

    async def _delete(self, key):
        message = self.jobs.preview_message(*key)
        if message:
            ident = message['message_id']
            try:
                await asyncio.wait_for(self.bot.delete_message(key[0], ident), timeout=5)
            except TelegramBadRequest as exc:
                if not any(reason in str(exc).lower() for reason in ('message to delete not found', "message can't be deleted")):
                    raise
            except TelegramForbiddenError:
                pass
            self.jobs.forget_preview_message(*key, ident)

    async def _close(self, key):
        await self._delete(key)
        self.reviews.pop(key, None)

    async def run(self):
        next_cleanup = 0.0
        while True:
            await asyncio.sleep(1)
            async with asyncio.TaskGroup() as tasks:
                if time.monotonic() >= next_cleanup:
                    next_cleanup = time.monotonic() + 30
                    for row in self.jobs.expired_preview_messages(time.time()):
                        key = (row['chat_id'], row['user_id'])
                        if key not in self.busy:
                            self.busy.add(key)
                            tasks.create_task(self._maintain(key, expired=True))
                for key, current in tuple(self.reviews.items()):
                    if current.waiting and key not in self.busy:
                        job = self.jobs.job(current.job_id)
                        positions = self.jobs.positions(current.job_id)
                        waiting = next((row for row in positions if row['position'] == current.position), None)
                        if (not job or job['state'] not in {'active', 'finished'}
                                or (waiting and waiting['state'] in {'done', 'skipped'})):
                            self.busy.add(key)
                            tasks.create_task(self._maintain(key))

    async def _maintain(self, key, *, expired=False):
        try:
            if expired:
                await self._close(key)
                return
            current = self.reviews[key]
            job = self.jobs.job(current.job_id)
            if not job or job['state'] not in {'active', 'finished'} or not self.linked_owner(key[1], current.owner_id):
                await self._close(key)
                return
            if self.slots.locked():
                return
            async with self.slots:
                positions = self.jobs.positions(current.job_id)
                missing = reviewable_positions(positions)
                row = next((row for row in missing if row['position'] == current.position), None)
                current.waiting = False
                if row:
                    await self._show_option(key, current, row, missing,
                                            unavailable=bool(row['run_after']), failed=True)
                else:
                    await self._open_position(key, current, missing, current.position)
        except (OSError, RuntimeError, ValueError, sqlite3.Error, TelegramAPIError) as exc:
            logger.warning('Recovery preview maintenance: %s', type(exc).__name__)
        finally:
            self.busy.discard(key)
