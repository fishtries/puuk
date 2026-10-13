"""Чтение, запись и проверка аудиотегов (ID3 и др.) для скачанных треков.

Модуль назван `audio_tags`, а не `metadata`, чтобы не конфликтовать с
`brain/metadata.py`: бот кладёт каталог brain в начало sys.path, поэтому
`import metadata` из бота резолвится в backend-модуль, а не в этот файл.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from typing import Optional

import mutagen
from mutagen.id3 import (
    APIC,
    COMM,
    TALB,
    TCON,
    TDRC,
    TIT2,
    TPE1,
    TPE2,
    TRCK,
    TPOS,
    USLT,
    ID3,
    ID3NoHeaderError,
)

logger = logging.getLogger(__name__)

AUDIO_EXTENSIONS = {".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav"}

_TAG_PRESETS = {
    "mp3": {
        "title": "TIT2",
        "artist": "TPE1",
        "album": "TALB",
        "album_artist": "TPE2",
        "date": "TDRC",
        "genre": "TCON",
        "track_number": "TRCK",
        "disc_number": "TPOS",
        "comment": "COMM",
    },
}


@dataclass
class AudioTags:
    path: str
    format: str = ""
    title: str = ""
    artist: str = ""
    album: str = ""
    album_artist: str = ""
    date: str = ""
    genre: str = ""
    track_number: str = ""
    disc_number: str = ""
    comment: str = ""
    lyrics: str = ""
    has_cover: bool = False
    duration: float = 0.0
    extra: dict = field(default_factory=dict)

    def as_metadata(self) -> dict:
        return {
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "album_artist": self.album_artist,
            "date": self.date,
            "year": extract_year(self.date),
            "genre": self.genre,
            "track_number": self.track_number,
            "disc_number": self.disc_number,
            "comment": self.comment,
            "lyrics": self.lyrics,
            "has_cover": self.has_cover,
            "duration": self.duration,
            "filepath": self.path,
        }


def extract_year(value: Optional[str]) -> str:
    if not value:
        return ""
    match = re.search(r"(\d{4})", str(value))
    return match.group(1) if match else ""


def parse_filename_metadata(path: str) -> tuple[str, str]:
    """Fallback: извлекает (artist, title) из имени файла вида 'Artist - Title'."""
    stem = os.path.splitext(os.path.basename(path))[0]
    if " - " in stem:
        artist, _, title = stem.partition(" - ")
        return artist.strip(), title.strip()
    return "", stem.strip()


def _clean(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    return str(value).strip()


def _read_mp3(path: str) -> AudioTags:
    tags = AudioTags(path=path, format="mp3")
    try:
        id3 = ID3(path)
    except (ID3NoHeaderError, mutagen.MutagenError):
        id3 = ID3()

    def text(frame_id: str) -> str:
        frame = id3.get(frame_id)
        return _clean(frame) if frame is not None else ""

    tags.title = text("TIT2")
    tags.artist = text("TPE1")
    tags.album = text("TALB")
    tags.album_artist = text("TPE2")
    tags.date = text("TDRC")
    tags.genre = text("TCON")
    tags.track_number = text("TRCK")
    tags.disc_number = text("TPOS")

    comm = id3.getall("COMM")
    if comm:
        tags.comment = _clean(comm[0])

    uslt = id3.getall("USLT")
    if uslt:
        tags.lyrics = _clean(uslt[0])

    tags.has_cover = bool(id3.getall("APIC"))
    tags.duration = _duration(path)
    return tags


def _read_generic(path: str) -> AudioTags:
    tags = AudioTags(path=path, format=os.path.splitext(path)[1].lstrip(".").lower())
    try:
        audio = mutagen.File(path, easy=True)
    except Exception as exc:
        logger.debug("[audio_tags] cannot read %s: %s", path, exc)
        audio = None
    if audio is not None:
        tags.title = _clean(audio.get("title"))
        tags.artist = _clean(audio.get("artist"))
        tags.album = _clean(audio.get("album"))
        tags.album_artist = _clean(audio.get("albumartist"))
        tags.date = _clean(audio.get("date"))
        tags.genre = _clean(audio.get("genre"))
        tags.track_number = _clean(audio.get("tracknumber"))
        tags.disc_number = _clean(audio.get("discnumber"))
        tags.has_cover = bool(getattr(audio, "pictures", None))
    tags.duration = _duration(path)
    return tags


def _duration(path: str) -> float:
    try:
        audio = mutagen.File(path)
        if audio is not None and audio.info is not None:
            return float(audio.info.length)
    except Exception:
        pass
    return 0.0


def read_audio_tags(path: str) -> AudioTags:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".mp3":
        return _read_mp3(path)
    return _read_generic(path)


def _write_mp3(
    path: str,
    fields: dict,
    cover_bytes: Optional[bytes],
    cover_mime: str,
    overwrite: bool,
) -> None:
    try:
        id3 = ID3(path)
    except ID3NoHeaderError:
        id3 = ID3()

    def put(frame_id: str, frame) -> None:
        existing = id3.get(frame_id)
        if existing is not None and not overwrite:
            if _clean(existing):
                return
        id3.setall(frame_id, [frame])

    mapping = {
        "title": lambda v: TIT2(encoding=3, text=v),
        "artist": lambda v: TPE1(encoding=3, text=v),
        "album": lambda v: TALB(encoding=3, text=v),
        "album_artist": lambda v: TPE2(encoding=3, text=v),
        "date": lambda v: TDRC(encoding=3, text=v),
        "genre": lambda v: TCON(encoding=3, text=v),
        "track_number": lambda v: TRCK(encoding=3, text=v),
        "disc_number": lambda v: TPOS(encoding=3, text=v),
        "comment": lambda v: COMM(encoding=3, lang="eng", desc="", text=v),
    }
    for name, frame_cls in mapping.items():
        value = _clean(fields.get(name))
        if value:
            put(_TAG_PRESETS["mp3"][name], frame_cls(value))

    lyrics = fields.get("lyrics")
    if lyrics and (overwrite or not id3.getall("USLT")):
        id3.setall("USLT", [USLT(encoding=3, lang="eng", desc="", text=lyrics)])

    if cover_bytes:
        if overwrite or not id3.getall("APIC"):
            id3.setall(
                "APIC",
                [
                    APIC(
                        encoding=3,
                        mime=cover_mime or "image/jpeg",
                        type=3,
                        desc="Cover",
                        data=cover_bytes,
                    )
                ],
            )

    id3.save(path, v2_version=3)


def write_audio_metadata(
    path: str,
    *,
    title: Optional[str] = None,
    artist: Optional[str] = None,
    album: Optional[str] = None,
    album_artist: Optional[str] = None,
    date: Optional[str] = None,
    genre: Optional[str] = None,
    track_number: Optional[str] = None,
    disc_number: Optional[str] = None,
    comment: Optional[str] = None,
    lyrics: Optional[str] = None,
    cover_bytes: Optional[bytes] = None,
    cover_mime: str = "image/jpeg",
    overwrite: bool = False,
) -> AudioTags:
    fields = {
        "title": title,
        "artist": artist,
        "album": album,
        "album_artist": album_artist,
        "date": date,
        "genre": genre,
        "track_number": str(track_number) if track_number is not None else None,
        "disc_number": str(disc_number) if disc_number is not None else None,
        "comment": comment,
        "lyrics": lyrics,
    }
    ext = os.path.splitext(path)[1].lower()
    if ext == ".mp3":
        _write_mp3(path, fields, cover_bytes, cover_mime, overwrite)
    else:
        _write_generic(path, fields, cover_bytes, cover_mime, overwrite)
    return read_audio_tags(path)


def _write_generic(
    path: str,
    fields: dict,
    cover_bytes: Optional[bytes],
    cover_mime: str,
    overwrite: bool,
) -> None:
    try:
        audio = mutagen.File(path, easy=True)
    except Exception as exc:
        logger.warning("[audio_tags] cannot open %s for writing: %s", path, exc)
        return
    if audio is None:
        logger.warning("[audio_tags] unsupported format for writing: %s", path)
        return

    mapping = {
        "title": "title",
        "artist": "artist",
        "album": "album",
        "album_artist": "albumartist",
        "date": "date",
        "genre": "genre",
        "track_number": "tracknumber",
        "disc_number": "discnumber",
    }
    for name, key in mapping.items():
        value = _clean(fields.get(name))
        if not value:
            continue
        if not overwrite and _clean(audio.get(key)):
            continue
        audio[key] = value
    audio.save()
    if cover_bytes:
        _embed_cover_generic(path, cover_bytes, cover_mime, overwrite)


def _embed_cover_generic(
    path: str, cover_bytes: bytes, cover_mime: str, overwrite: bool
) -> None:
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".flac":
            from mutagen.flac import FLAC, Picture

            audio = FLAC(path)
            if audio.pictures and not overwrite:
                return
            audio.clear_pictures()
            picture = Picture()
            picture.type = 3
            picture.mime = cover_mime or "image/jpeg"
            picture.desc = "Cover"
            picture.data = cover_bytes
            audio.add_picture(picture)
            audio.save()
    except Exception as exc:
        logger.warning("[audio_tags] cannot embed cover into %s: %s", path, exc)


def verify_audio_tags(path: str, require: tuple[str, ...] = ("title", "artist")) -> tuple[bool, list[str]]:
    tags = read_audio_tags(path)
    data = tags.as_metadata()
    missing = [name for name in require if not data.get(name)]
    return (not missing, missing)


def fetch_cover(url: str, timeout: int = 12) -> Optional[tuple[bytes, str]]:
    if not url:
        return None
    try:
        import requests

        resp = requests.get(url, timeout=timeout)
        if resp.status_code == 200 and resp.content:
            mime = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
            return resp.content, mime or "image/jpeg"
    except Exception as exc:
        logger.debug("[audio_tags] cover fetch failed %s: %s", url, exc)
    return None


def _tokens(value: str) -> set:
    return {token for token in re.sub(r"[^\w]+", " ", str(value or "").lower()).split() if token}


_ARTIST_STOPWORDS = {"the", "a", "an", "and", "or", "of", "feat", "ft", "featuring", "vs", "x"}


def _title_matches(expected: str, candidate: str) -> bool:
    """Считает название совпавшим, если токены одного множества вложены в другое."""
    expected_tokens = _tokens(expected)
    candidate_tokens = _tokens(candidate)
    if not expected_tokens or not candidate_tokens:
        return False
    return expected_tokens <= candidate_tokens or candidate_tokens <= expected_tokens


def _artist_matches(expected: str, candidate: str) -> bool:
    """Исполнители совпадают при равенстве множеств токенов или вложенности.

    Пересечение только по служебным словам (например, "the") совпадением не
    считается, чтобы "The xx" не совпал с "The Weeknd".
    """
    expected_tokens = _tokens(expected)
    candidate_tokens = _tokens(candidate)
    if not expected_tokens or not candidate_tokens:
        return False
    if expected_tokens == candidate_tokens:
        return True
    if expected_tokens <= candidate_tokens or candidate_tokens <= expected_tokens:
        smaller = expected_tokens if expected_tokens <= candidate_tokens else candidate_tokens
        return bool(smaller - _ARTIST_STOPWORDS)
    return False


def cover_from_itunes(title: str, artist: str, timeout: int = 12) -> Optional[tuple[bytes, str]]:
    """Резервный источник обложки, когда Spotify CDN недоступен.

    Берём результат только при совпадении названия и исполнителя, иначе можно
    встроить обложку другого трека (каверы, одноимённые песни).
    """
    query = " ".join(part for part in (artist, title) if part).strip()
    if not query:
        return None
    try:
        import requests

        resp = requests.get(
            "https://itunes.apple.com/search",
            params={"term": query, "entity": "song", "limit": 5},
            timeout=timeout,
        )
        if resp.status_code != 200:
            return None
        results = resp.json().get("results") or []
        for result in results:
            if not _title_matches(title, result.get("trackName")):
                continue
            if artist and not _artist_matches(artist, result.get("artistName")):
                continue
            artwork = result.get("artworkUrl100") or ""
            if not artwork:
                continue
            artwork = artwork.replace("100x100bb", "600x600bb")
            fetched = fetch_cover(artwork, timeout=timeout)
            if fetched:
                return fetched
        logger.debug("[audio_tags] iTunes cover: no confident match for %r", query)
        return None
    except Exception as exc:
        logger.debug("[audio_tags] iTunes cover lookup failed for %r: %s", query, exc)
        return None
