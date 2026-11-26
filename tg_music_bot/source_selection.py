"""Recording identity checks, independent of downloaders and network APIs.

Metadata is evidence, not an acoustic proof: an unlabelled replacement of audio
at the provider cannot be detected here. Explicit status is a ranking preference, never a mandatory eligibility gate.
"""
from dataclasses import dataclass
from difflib import SequenceMatcher
import math
import re
import unicodedata
from urllib.parse import urlparse

POLICY_VERSION = 1

_VERSIONS = {
    'live': r'\b(?:live|concert|концерт\w*|живое исполнение|живой звук)\b',
    'sped_up': r'\b(?:sped\s*up|speed\s*up|speedup|nightcore|ускоренн\w*|ускорен\w*)\b',
    'slowed': r'\b(?:slowed|slow\s*down|замедлен\w*)\b',
    'remix': r'\b(?:remix|ремикс|bootleg|mashup)\b',
    'cover': r'\b(?:cover|кавер|karaoke|караоке|tribute)\b',
    'instrumental': r'\b(?:instrumental|инструментал\w*|minus|минусовка|без\s+(?:голоса|вокала)|without\s+vocals|на\s+гитаре|guitar\s+(?:version|instrumental))\b',
    'acoustic': r'\b(?:acoustic|unplugged|акустик\w*)\b',
    'edit': r'\b(?:radio\s+edit|radio\s+version|радиоверсия|short\s+version)\b',
    'remaster': r'\b(?:remaster\w*|ремастер\w*)\b',
    'reverb': r'\b(?:reverb|реверб\w*|8d\s+audio|bass\s+boost\w*)\b',
}
_CLEAN = re.compile(r'\b(?:clean(?:\s+(?:version|edit))?|censored|цензур\w*|без\s+мата)\b')
_UNCENSORED = re.compile(r'\b(?:uncensored|explicit|без\s+цензуры|нецензур\w*)\b')
_PRESENTATION = re.compile(r'\b(?:official\s+(?:audio|video|music\s+video|lyric\s+video)|lyrics?|audio|hd|hq|4k|explicit|uncensored)\b')
_REMASTER_SUFFIX = re.compile(
    r'\s*(?:[-–—]\s*|[([]\s*)(?:(?:19|20)\d{2}\s+)?'
    r'(?:remaster(?:ed)?|ремастер)(?:\s+(?:version|(?:19|20)\d{2})){0,2}\s*[)\]]?\s*$',
    re.I,
)


def without_remaster(title: str) -> str:
    return _REMASTER_SUFFIX.sub('', title)


def normalized(value: str) -> str:
    value = unicodedata.normalize('NFKC', str(value or '')).casefold().replace('ё', 'е')
    return re.sub(r'[^\w]+', ' ', value).strip()


def versions(title: str) -> frozenset[str]:
    text = normalized(title)
    return frozenset(key for key, pattern in _VERSIONS.items() if re.search(pattern, text))


def is_clean(title: str) -> bool:
    # «без цензуры» must not trigger the censored marker.
    return bool(_CLEAN.search(_UNCENSORED.sub('', normalized(title))))


def version_rejection(expected: str, actual: str) -> str | None:
    if without_remaster(expected) != expected:
        expected, actual = without_remaster(expected), without_remaster(actual)
    # Remove the literal requested title first: e.g. Live Forever / Clean are
    # song names, not versions. Parenthesized or appended markers remain.
    wanted, found = normalized(expected), normalized(actual)
    extras = found.replace(wanted, '', 1) if wanted and wanted in found else found
    if is_clean(extras):
        return 'Цензурная / clean-версия'
    unexpected = versions(extras) if wanted and wanted in found else versions(extras) - versions(expected)
    if unexpected:
        return 'Другая версия записи: ' + ', '.join(sorted(unexpected))
    return None


def duration_matches(expected: float, actual: float) -> bool:
    try:
        expected, actual = float(expected), float(actual)
    except (ValueError, TypeError):
        return False
    return (math.isfinite(expected) and math.isfinite(actual)
            and expected > 0 and actual > 0
            and abs(expected - actual) <= max(2.0, min(5.0, expected * .02)))


@dataclass(frozen=True)
class Candidate:
    video_id: str
    title: str
    artists: tuple[str, ...]
    duration: float
    album: str = ''
    explicit: bool | None = None
    provider: str = 'youtube'
    source_url: str = ''
    verified_publisher: bool = False

    @property
    def url(self):
        return self.source_url if self.provider in ('soundcloud', 'vk') else f'https://www.youtube.com/watch?v={self.video_id}'


def credited_title(title: str, artists) -> str:
    """Strip guest-credit parentheses only when every name is a known credit."""
    known = {normalized(a) for a in artists}
    def strip(match):
        names = re.split(r'\s*(?:,|&|\band\b)\s*', match.group(1), flags=re.I)
        return '' if names and all(normalized(name) in known for name in names) else match.group(0)
    return re.sub(r'\((?:with|feat\.?|ft\.?)\s+([^()]*)\)', strip, title, flags=re.I).strip()


def assess(song: dict, candidate: Candidate) -> tuple[float, str | None]:
    """Hard identity gates precede ranking; popularity never overrides them."""
    valid_id = bool(re.fullmatch(r'[\w-]{11}', candidate.video_id, flags=re.ASCII))
    if candidate.provider == 'soundcloud':
        parsed = urlparse(candidate.source_url)
        valid_id = (candidate.video_id.isascii() and candidate.video_id.isdigit()
                    and parsed.scheme == 'https' and parsed.hostname == 'soundcloud.com'
                    and not parsed.username and len(parsed.path.strip('/').split('/')) == 2)
    elif candidate.provider == 'vk':
        valid_id = (bool(re.fullmatch(r'-?[0-9]+_[0-9]+', candidate.video_id))
                    and candidate.source_url == f'https://vk.ru/audio{candidate.video_id}')
    elif candidate.provider != 'youtube':
        valid_id = False
    if not valid_id:
        return 0, 'Некорректный идентификатор аудио'
    expected_title = song.get('name') or ''
    if not expected_title or not song.get('artists'):
        return 0, 'Нет исходных метаданных для проверки'
    expected_artists = {normalized(a) for a in song['artists'] if a}
    actual_artists = {normalized(a) for a in candidate.artists if a}
    if not expected_artists:
        return 0, 'Не совпадают исполнители'
    partial_credits = not expected_artists <= actual_artists
    if partial_credits and not (
        candidate.provider == 'soundcloud' and candidate.verified_publisher
        and song.get('require_audio_match') and actual_artists == {normalized(song['artists'][0])}
        and normalized(candidate.title) == normalized(credited_title(expected_title, song['artists']))
    ):
        return 0, 'Не совпадают исполнители'
    reason = version_rejection(expected_title, candidate.title)
    if reason:
        return 0, reason
    # Explicitly requested variants must not silently become the studio version.
    expected_base = without_remaster(expected_title)
    actual_base = without_remaster(candidate.title) if expected_base != expected_title else candidate.title
    if versions(expected_base) != versions(actual_base):
        return 0, 'Не совпадает версия исходного трека'
    if not duration_matches(song.get('duration'), candidate.duration):
        return 0, 'Не совпадает длительность записи'
    wanted = normalized(credited_title(expected_title, song["artists"]))
    found = normalized(credited_title(candidate.title, song["artists"]))
    if wanted != found:
        wanted = ' '.join(_PRESENTATION.sub('', _UNCENSORED.sub('', wanted)).split())
        found = ' '.join(_PRESENTATION.sub('', _UNCENSORED.sub('', found)).split())
    title_score = SequenceMatcher(None, wanted, found).ratio()
    album_match = bool(candidate.album) and normalized(song.get('album_name')) == normalized(candidate.album)
    if expected_base != expected_title and wanted != found:
        # Require the same album and song when the provider labels the mastering differently.
        if (not album_match or normalized(credited_title(expected_base, song['artists']))
                != normalized(credited_title(actual_base, song['artists']))):
            return 0, 'Не подтверждена версия ремастера'
        return .8 + .05 * (candidate.explicit is True), None
    if title_score < .94:
        return 0, 'Не совпадает название записи'
    return title_score + .1 * album_match + .05 * (candidate.explicit is True) - .2 * partial_credits, None


def rank_candidates(song: dict, candidates: list[Candidate]) -> tuple[list[Candidate], list[str]]:
    accepted, rejected, seen = [], [], set()
    for c in candidates:
        identity = (c.provider, c.video_id)
        if identity in seen:
            continue
        seen.add(identity)
        score, reason = assess(song, c)
        if reason:
            rejected.append(reason)
        else:
            accepted.append((score, c))
    accepted.sort(key=lambda item: (-item[0], item[1].video_id))
    return [c for _, c in accepted], list(dict.fromkeys(rejected))
