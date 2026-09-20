"""Embedded artwork extraction (MP3/MP4/FLAC) and dominant color calculation."""
import io
import os

from mutagen.id3 import ID3, APIC
from mutagen.mp4 import MP4
from mutagen.flac import FLAC

MEDIA_TYPES = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
}


def get_media_type(file_path: str) -> str:
    ext = os.path.splitext(file_path)[1].lower()
    return MEDIA_TYPES.get(ext, "application/octet-stream")


def extract_cover_bytes(file_path: str):
    """
    Возвращает (image_bytes, mime) встроенной обложки аудиофайла.
    mime может быть None, если формат её не сообщает.
    """
    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".mp3":
        tags = ID3(file_path)
        for tag in tags.values():
            if isinstance(tag, APIC):
                return tag.data, (tag.mime or "image/jpeg")

    elif ext in (".m4a", ".aac", ".mp4"):
        tags = MP4(file_path)
        covers = tags.get("covr", [])
        if covers:
            cover = covers[0]
            mime = "image/png" if cover.imageformat == MP4.COVER_FORMAT_PNG else "image/jpeg"
            return bytes(cover), mime

    elif ext == ".flac":
        tags = FLAC(file_path)
        if tags.pictures:
            pic = tags.pictures[0]
            return pic.data, (pic.mime or "image/jpeg")

    return None, None


def extract_dominant_hex(file_path: str) -> str:
    """
    Доминирующий цвет встроенной обложки в HEX. Бросает исключение, если обложки нет
    или декодирование невозможно — вызывающая сторона решает про fallback.
    """
    from colorthief import ColorThief

    img_data = None
    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".mp3":
        tags = ID3(file_path)
        for tag in tags.values():
            if isinstance(tag, APIC):
                img_data = tag.data
                break

    elif ext in (".m4a", ".aac", ".mp4"):
        tags = MP4(file_path)
        covers = tags.get("covr", [])
        if covers:
            img_data = bytes(covers[0])

    elif ext == ".flac":
        tags = FLAC(file_path)
        if tags.pictures:
            img_data = tags.pictures[0].data

    if not img_data:
        raise ValueError("No embedded cover")

    with io.BytesIO(img_data) as f:
        color_thief = ColorThief(f)
        dominant_color = color_thief.get_color(quality=1)
        return '#%02x%02x%02x' % dominant_color
