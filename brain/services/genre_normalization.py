"""Нормализация жанров: алиасы семейств, разбивка составных строк, канонизация.

Чистый модуль без работы с БД и рекомендациями: только строковые преобразования.
"""
import re
from typing import Optional

# Разделители составных жанров в тегах: "Rock; Jazz", "Pop/Rock", "A, B".
_GENRE_SPLIT_RE = re.compile(r"[;/,]")

# Значения жанра, не несущие информации.
_EMPTY_GENRE_VALUES = {"", "unknown", "?"}

# Таблица алиасов: key (casefold) -> каноническое имя жанра.
_GENRE_ALIASES = {
    "hip hop": "Hip-Hop",
    "hip-hop": "Hip-Hop",
    "hiphop": "Hip-Hop",
    "rap": "Hip-Hop",
    "electronic": "Electronic",
    "electronica": "Electronic",
    "electronica music": "Electronic",
    "indie rock": "Indie Rock",
    "indie-rock": "Indie Rock",
    "alternative": "Alternative Rock",
    "alternative rock": "Alternative Rock",
    "alt rock": "Alternative Rock",
    "r&b": "R&B",
    "rnb": "R&B",
    "rhythm and blues": "R&B",
    "house": "House",
    "deep house": "House",
    "progressive house": "House",
}


def normalize_genre(raw_genre: Optional[str]) -> Optional[str]:
    """Канонизирует один жанр: алиасы семейств, trim, первая заглавная.

    Unknown/пустые значения дают None. Поджанры без явного алиаса
    не превращаются в другое семейство: только trim + капитализация.
    """
    if raw_genre is None:
        return None
    cleaned = " ".join(str(raw_genre).split())
    if not cleaned or cleaned.casefold() in _EMPTY_GENRE_VALUES:
        return None

    alias = _GENRE_ALIASES.get(cleaned.casefold())
    if alias:
        return alias

    # ALL CAPS усмиряем целиком ("JAZZ" -> "Jazz"), иначе только первая буква.
    if cleaned.isupper() and len(cleaned) > 1:
        return cleaned.capitalize()
    return cleaned[0].upper() + cleaned[1:]


def extract_genres(raw_genre: Optional[str]) -> list[str]:
    """Разбивает строку жанров по '/', ';', ',' и нормализует каждую часть.

    Результат уникальный и в порядке первого появления; один трек
    с несколькими жанрами попадает в несколько жанров.
    """
    if raw_genre is None:
        return []

    genres: list[str] = []
    seen: set[str] = set()
    for part in _GENRE_SPLIT_RE.split(str(raw_genre)):
        normalized = normalize_genre(part)
        if not normalized:
            continue
        key = normalized.casefold()
        if key in seen:
            continue
        seen.add(key)
        genres.append(normalized)
    return genres
