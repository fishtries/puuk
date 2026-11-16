"""Embedded artwork extraction (MP3/MP4/FLAC) and dominant color calculation."""
import io
import os
from functools import lru_cache

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


def extract_cover_preview(file_path: str, size: int, version=0):
    """Bounded preview cache; file identity and metadata revision invalidate it.

    Audio and original artwork are read only. At most 32 previews of at most
    512 KiB are retained. Callers must authenticate before using this function.
    """
    st = os.stat(file_path)
    return _cover_preview(file_path, st.st_dev, st.st_ino, st.st_size,
                          st.st_mtime_ns, st.st_ctime_ns, size, version)


@lru_cache(maxsize=32)
def _cover_preview(file_path, device, inode, length, mtime, ctime, size, version):
    data, mime = extract_cover_bytes(file_path)
    if not data:
        return None, None
    return resize_cover_image(data, size)


def resize_cover_image(data, size):
    """Render the same bounded JPEG representation for embedded/default artwork."""
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(data)) as source:
        if source.width * source.height > 16_000_000:
            raise ValueError('Artwork exceeds preview decode budget')
        image = ImageOps.exif_transpose(source)
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        if image.mode != 'RGB':
            image = image.convert('RGB')
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=82, optimize=True)
    result = output.getvalue()
    if len(result) > 512 * 1024:
        raise ValueError('Artwork exceeds preview output budget')
    return result, 'image/jpeg'


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
