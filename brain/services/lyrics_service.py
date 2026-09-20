"""Lyrics resolution: embedded/LRCLIB/syncedlyrics sources (line-level LRC)."""
import re
from typing import Optional

import requests

import db
from lyrics_normalizer import (
    is_synced_lrc,
    parse_reference_lrc,
    inspect_reference_anchors,
)

_LIRC_META_PATTERN = re.compile(r'^\[(ar|ti|al|by|offset|length|re|ve):', re.IGNORECASE)
_LIRC_TIME_PATTERN = re.compile(r'\[\d{2}:\d{2}\.\d{2,3}\]')
_LEGACY_WORD_TIME_PATTERN = re.compile(r'<\d{2,}:\d{2}(?:[.:]\d{2,3})?>')


def _empty_lyrics_response(lyrics_source, lyrics_status, lyrics_language):
    return {
        "lyrics": None,
        "syncedLyrics": None,
        "plainLyrics": None,
        "isSynced": False,
        "lyricsSource": lyrics_source,
        "lyricsStatus": lyrics_status or "empty",
        "lyricsLanguage": lyrics_language,
        "referenceSource": lyrics_source,
        "reference_source": lyrics_source,
        "hasLineAnchors": False,
        "has_line_anchors": False,
        "anchoredLinesCount": 0,
        "anchored_lines_count": 0,
        "totalLinesCount": 0,
        "total_lines_count": 0,
        "anchorCoverage": 0.0,
        "anchor_coverage": 0.0,
    }


def get_track_lyrics_payload(track_id: str, force: bool = False):
    """Fetches lyrics from DB. If empty (or forced), queries LRCLIB/syncedlyrics."""
    db_track = db.get_track(track_id)
    if not db_track:
        return None

    title = db_track.get('title') or ''
    artist = db_track.get('artist') or ''
    lyrics_content = None if force else db_track.get('lyrics')
    lyrics_source = None if force else db_track.get('lyrics_source')
    lyrics_status = None if force else db_track.get('lyrics_status')
    lyrics_language = None if force else db_track.get('lyrics_language')
    reference_search_status = None if force else db_track.get('reference_search_status')

    has_synced_in_db = bool(lyrics_content and is_synced_lrc(lyrics_content))

    # Search LRCLIB only if forced OR if no synced LRC and search was never executed before
    should_search_external = bool(
        force
        or (
            not has_synced_in_db
            and reference_search_status is None
            and (lyrics_status != 'failed' or force)
        )
    )

    if should_search_external and (title or artist):
        try:
            res = requests.get(
                "https://lrclib.net/api/search",
                params={"track_name": title, "artist_name": artist},
                timeout=5
            )
            if res.status_code == 200:
                results = res.json()
                found_synced = None
                if results and isinstance(results, list) and len(results) > 0:
                    for r in results:
                        synced = r.get("syncedLyrics")
                        if synced and is_synced_lrc(synced):
                            found_synced = synced
                            break
                if found_synced:
                    # Atomic upgrade to lrclib_synced_lrc
                    lyrics_content = found_synced
                    lyrics_source = "lrclib_synced_lrc"
                    lyrics_status = "line_synced"
                    has_synced_in_db = True
                    db.set_track_synced_reference(
                        track_id,
                        found_synced,
                        lyrics_source="lrclib_synced_lrc",
                        lyrics_status="line_synced",
                        reference_search_status="found",
                    )
                elif not lyrics_content:
                    plain = results[0].get("plainLyrics") if (results and isinstance(results, list) and len(results) > 0) else None
                    if plain:
                        lyrics_content = plain
                        lyrics_source = "lrclib_plain"
                        lyrics_status = "plain"
                        db.update_track_lyrics_data(
                            track_id,
                            lyrics=plain,
                            lyrics_source="lrclib_plain",
                            lyrics_status="plain",
                            reference_search_status="found",
                        )
                    else:
                        db.update_track_lyrics_data(track_id, reference_search_status="not_found")
                else:
                    # Had embedded plain, but LRCLIB had no synced LRC
                    db.set_track_reference_search_status(track_id, "not_found")
        except Exception as e:
            print("LRCLIB fetch error:", e)

        # 2. Fallback to syncedlyrics library if still no synced lyrics found
        if not has_synced_in_db and (not lyrics_content or force) and (title or artist):
            try:
                import syncedlyrics
                search_query = f"{title} {artist}".strip()
                found = syncedlyrics.search(search_query, synced_only=False)
                if found:
                    is_found_synced = is_synced_lrc(found)
                    if is_found_synced:
                        lyrics_content = found
                        lyrics_source = "lrclib_synced_lrc"
                        lyrics_status = "line_synced"
                        has_synced_in_db = True
                        db.set_track_synced_reference(
                            track_id,
                            found,
                            lyrics_source="lrclib_synced_lrc",
                            lyrics_status="line_synced",
                            reference_search_status="found",
                        )
                    elif not lyrics_content:
                        lyrics_content = found
                        lyrics_source = "lrclib_plain"
                        lyrics_status = "plain"
                        db.update_track_lyrics_data(
                            track_id,
                            lyrics=found,
                            lyrics_source="lrclib_plain",
                            lyrics_status="plain",
                            reference_search_status="found",
                        )
            except Exception as e:
                print("syncedlyrics fallback error:", e)

        if not lyrics_content:
            # Mark as failed to avoid repeating failed searches on every GET
            db.update_track_lyrics_data(track_id, lyrics_status='failed', reference_search_status='not_found')
            lyrics_status = 'failed'

    if not lyrics_source and lyrics_content:
        lyrics_source = "embedded_synced_lrc" if is_synced_lrc(lyrics_content) else "embedded_plain"

    if not lyrics_content:
        return _empty_lyrics_response(lyrics_source, lyrics_status, lyrics_language)

    is_synced = is_synced_lrc(lyrics_content)
    ref_lines = parse_reference_lrc(lyrics_content)
    anchors_info = inspect_reference_anchors(ref_lines)

    if is_synced and anchors_info["has_line_anchors"]:
        clean_lines = []
        for line in lyrics_content.split('\n'):
            stripped = line.strip()
            if _LIRC_META_PATTERN.match(stripped):
                continue
            cleaned = _LEGACY_WORD_TIME_PATTERN.sub('', _LIRC_TIME_PATTERN.sub('', stripped))
            cleaned = re.sub(r'\s+', ' ', cleaned).strip()
            clean_lines.append(cleaned)
        plain_lyrics = '\n'.join(clean_lines).strip()

        status_val = lyrics_status or "line_synced"
        if anchors_info["coverage"] < 0.80 and status_val != "partial_anchor":
            status_val = "partial_anchor"

        return {
            "lyrics": lyrics_content,
            "syncedLyrics": lyrics_content,
            "plainLyrics": plain_lyrics,
            "isSynced": True,
            "lyricsSource": lyrics_source,
            "lyricsStatus": status_val,
            "lyricsLanguage": lyrics_language,
            "referenceSource": lyrics_source,
            "reference_source": lyrics_source,
            "hasLineAnchors": anchors_info["has_line_anchors"],
            "has_line_anchors": anchors_info["has_line_anchors"],
            "anchoredLinesCount": anchors_info["anchored_lines"],
            "anchored_lines_count": anchors_info["anchored_lines"],
            "totalLinesCount": anchors_info["total_lines"],
            "total_lines_count": anchors_info["total_lines"],
            "anchorCoverage": anchors_info["coverage"],
            "anchor_coverage": anchors_info["coverage"],
        }
    else:
        # Strictly plain lyrics. hasLineAnchors: False
        plain_text_lines = [l for l in lyrics_content.splitlines() if l.strip()]
        total_plain_lines = len(plain_text_lines)
        return {
            "lyrics": lyrics_content,
            "syncedLyrics": None,
            "plainLyrics": lyrics_content,
            "isSynced": False,
            "lyricsSource": lyrics_source or "embedded_plain",
            "lyricsStatus": "plain",
            "lyricsLanguage": lyrics_language,
            "referenceSource": lyrics_source or "embedded_plain",
            "reference_source": lyrics_source or "embedded_plain",
            "hasLineAnchors": False,
            "has_line_anchors": False,
            "anchoredLinesCount": 0,
            "anchored_lines_count": 0,
            "totalLinesCount": total_plain_lines,
            "total_lines_count": total_plain_lines,
            "anchorCoverage": 0.0,
            "anchor_coverage": 0.0,
        }
