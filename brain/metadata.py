"""
Puuk Audio Metadata Engine
Handles multi-format reading, sanitization, mutation, and safe replacement
for MP3 (ID3v2.3/v2.4), FLAC, MP4/M4A, and OGG/Opus audio files.
"""

import io
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from typing import Optional, Tuple, Set
from PIL import Image

import mutagen
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TPE2, TDRC, TYER, TCON, TRCK, TPOS, COMM, USLT, APIC
from mutagen.mp3 import MP3
from mutagen.flac import FLAC, Picture
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggvorbis import OggVorbis
from mutagen.oggopus import OggOpus


# Safety limits
MAX_COVER_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_IMAGE_DIMENSION = 2000
Image.MAX_IMAGE_PIXELS = 10_000_000  # Protect against decompression bombs


@dataclass
class AudioMetadata:
    title: str = ""
    artist: str = ""
    album: str = ""
    album_artist: Optional[str] = None
    year: Optional[str] = None
    genre: Optional[str] = None
    track_number: Optional[str] = None
    disc_number: Optional[str] = None
    comment: Optional[str] = None
    lyrics: Optional[str] = None
    duration: float = 0.0
    bitrate: Optional[int] = None
    sample_rate: Optional[int] = None
    channels: Optional[int] = None
    format: str = ""
    file_size: int = 0
    file_mtime_ns: int = 0
    has_cover: bool = False
    cover_mime: Optional[str] = None


@dataclass
class MetadataPatch:
    fields_set: Set[str] = field(default_factory=set)
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    album_artist: Optional[str] = None
    year: Optional[str] = None
    genre: Optional[str] = None
    track_number: Optional[str] = None
    disc_number: Optional[str] = None
    comment: Optional[str] = None
    lyrics: Optional[str] = None
    cover_action: str = "keep"  # "keep" | "replace" | "remove"
    cover_bytes: Optional[bytes] = None
    cover_mime: Optional[str] = None


def clean_cover_bytes(raw_bytes: bytes) -> Tuple[bytes, str]:
    """
    Validates, strips EXIF, resizes (max 2000x2000), and re-encodes cover image.
    Returns (cleaned_bytes, mime_type).
    """
    if len(raw_bytes) > MAX_COVER_SIZE_BYTES:
        raise ValueError(f"Cover image exceeds maximum allowed size of {MAX_COVER_SIZE_BYTES // (1024*1024)}MB")

    try:
        img = Image.open(io.BytesIO(raw_bytes))
        img.verify()
    except Exception as e:
        raise ValueError(f"Invalid image format: {e}")

    # Re-open after verify()
    img = Image.open(io.BytesIO(raw_bytes))
    orig_format = (img.format or "").upper()
    if orig_format not in ("JPEG", "JPG", "PNG", "WEBP"):
        raise ValueError(f"Unsupported image format: {orig_format}. Only JPEG, PNG, and WebP are allowed.")

    # Downscale if dimensions exceed MAX_IMAGE_DIMENSION
    width, height = img.size
    if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
        img.thumbnail((MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION), Image.Resampling.LANCZOS)

    out_io = io.BytesIO()
    if orig_format == "PNG" or img.mode in ("RGBA", "LA", "P"):
        clean_img = img.convert("RGBA") if img.mode == "RGBA" else img.convert("RGB")
        if clean_img.mode == "RGBA":
            clean_img.save(out_io, format="PNG", optimize=True)
            return out_io.getvalue(), "image/png"
        else:
            clean_img.save(out_io, format="JPEG", quality=90, optimize=True)
            return out_io.getvalue(), "image/jpeg"
    else:
        clean_img = img.convert("RGB")
        clean_img.save(out_io, format="JPEG", quality=90, optimize=True)
        return out_io.getvalue(), "image/jpeg"


def build_mp3_apic(cover_bytes: bytes, mime: str) -> APIC:
    return APIC(
        encoding=3,
        mime=mime,
        type=3,  # Front cover
        desc="Cover",
        data=cover_bytes
    )


def build_flac_picture(cover_bytes: bytes, mime: str) -> Picture:
    pic = Picture()
    pic.type = 3  # Front cover
    pic.mime = mime
    pic.desc = "Cover"
    pic.data = cover_bytes
    return pic


def build_mp4_cover(cover_bytes: bytes, mime: str) -> MP4Cover:
    fmt = MP4Cover.FORMAT_PNG if mime == "image/png" else MP4Cover.FORMAT_JPEG
    return MP4Cover(cover_bytes, imageformat=fmt)


def _parse_num_total(val: Optional[str]) -> Tuple[int, int]:
    """Parses '3/12' or '3' into (3, 12) or (3, 0)."""
    if not val:
        return 0, 0
    parts = str(val).split("/", 1)
    try:
        num = int(parts[0].strip())
    except (ValueError, IndexError):
        num = 0
    total = 0
    if len(parts) > 1:
        try:
            total = int(parts[1].strip())
        except ValueError:
            total = 0
    return num, total


def read_mp3_metadata(file_path: str) -> AudioMetadata:
    meta = AudioMetadata()
    stat = os.stat(file_path)
    meta.file_size = stat.st_size
    meta.file_mtime_ns = stat.st_mtime_ns
    meta.format = "mp3"

    try:
        mp3 = MP3(file_path)
        if mp3.info:
            meta.duration = float(mp3.info.length or 0.0)
            meta.bitrate = getattr(mp3.info, "bitrate", None)
            meta.sample_rate = getattr(mp3.info, "sample_rate", None)
            meta.channels = getattr(mp3.info, "channels", None)

        tags = mp3.tags
        if tags:
            # Title
            if "TIT2" in tags:
                meta.title = str(tags["TIT2"].text[0])
            # Artist
            if "TPE1" in tags:
                meta.artist = str(tags["TPE1"].text[0])
            # Album
            if "TALB" in tags:
                meta.album = str(tags["TALB"].text[0])
            # Album Artist
            if "TPE2" in tags:
                meta.album_artist = str(tags["TPE2"].text[0])
            # Year
            if "TDRC" in tags:
                meta.year = str(tags["TDRC"].text[0])
            elif "TYER" in tags:
                meta.year = str(tags["TYER"].text[0])
            # Genre (мультижанровые значения сохраняются как есть, "A; B")
            if "TCON" in tags:
                genre_values = [str(v).strip() for v in tags["TCON"].text]
                genre_values = [v for v in genre_values if v]
                if genre_values:
                    meta.genre = "; ".join(genre_values)
            # Track Number
            if "TRCK" in tags:
                meta.track_number = str(tags["TRCK"].text[0])
            # Disc Number
            if "TPOS" in tags:
                meta.disc_number = str(tags["TPOS"].text[0])
            # Lyrics
            for key, tag in tags.items():
                if isinstance(tag, USLT):
                    meta.lyrics = str(tag.text)
                    break
            # Comment
            for key, tag in tags.items():
                if isinstance(tag, COMM):
                    meta.comment = str(tag.text[0])
                    break
            # Cover Art
            for key, tag in tags.items():
                if isinstance(tag, APIC):
                    meta.has_cover = True
                    meta.cover_mime = tag.mime or "image/jpeg"
                    break
    except Exception as e:
        print(f"[metadata] Warning reading MP3 {file_path}: {e}")

    if not meta.title:
        base = os.path.splitext(os.path.basename(file_path))[0]
        meta.title = base

    return meta


def read_flac_metadata(file_path: str) -> AudioMetadata:
    meta = AudioMetadata()
    stat = os.stat(file_path)
    meta.file_size = stat.st_size
    meta.file_mtime_ns = stat.st_mtime_ns
    meta.format = "flac"

    try:
        flac = FLAC(file_path)
        if flac.info:
            meta.duration = float(flac.info.length or 0.0)
            meta.sample_rate = getattr(flac.info, "sample_rate", None)
            meta.channels = getattr(flac.info, "channels", None)
            meta.bitrate = getattr(flac.info, "bitrate", None)
            if not meta.bitrate and meta.duration > 0:
                meta.bitrate = int((meta.file_size * 8) / meta.duration)

        tags = flac.tags or {}
        def _first(key: str) -> Optional[str]:
            vals = tags.get(key) or tags.get(key.lower()) or tags.get(key.upper())
            return str(vals[0]) if vals else None

        def _joined(key: str) -> Optional[str]:
            vals = tags.get(key) or tags.get(key.lower()) or tags.get(key.upper())
            cleaned = [str(v).strip() for v in (vals or [])]
            cleaned = [v for v in cleaned if v]
            return "; ".join(cleaned) if cleaned else None

        meta.title = _first("TITLE") or os.path.splitext(os.path.basename(file_path))[0]
        meta.artist = _first("ARTIST") or ""
        meta.album = _first("ALBUM") or ""
        meta.album_artist = _first("ALBUMARTIST") or _first("ALBUM ARTIST")
        meta.year = _first("DATE") or _first("YEAR")
        meta.genre = _joined("GENRE")
        meta.track_number = _first("TRACKNUMBER") or _first("TRACK")
        meta.disc_number = _first("DISCNUMBER") or _first("DISC")
        meta.comment = _first("COMMENT") or _first("DESCRIPTION")
        meta.lyrics = _first("LYRICS") or _first("UNSYNCEDLYRICS")

        if flac.pictures:
            meta.has_cover = True
            meta.cover_mime = flac.pictures[0].mime or "image/jpeg"
    except Exception as e:
        print(f"[metadata] Warning reading FLAC {file_path}: {e}")
        if not meta.title:
            meta.title = os.path.splitext(os.path.basename(file_path))[0]

    return meta


def read_mp4_metadata(file_path: str) -> AudioMetadata:
    meta = AudioMetadata()
    stat = os.stat(file_path)
    meta.file_size = stat.st_size
    meta.file_mtime_ns = stat.st_mtime_ns
    meta.format = "m4a"

    try:
        mp4 = MP4(file_path)
        if mp4.info:
            meta.duration = float(mp4.info.length or 0.0)
            meta.bitrate = getattr(mp4.info, "bitrate", None)
            meta.sample_rate = getattr(mp4.info, "sample_rate", None)
            meta.channels = getattr(mp4.info, "channels", None)

        tags = mp4.tags or {}
        def _str_atom(key: str) -> Optional[str]:
            val = tags.get(key)
            if val and len(val) > 0:
                return str(val[0])
            return None

        meta.title = _str_atom("\xa9nam") or os.path.splitext(os.path.basename(file_path))[0]
        meta.artist = _str_atom("\xa9ART") or ""
        meta.album = _str_atom("\xa9alb") or ""
        meta.album_artist = _str_atom("aART")
        meta.year = _str_atom("\xa9day")
        meta.genre = _str_atom("\xa9gen")
        meta.comment = _str_atom("\xa9cmt")
        meta.lyrics = _str_atom("\xa9lyr")

        if "trkn" in tags and tags["trkn"]:
            t_num, t_tot = tags["trkn"][0]
            meta.track_number = f"{t_num}/{t_tot}" if t_tot else str(t_num)

        if "disk" in tags and tags["disk"]:
            d_num, d_tot = tags["disk"][0]
            meta.disc_number = f"{d_num}/{d_tot}" if d_tot else str(d_num)

        if "covr" in tags and tags["covr"]:
            meta.has_cover = True
            c = tags["covr"][0]
            meta.cover_mime = "image/png" if getattr(c, "imageformat", None) == MP4Cover.FORMAT_PNG else "image/jpeg"
    except Exception as e:
        print(f"[metadata] Warning reading MP4 {file_path}: {e}")
        if not meta.title:
            meta.title = os.path.splitext(os.path.basename(file_path))[0]

    return meta


def read_ogg_metadata(file_path: str) -> AudioMetadata:
    meta = AudioMetadata()
    stat = os.stat(file_path)
    meta.file_size = stat.st_size
    meta.file_mtime_ns = stat.st_mtime_ns
    ext = os.path.splitext(file_path)[1].lower().lstrip(".")
    meta.format = ext

    try:
        ogg = mutagen.File(file_path)
        if ogg and ogg.info:
            meta.duration = float(ogg.info.length or 0.0)
            meta.bitrate = getattr(ogg.info, "bitrate", None)
            meta.sample_rate = getattr(ogg.info, "sample_rate", None)
            meta.channels = getattr(ogg.info, "channels", None)

        if ogg and ogg.tags:
            tags = ogg.tags
            def _first(key: str) -> Optional[str]:
                vals = tags.get(key) or tags.get(key.lower()) or tags.get(key.upper())
                return str(vals[0]) if vals else None

            def _joined(key: str) -> Optional[str]:
                vals = tags.get(key) or tags.get(key.lower()) or tags.get(key.upper())
                cleaned = [str(v).strip() for v in (vals or [])]
                cleaned = [v for v in cleaned if v]
                return "; ".join(cleaned) if cleaned else None

            meta.title = _first("TITLE") or os.path.splitext(os.path.basename(file_path))[0]
            meta.artist = _first("ARTIST") or ""
            meta.album = _first("ALBUM") or ""
            meta.album_artist = _first("ALBUMARTIST") or _first("ALBUM ARTIST")
            meta.year = _first("DATE") or _first("YEAR")
            meta.genre = _joined("GENRE")
            meta.track_number = _first("TRACKNUMBER")
            meta.disc_number = _first("DISCNUMBER")
            meta.comment = _first("COMMENT")
            meta.lyrics = _first("LYRICS")
    except Exception as e:
        print(f"[metadata] Warning reading OGG/Opus {file_path}: {e}")

    if not meta.title:
        meta.title = os.path.splitext(os.path.basename(file_path))[0]

    return meta


def read_audio_metadata(file_path: str) -> AudioMetadata:
    """Universal reader dispatching by file extension and mutagen signatures."""
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".mp3":
        return read_mp3_metadata(file_path)
    elif ext == ".flac":
        return read_flac_metadata(file_path)
    elif ext in (".m4a", ".mp4", ".aac"):
        return read_mp4_metadata(file_path)
    elif ext in (".ogg", ".opus"):
        return read_ogg_metadata(file_path)
    else:
        # Fallback for WAV, AIFF, or unknown (read-only metadata)
        meta = AudioMetadata()
        stat = os.stat(file_path)
        meta.file_size = stat.st_size
        meta.file_mtime_ns = stat.st_mtime_ns
        meta.format = ext.lstrip(".")
        meta.title = os.path.splitext(os.path.basename(file_path))[0]
        try:
            m = mutagen.File(file_path)
            if m and m.info:
                meta.duration = float(m.info.length or 0.0)
                meta.bitrate = getattr(m.info, "bitrate", None)
                meta.sample_rate = getattr(m.info, "sample_rate", None)
                meta.channels = getattr(m.info, "channels", None)
        except Exception:
            pass
        return meta


# ----------------------------------------------------------------------
# Pure Mutators (operate strictly on temporary files)
# ----------------------------------------------------------------------

def mutate_mp3(temp_path: str, patch: MetadataPatch) -> None:
    try:
        tags = ID3(temp_path)
    except Exception:
        tags = ID3()

    fs = patch.fields_set

    if "title" in fs:
        tags.delall("TIT2")
        if patch.title:
            tags.add(TIT2(encoding=3, text=patch.title))

    if "artist" in fs:
        tags.delall("TPE1")
        if patch.artist:
            tags.add(TPE1(encoding=3, text=patch.artist))

    if "album" in fs:
        tags.delall("TALB")
        if patch.album:
            tags.add(TALB(encoding=3, text=patch.album))

    if "album_artist" in fs:
        tags.delall("TPE2")
        if patch.album_artist:
            tags.add(TPE2(encoding=3, text=patch.album_artist))

    if "year" in fs:
        tags.delall("TDRC")
        tags.delall("TYER")
        if patch.year:
            tags.add(TDRC(encoding=3, text=patch.year))

    if "genre" in fs:
        tags.delall("TCON")
        if patch.genre:
            tags.add(TCON(encoding=3, text=patch.genre))

    if "track_number" in fs:
        tags.delall("TRCK")
        if patch.track_number:
            tags.add(TRCK(encoding=3, text=patch.track_number))

    if "disc_number" in fs:
        tags.delall("TPOS")
        if patch.disc_number:
            tags.add(TPOS(encoding=3, text=patch.disc_number))

    if "comment" in fs:
        tags.delall("COMM")
        if patch.comment:
            tags.add(COMM(encoding=3, lang="eng", desc="", text=patch.comment))

    if "lyrics" in fs:
        tags.delall("USLT")
        if patch.lyrics:
            tags.add(USLT(encoding=3, lang="eng", desc="", text=patch.lyrics))

    # Cover action
    if patch.cover_action == "remove":
        tags.delall("APIC")
    elif patch.cover_action == "replace" and patch.cover_bytes:
        tags.delall("APIC")
        tags.add(build_mp3_apic(patch.cover_bytes, patch.cover_mime or "image/jpeg"))

    tags.save(temp_path, v2_version=3)


def mutate_flac(temp_path: str, patch: MetadataPatch) -> None:
    flac = FLAC(temp_path)
    if flac.tags is None:
        flac.add_tags()

    fs = patch.fields_set

    def _set_or_del(key: str, val: Optional[str]):
        if val:
            flac.tags[key] = val
        else:
            if key in flac.tags:
                del flac.tags[key]

    if "title" in fs:
        _set_or_del("TITLE", patch.title)
    if "artist" in fs:
        _set_or_del("ARTIST", patch.artist)
    if "album" in fs:
        _set_or_del("ALBUM", patch.album)
    if "album_artist" in fs:
        _set_or_del("ALBUMARTIST", patch.album_artist)
    if "year" in fs:
        _set_or_del("DATE", patch.year)
    if "genre" in fs:
        _set_or_del("GENRE", patch.genre)
    if "track_number" in fs:
        _set_or_del("TRACKNUMBER", patch.track_number)
    if "disc_number" in fs:
        _set_or_del("DISCNUMBER", patch.disc_number)
    if "comment" in fs:
        _set_or_del("COMMENT", patch.comment)
    if "lyrics" in fs:
        _set_or_del("LYRICS", patch.lyrics)

    if patch.cover_action == "remove":
        flac.clear_pictures()
    elif patch.cover_action == "replace" and patch.cover_bytes:
        flac.clear_pictures()
        flac.add_picture(build_flac_picture(patch.cover_bytes, patch.cover_mime or "image/jpeg"))

    flac.save()


def mutate_mp4(temp_path: str, patch: MetadataPatch) -> None:
    mp4 = MP4(temp_path)
    if mp4.tags is None:
        mp4.add_tags()

    fs = patch.fields_set

    def _set_or_del_atom(atom: str, val: Optional[str]):
        if val:
            mp4[atom] = [val]
        else:
            if atom in mp4:
                del mp4[atom]

    if "title" in fs:
        _set_or_del_atom("\xa9nam", patch.title)
    if "artist" in fs:
        _set_or_del_atom("\xa9ART", patch.artist)
    if "album" in fs:
        _set_or_del_atom("\xa9alb", patch.album)
    if "album_artist" in fs:
        _set_or_del_atom("aART", patch.album_artist)
    if "year" in fs:
        _set_or_del_atom("\xa9day", patch.year)
    if "genre" in fs:
        _set_or_del_atom("\xa9gen", patch.genre)
    if "comment" in fs:
        _set_or_del_atom("\xa9cmt", patch.comment)
    if "lyrics" in fs:
        _set_or_del_atom("\xa9lyr", patch.lyrics)

    if "track_number" in fs:
        if patch.track_number:
            num, total = _parse_num_total(patch.track_number)
            mp4["trkn"] = [(num, total)]
        elif "trkn" in mp4:
            del mp4["trkn"]

    if "disc_number" in fs:
        if patch.disc_number:
            num, total = _parse_num_total(patch.disc_number)
            mp4["disk"] = [(num, total)]
        elif "disk" in mp4:
            del mp4["disk"]

    if patch.cover_action == "remove":
        if "covr" in mp4:
            del mp4["covr"]
    elif patch.cover_action == "replace" and patch.cover_bytes:
        mp4["covr"] = [build_mp4_cover(patch.cover_bytes, patch.cover_mime or "image/jpeg")]

    mp4.save()


def mutate_ogg(temp_path: str, patch: MetadataPatch) -> None:
    ogg = mutagen.File(temp_path)
    if ogg is None or ogg.tags is None:
        raise ValueError("Could not read OGG/Opus tags for mutation")

    fs = patch.fields_set

    def _set_or_del(key: str, val: Optional[str]):
        if val:
            ogg.tags[key] = val
        else:
            if key in ogg.tags:
                del ogg.tags[key]

    if "title" in fs:
        _set_or_del("TITLE", patch.title)
    if "artist" in fs:
        _set_or_del("ARTIST", patch.artist)
    if "album" in fs:
        _set_or_del("ALBUM", patch.album)
    if "album_artist" in fs:
        _set_or_del("ALBUMARTIST", patch.album_artist)
    if "year" in fs:
        _set_or_del("DATE", patch.year)
    if "genre" in fs:
        _set_or_del("GENRE", patch.genre)
    if "track_number" in fs:
        _set_or_del("TRACKNUMBER", patch.track_number)
    if "disc_number" in fs:
        _set_or_del("DISCNUMBER", patch.disc_number)
    if "comment" in fs:
        _set_or_del("COMMENT", patch.comment)
    if "lyrics" in fs:
        _set_or_del("LYRICS", patch.lyrics)

    ogg.save()


def mutate_audio_file(temp_path: str, patch: MetadataPatch) -> None:
    """Dispatches mutation based on file extension."""
    ext = os.path.splitext(temp_path)[1].lower()
    if ext == ".mp3":
        mutate_mp3(temp_path, patch)
    elif ext == ".flac":
        mutate_flac(temp_path, patch)
    elif ext in (".m4a", ".mp4"):
        mutate_mp4(temp_path, patch)
    elif ext in (".ogg", ".opus"):
        mutate_ogg(temp_path, patch)
    else:
        raise ValueError(f"Direct ID3/tag mutation is unsupported for file format '{ext}'")


def verify_mutated_file(temp_path: str, patch: MetadataPatch) -> AudioMetadata:
    """
    Re-reads the temporary file and asserts requested mutations match.
    Raises RuntimeError if verification fails.
    """
    verified = read_audio_metadata(temp_path)
    fs = patch.fields_set

    if "title" in fs and patch.title:
        if verified.title != patch.title:
            raise RuntimeError(f"Verify failed: title '{verified.title}' != '{patch.title}'")

    if "artist" in fs and patch.artist:
        if verified.artist != patch.artist:
            raise RuntimeError(f"Verify failed: artist '{verified.artist}' != '{patch.artist}'")

    if "album" in fs and patch.album:
        if verified.album != patch.album:
            raise RuntimeError(f"Verify failed: album '{verified.album}' != '{patch.album}'")

    if patch.cover_action == "remove" and verified.has_cover:
        raise RuntimeError("Verify failed: cover was requested to be removed but is still present")

    if patch.cover_action == "replace" and not verified.has_cover:
        raise RuntimeError("Verify failed: cover was replaced but reader could not detect it")

    return verified


# ----------------------------------------------------------------------
# Path Security, Sidecar Locking, and Safe-Replace Protocol
# ----------------------------------------------------------------------

import fcntl
import threading
from collections import defaultdict
from contextlib import contextmanager

_process_locks = defaultdict(threading.Lock)
_process_lock_guard = threading.Lock()


def validate_safe_path(rel_path: str, music_dir: str) -> str:
    """
    Validates rel_path against Path Traversal.
    Strictly asserts os.path.commonpath((root, target)) == root.
    """
    if not rel_path or not rel_path.strip():
        raise ValueError("File path cannot be empty")

    # Disallow absolute paths or explicit relative traversal indicators
    if os.path.isabs(rel_path) or ".." in rel_path:
        raise PermissionError("Access denied: path traverses outside music directory")

    root = os.path.realpath(music_dir)
    target = os.path.realpath(os.path.join(root, rel_path.lstrip("/")))
    if os.path.commonpath((root, target)) != root:
        raise PermissionError("Access denied: path traverses outside music directory")

    return target


def _get_process_lock(track_id: str) -> threading.Lock:
    with _process_lock_guard:
        return _process_locks[track_id]


@contextmanager
def track_mutation_lock(track_id: str, music_dir: str):
    """
    Two-tier mutex:
    1. In-process threading.Lock per track_id.
    2. Sidecar file lock fcntl.flock on <music_dir>/.mutation_locks/<track_id>.lock
    """
    proc_lock = _get_process_lock(track_id)
    lock_dir = os.path.join(music_dir, ".mutation_locks")
    os.makedirs(lock_dir, exist_ok=True)
    lock_path = os.path.join(lock_dir, f"{track_id}.lock")

    with proc_lock:
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o666)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            yield
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)


def safe_replace_audio_file(abs_path: str, patch: MetadataPatch) -> AudioMetadata:
    """
    Safe-Write Protocol:
    1. Verify file exists and format is supported.
    2. Copy to temporary file in .tmp_mutations directory on same filesystem.
    3. Perform format-specific mutation.
    4. Verify mutated temporary file before replace.
    5. Flush and fsync temporary file.
    6. Atomic os.replace.
    7. Fsync parent directory.
    8. Post-replace read and return actual AudioMetadata.
    9. Clean up temporary file in finally block.
    """
    if not os.path.exists(abs_path):
        raise FileNotFoundError(f"Target audio file does not exist: {abs_path}")

    ext = os.path.splitext(abs_path)[1].lower()
    if ext not in (".mp3", ".flac", ".m4a", ".mp4", ".ogg", ".opus"):
        raise ValueError(f"Direct ID3 tag editing is unsupported for '{ext}' files")

    parent_dir = os.path.dirname(abs_path)
    temp_dir = os.path.join(parent_dir, ".tmp_mutations")
    os.makedirs(temp_dir, exist_ok=True)

    fd, temp_path = tempfile.mkstemp(dir=temp_dir, suffix=ext)
    os.close(fd)

    try:
        shutil.copy2(abs_path, temp_path)
        mutate_audio_file(temp_path, patch)
        verify_mutated_file(temp_path, patch)

        # fsync temporary file
        with open(temp_path, "rb") as f:
            os.fsync(f.fileno())

        # Atomic replace
        os.replace(temp_path, abs_path)

        # fsync parent directory
        try:
            dir_fd = os.open(parent_dir, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except Exception as e:
            print(f"[metadata] Warning: could not fsync parent directory: {e}")

        # Post-replace read
        actual_metadata = read_audio_metadata(abs_path)
        return actual_metadata

    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass

