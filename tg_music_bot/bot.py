import os
import sys
import time
import logging
import asyncio
import uuid
import shutil
import random
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import CommandStart, Command
from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, FSInputFile

# Добавляем brain в sys.path для работы с базой данных
brain_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '../brain'))
if brain_dir not in sys.path:
    sys.path.insert(0, brain_dir)

import db
from downloader import download_audio, download_spotify, search_youtube

# Load environment variables
env_path = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(env_path):
    load_dotenv(dotenv_path=env_path)
load_dotenv()

BOT_TOKEN = os.getenv('BOT_TOKEN')
ALLOWED_USERS_STR = os.getenv('ALLOWED_USERS', '')

# Parse allowed users (comma separated IDs)
try:
    ALLOWED_USERS = [int(uid.strip()) for uid in ALLOWED_USERS_STR.split(',') if uid.strip()]
except ValueError:
    print("Warning: Error parsing ALLOWED_USERS. Make sure they are comma-separated integers.")
    ALLOWED_USERS = []

# Initialize bot and dispatcher
effective_token = BOT_TOKEN if (BOT_TOKEN and BOT_TOKEN != 'your_bot_token_here') else "1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
bot = Bot(token=effective_token)
dp = Dispatcher()

logging.basicConfig(level=logging.INFO)

user_modes = {} # user_id -> 'server' or 'chat'
MUSIC_DIR = os.getenv('MUSIC_DIR', '/mnt/data/projects/puuk/music')

def get_puuk_user(tg_id: int) -> dict | None:
    """Ищет пользователя Puuk по Telegram ID или fallback в ALLOWED_USERS."""
    user = db.get_user_by_telegram_id(tg_id)
    if user:
        return dict(user)
    if tg_id in ALLOWED_USERS:
        admin_user = db.get_user_by_id(1)
        if admin_user:
            return dict(admin_user)
    return None

def is_user_allowed(user_id: int) -> bool:
    return get_puuk_user(user_id) is not None

def generate_otp_code(user_id: int) -> str:
    """Генерирует 6-значный одноразовый код со сроком жизни 5 минут."""
    code = f"{random.randint(100000, 999999)}"
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    db.create_auth_code(user_id, code, expires_at)
    return code

@dp.message(CommandStart())
async def cmd_start(message: Message):
    if not is_user_allowed(message.from_user.id):
        await message.answer(
            f"❌ <b>Доступ ограничен.</b>\n\nВаш Telegram ID: <code>{message.from_user.id}</code> не привязан к аккаунту Puuk.\n"
            f"Администратор может привязать ваш ID командой:\n"
            f"<code>brain/venv/bin/python3 brain/manage_users.py link-tg --username ВАШ_ЛОГИН --tg-id {message.from_user.id}</code>",
            parse_mode='HTML'
        )
        return
        
    puuk_user = get_puuk_user(message.from_user.id)
    username = puuk_user.get("username", "пользователь")
    
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="💾 1. Сохранять на сервер", callback_data="mode_server")],
        [InlineKeyboardButton(text="💬 2. Отправлять в чат", callback_data="mode_chat")],
        [InlineKeyboardButton(text="🔑 3. Получить код для входа (OTP)", callback_data="get_otp")]
    ])
    await message.answer(
        f"Привет, <b>{username}</b>! Выбери действие или режим работы бота:", 
        reply_markup=keyboard,
        parse_mode='HTML'
    )

AUTH_KEYWORDS = {
    "код", "code", "логин", "login", "otp", "войти", "получить код",
    "авторизация", "пароль", "вход", "getcode", "токен", "token"
}

@dp.message(Command("login", "code", "otp", "auth", "getcode", "token", "код", "логин", ignore_case=True))
@dp.message(F.text.func(lambda text: text and text.strip().lower() in AUTH_KEYWORDS))
async def cmd_login(message: Message):
    puuk_user = get_puuk_user(message.from_user.id)
    if not puuk_user:
        await message.answer(
            f"❌ <b>Доступ ограничен.</b>\n\n"
            f"Ваш Telegram ID: <code>{message.from_user.id}</code> не привязан к аккаунту Puuk.\n"
            f"Администратор может привязать ваш ID командой:\n"
            f"<code>python3 brain/manage_users.py link-tg --username ВАШ_ЛОГИН --tg-id {message.from_user.id}</code>",
            parse_mode='HTML'
        )
        return
        
    code = generate_otp_code(puuk_user["id"])
    import html
    username = puuk_user.get("username", "пользователь")
    await message.answer(
        f"🔑 <b>Ваш одноразовый код для входа в Puuk ({html.escape(username)}):</b>\n\n"
        f"<code>{code}</code>\n\n"
        f"⏳ Срок действия: <b>5 минут</b>.\n"
        f"<i>Нажмите на код, чтобы скопировать его, и введите в приложении на телефоне или в веб-интерфейсе.</i>",
        parse_mode='HTML'
    )

@dp.message(Command("help", "помощь", ignore_case=True))
async def cmd_help(message: Message):
    await message.answer(
        "👋 <b>Puuk Music Bot — Справка</b>\n\n"
        "🔑 <b>Вход в приложение (iOS / Web):</b>\n"
        "• Отправьте команду <code>/code</code> или напишите слово <b>код</b>, чтобы получить 6-значный одноразовый код (OTP) для авторизации.\n\n"
        "🎵 <b>Поиск и скачивание музыки:</b>\n"
        "• Отправьте ссылку на трек или плейлист (YouTube, Spotify, VK, SoundCloud)\n"
        "• Или отправьте название песни текстом для поиска по YouTube\n\n"
        "⚙️ <b>Режим работы:</b>\n"
        "• Команда <code>/start</code> открывает главное меню:\n"
        "  1. <i>Сохранять на сервер</i> (трек добавляется в медиатеку Puuk и в ваши Лайки)\n"
        "  2. <i>Отправлять в чат</i> (mp3 файл отправляется прямо в чат Telegram)\n"
        "  3. <i>Получить код для входа (OTP)</i>",
        parse_mode='HTML'
    )

@dp.callback_query(F.data == 'get_otp')
async def process_get_otp(callback: types.CallbackQuery):
    puuk_user = get_puuk_user(callback.from_user.id)
    if not puuk_user:
        await callback.answer("У вас нет доступа.", show_alert=True)
        return
        
    code = generate_otp_code(puuk_user["id"])
    import html
    username = puuk_user.get("username", "пользователь")
    await callback.message.answer(
        f"🔑 <b>Ваш одноразовый код для входа в Puuk ({html.escape(username)}):</b>\n\n"
        f"<code>{code}</code>\n\n"
        f"⏳ Срок действия: <b>5 минут</b>.\n"
        f"<i>Нажмите на код, чтобы скопировать его, и введите в приложении на телефоне или в веб-интерфейсе.</i>",
        parse_mode='HTML'
    )
    await callback.answer()

@dp.callback_query(F.data.startswith('mode_'))
async def process_mode_selection(callback: types.CallbackQuery):
    if not is_user_allowed(callback.from_user.id):
        await callback.answer("У вас нет доступа.", show_alert=True)
        return
        
    mode = callback.data.split('_')[1]
    user_modes[callback.from_user.id] = mode
    mode_text = f"Сохранять на сервер ({MUSIC_DIR})" if mode == 'server' else "Отправлять в чат"
    await callback.message.edit_text(
        f"✅ Установлен режим: <b>{mode_text}</b>\n\n"
        f"Теперь отправь мне ссылку на трек (VK, Яндекс, Spotify, YouTube, SoundCloud) или напиши название песни для поиска.", 
        parse_mode='HTML'
    )
    await callback.answer()

async def process_download(user_id: int, chat_id: int, url: str, status_msg: Message):
    loop = asyncio.get_running_loop()
    last_edit_time = 0

    async def update_progress_async(text: str):
        nonlocal last_edit_time
        now = time.time()
        if now - last_edit_time > 2.0:
            try:
                import html
                await status_msg.edit_text(f"⏳ {html.escape(text)}", parse_mode='HTML')
                last_edit_time = now
            except Exception:
                pass

    def update_progress_sync(text: str):
        asyncio.run_coroutine_threadsafe(update_progress_async(text), loop)

    mode = user_modes.get(user_id, 'server')
    output_dir = MUSIC_DIR if mode == 'server' else f'/tmp/music_req_{uuid.uuid4()}'

    try:
        if 'spotify.com' in url:
            track_info = await download_spotify(url, output_dir=output_dir, progress_cb=update_progress_async)
        else:
            track_info = await loop.run_in_executor(None, download_audio, url, output_dir, update_progress_sync)
        
        if mode == 'chat':
            await status_msg.edit_text("📤 Отправка файлов в чат...")
            
            files = []
            if os.path.exists(output_dir):
                files = [os.path.join(output_dir, f) for f in os.listdir(output_dir) if os.path.isfile(os.path.join(output_dir, f))]
            
            if files:
                for file_path in files:
                    try:
                        audio = FSInputFile(file_path)
                        await bot.send_audio(chat_id, audio)
                    except Exception as e:
                        logging.error(f"Error sending audio {file_path}: {e}")
                await status_msg.delete()
            else:
                await status_msg.edit_text("❌ Не удалось найти скачанные файлы.")
                
            if os.path.exists(output_dir):
                shutil.rmtree(output_dir, ignore_errors=True)
                
        else:
            import html
            puuk_user = get_puuk_user(user_id)
            liked_note = ""
            
            # Автоматическая индексация и добавление в Лайки пользователя (7.1)
            if puuk_user and not track_info.get('is_spotify'):
                try:
                    filepath = track_info.get('filepath')
                    if filepath and os.path.exists(filepath):
                        rel_path = os.path.relpath(filepath, MUSIC_DIR)
                    else:
                        rel_path = f"{track_info['title']} - {track_info['artist']}.mp3"

                    track_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, rel_path))
                    db.add_or_update_track(
                        track_id=track_uuid,
                        file_path=rel_path,
                        title=track_info['title'],
                        album_id=None,
                        artist=track_info['artist'],
                        added_by_user_id=puuk_user['id']
                    )
                    db.add_favorite(puuk_user['id'], track_uuid)
                    liked_note = "\n❤️ <b>Трек автоматически добавлен в ваши Лайки в Puuk!</b>"
                except Exception as ex:
                    logging.error(f"Error auto-favoriting track: {ex}")

            if track_info.get('is_spotify'):
                total_dl = track_info.get('total_tracks', 0)
                if total_dl > 1:
                    response_text = f"✅ <b>Плейлист Spotify успешно скачан!</b>\nЗагружено треков: {total_dl}\n\n📁 Сохранен в: <code>{MUSIC_DIR}</code>"
                elif total_dl == 1:
                    response_text = f"✅ <b>Трек Spotify успешно скачан!</b>\n\n📁 Сохранен в: <code>{MUSIC_DIR}</code>"
                else:
                    response_text = f"❌ <b>Не удалось загрузить трек Spotify.</b>"
            else:
                duration_val = track_info.get('duration') or 0
                minutes = int(duration_val // 60)
                seconds = int(duration_val % 60)
                duration_str = f"{minutes}:{seconds:02d}"

                response_text = (
                    f"✅ <b>Трек успешно скачан!</b>\n\n"
                    f"🎵 <b>Название:</b> {html.escape(str(track_info['title']))}\n"
                    f"👤 <b>Исполнитель:</b> {html.escape(str(track_info['artist']))}\n"
                    f"⏱ <b>Длительность:</b> {duration_str}\n\n"
                    f"📁 Сохранен в: <code>{MUSIC_DIR}</code>"
                    f"{liked_note}"
                )
                
            await status_msg.edit_text(response_text, parse_mode='HTML')
        
    except Exception as e:
        import html
        logging.error(f"Download failed: {e}")
        try:
            await status_msg.edit_text(f"❌ Ошибка при скачивании:\n<code>{html.escape(str(e))}</code>", parse_mode='HTML')
        except Exception:
            pass
        if 'output_dir' in locals() and mode == 'chat' and os.path.exists(output_dir):
            shutil.rmtree(output_dir, ignore_errors=True)


@dp.callback_query(F.data.startswith('dl_yt_'))
async def process_yt_selection(callback: types.CallbackQuery):
    if not is_user_allowed(callback.from_user.id):
        await callback.answer("У вас нет доступа.", show_alert=True)
        return
        
    video_id = callback.data[6:]
    url = f"https://www.youtube.com/watch?v={video_id}"
    
    await callback.message.edit_text("⏳ Начинаю обработку...", reply_markup=None)
    await callback.answer()
    
    await process_download(callback.from_user.id, callback.message.chat.id, url, callback.message)


@dp.message(F.text)
async def handle_message(message: Message):
    if not is_user_allowed(message.from_user.id):
        await message.answer(
            f"❌ <b>У вас нет доступа.</b>\nВаш ID: <code>{message.from_user.id}</code>", 
            parse_mode='HTML'
        )
        return

    query_or_url = message.text.strip()
    
    # Защита: если пользователь ввел неизвестную слэш-команду, не ищем ее как песню!
    if query_or_url.startswith('/'):
        import html
        await message.answer(
            f"❓ Неизвестная команда: <code>{html.escape(query_or_url)}</code>\n\n"
            f"<b>Доступные команды:</b>\n"
            f"🔑 <code>/code</code> или <code>/login</code> — получить 6-значный код для входа (OTP)\n"
            f"🏠 <code>/start</code> — главное меню и выбор режима\n"
            f"ℹ️ <code>/help</code> — справка по боту\n\n"
            f"<i>Для поиска музыки отправьте название трека или ссылку без знака «/».</i>",
            parse_mode='HTML'
        )
        return
    
    if query_or_url.startswith('http'):
        status_msg = await message.answer("⏳ Начинаю обработку...")
        await process_download(message.from_user.id, message.chat.id, query_or_url, status_msg)
    else:
        status_msg = await message.answer("🔍 Ищу трек...")
        
        loop = asyncio.get_running_loop()
        try:
            results = await loop.run_in_executor(None, search_youtube, query_or_url, 5)
        except Exception as e:
            import html
            await status_msg.edit_text(f"❌ Ошибка поиска:\n<code>{html.escape(str(e))}</code>", parse_mode='HTML')
            return
            
        if not results:
            await status_msg.edit_text("❌ Ничего не найдено по вашему запросу.")
            return
            
        builder = []
        for res in results:
            title = res.get('title', 'Unknown')
            artist = res.get('uploader', 'Unknown')
            dur = res.get('duration') or 0
            mins = int(dur // 60)
            secs = int(dur % 60)
            label = f"{title} - {artist} ({mins}:{secs:02d})"
            if len(label) > 64:
                label = label[:61] + "..."
            builder.append([InlineKeyboardButton(text=label, callback_data=f"dl_yt_{res['id']}")])
        
        keyboard = InlineKeyboardMarkup(inline_keyboard=builder)
        await status_msg.edit_text("Выберите трек для скачивания:", reply_markup=keyboard)

async def main():
    if not BOT_TOKEN or BOT_TOKEN == 'your_bot_token_here':
        logging.error("BOT_TOKEN is not set correctly in .env file!")
        return
        
    logging.info("Starting bot...")
    try:
        await bot.set_my_commands([
            types.BotCommand(command="code", description="🔑 Получить код для входа (OTP)"),
            types.BotCommand(command="login", description="🔑 Войти в приложение Puuk"),
            types.BotCommand(command="start", description="🏠 Главное меню и режимы"),
            types.BotCommand(command="help", description="ℹ️ Справка и команды"),
        ])
    except Exception as e:
        logging.warning(f"Failed to set bot commands: {e}")
        
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
