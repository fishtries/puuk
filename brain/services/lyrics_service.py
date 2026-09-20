"""Lyrics resolution: embedded/LRCLIB/syncedlyrics sources plus word-level (karaoke) alignment jobs."""
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import requests

import db
from services.external_catalogs import fetch_lrclib_by_track
from lyrics_normalizer import (
    is_synced_lrc,
    validate_synced_lrc,
    parse_reference_lrc,
    inspect_reference_anchors,
)
from whisper_anchor_backend import WhisperAnchorBackend

# GPU executor with single worker to serialize heavy inference jobs
gpu_lyrics_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="puuk_gpu_lyrics")

_LIRC_META_PATTERN = re.compile(r'^\[(ar|ti|al|by|offset|length|re|ve):', re.IGNORECASE)
_LIRC_TIME_PATTERN = re.compile(r'\[\d{2}:\d{2}\.\d{2,3}\]')
_WORD_TIME_PATTERN = re.compile(r'<\d{2,}:\d{2}(?:[.:]\d{2,3})?>')


def _empty_lyrics_response(lyrics_source, lyrics_status, lyrics_language):
    return {
        "lyrics": None,
        "syncedLyrics": None,
        "plainLyrics": None,
        "isSynced": False,
        "wordData": None,
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
    lyrics_word_data = None if force else db_track.get('lyrics_word_data')
    reference_search_status = None if force else db_track.get('reference_search_status')

    has_synced_in_db = bool(lyrics_content and is_synced_lrc(lyrics_content))

    # Point 6: Search LRCLIB only if forced OR if no synced LRC and search was never executed before
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
                    # Point 5: Atomic upgrade to lrclib_synced_lrc, clearing any old wordData
                    lyrics_content = found_synced
                    lyrics_source = "lrclib_synced_lrc"
                    lyrics_status = "line_synced"
                    has_synced_in_db = True
                    lyrics_word_data = None
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
                            clear_word_data=True,
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
                        lyrics_word_data = None
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
                            clear_word_data=True,
                        )
            except Exception as e:
                print("syncedlyrics fallback error:", e)

        if not lyrics_content:
            # Mark as failed to avoid repeating failed searches on every GET
            db.update_track_lyrics_data(track_id, lyrics_status='failed', reference_search_status='not_found')
            lyrics_status = 'failed'

    if not lyrics_source and lyrics_content:
        lyrics_source = "embedded_synced_lrc" if is_synced_lrc(lyrics_content) else "embedded_plain"

    word_data_dict = None
    if lyrics_word_data:
        try:
            word_data_dict = json.loads(lyrics_word_data)
        except Exception as e:
            print("JSON decode error for lyrics_word_data:", e)

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
            cleaned = _WORD_TIME_PATTERN.sub('', _LIRC_TIME_PATTERN.sub('', stripped))
            cleaned = re.sub(r'\s+', ' ', cleaned).strip()
            clean_lines.append(cleaned)
        plain_lyrics = '\n'.join(clean_lines).strip()

        status_val = lyrics_status or ("word_synced" if word_data_dict else "line_synced")
        if anchors_info["coverage"] < 0.80 and status_val != "draft_generated":
            status_val = "partial_anchor"

        return {
            "lyrics": lyrics_content,
            "syncedLyrics": lyrics_content,
            "plainLyrics": plain_lyrics,
            "isSynced": True,
            "wordData": word_data_dict,
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
        # Point 7: Strictly plain lyrics. wordData: None, lyricsStatus: plain, hasLineAnchors: False
        plain_text_lines = [l for l in lyrics_content.splitlines() if l.strip()]
        total_plain_lines = len(plain_text_lines)
        return {
            "lyrics": lyrics_content,
            "syncedLyrics": None,
            "plainLyrics": lyrics_content,
            "isSynced": False,
            "wordData": None,
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


def _has_cuda() -> bool:
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def queue_word_alignment(track_id: str, language: Optional[str], force: bool, refetch: bool):
    """
    Queues word-level lyrics alignment on the dedicated GPU executor.
    State survives server restarts in SQLite lyrics_jobs.
    Raises LookupError when track/audio is missing.
    """
    db_track = db.get_track(track_id)
    if not db_track:
        raise LookupError("Трек не найден в базе данных")

    if refetch:
        db.update_track_lyrics_data(
            track_id=track_id,
            lyrics="",
            lyrics_word_data="",
            lyrics_status=None,
            lyrics_source=None
        )

    from config import MUSIC_DIR
    from services.media_locations import locate_track_file_strict_candidates

    file_path = locate_track_file_strict_candidates(db_track.get("file_path"), track_id)

    if not file_path or not os.path.isfile(file_path):
        raise FileNotFoundError(f"Аудиофайл трека не найден на диске: {db_track.get('file_path')}")

    # Check existing job (unless forced)
    job = db.get_lyrics_job(track_id)
    if not force and job and job.get("status") in ("queued", "processing"):
        return {
            "status": job.get("status"),
            "stage": job.get("stage"),
            "message": f"Задача уже выполняется ({job.get('stage')})",
            "track_id": track_id,
        }

    stage_desc = "В очереди на пересоздание GPU (RTX 4070)" if force else "В очереди на обработку GPU (RTX 4070)"
    db.set_lyrics_job(track_id, status="queued", stage=stage_desc, progress=0, error=None)

    if _has_cuda():
        gpu_lyrics_executor.submit(process_word_lyrics_job, track_id, file_path, language)
    else:
        print(f"[WordAlignment] Job {track_id} queued for external GPU worker (RTX 4070)")

    return {
        "status": "queued",
        "stage": stage_desc,
        "message": "Задача добавлена в очередь на GPU (RTX 4070)",
        "track_id": track_id,
    }


def process_word_lyrics_job(track_id: str, audio_path: str, language: Optional[str] = None):
    """
    Background worker executed on single-worker ThreadPoolExecutor.
    Persists job status directly to SQLite lyrics_jobs table.
    """
    try:
        db.set_lyrics_job(track_id, status="processing", stage="Подготовка референтного текста...", progress=15)
        print(f"[WordAlignment] Starting job for track {track_id} on {audio_path}")

        db_track = db.get_track(track_id)
        lyrics_content = db_track.get('lyrics') if db_track else None
        lyrics_source = db_track.get('lyrics_source') if db_track else None
        lyrics_status = db_track.get('lyrics_status') if db_track else None

        has_synced_in_db = bool(lyrics_content and is_synced_lrc(lyrics_content))

        # Point 2: If no synced LRC in DB, query LRCLIB for true synced LRC even if plain lyrics exist!
        if not has_synced_in_db:
            title = db_track.get('title') if db_track else ''
            artist = db_track.get('artist') if db_track else ''
            try:
                res = requests.get(
                    "https://lrclib.net/api/search",
                    params={"track_name": title, "artist_name": artist},
                    timeout=5,
                )
                if res.status_code == 200:
                    results = res.json()
                    if results and isinstance(results, list) and len(results) > 0:
                        found_synced = None
                        for r in results:
                            synced = r.get("syncedLyrics")
                            if synced and is_synced_lrc(synced):
                                found_synced = synced
                                break
                        if found_synced:
                            # Point 5: Atomic update to lrclib_synced_lrc, clearing old wordData
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
                            plain = results[0].get("plainLyrics")
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
                                    clear_word_data=True,
                                )
                        else:
                            db.set_track_reference_search_status(track_id, "not_found")
            except Exception as ex:
                print(f"[WordAlignment] LRCLIB fetch warning: {ex}")

        # If lyrics_content came from ID3 tags and not yet tagged:
        if lyrics_content and not lyrics_source:
            lyrics_source = "embedded_synced_lrc" if is_synced_lrc(lyrics_content) else "embedded_plain"

        # If still no reference lyrics exist anywhere, generate draft via Whisper ASR
        if not lyrics_content:
            db.set_lyrics_job(track_id, status="processing", stage="Генерация чернового текста (Whisper ASR)...", progress=30)
            from word_lrc_generator import generate_word_level_lrc
            draft_lrc = generate_word_level_lrc(audio_path, language=language)
            if draft_lrc:
                lyrics_content = draft_lrc
                lyrics_source = "whisper_generated"
                # Mark as draft_generated
                db.update_track_lyrics(track_id, draft_lrc, lyrics_source="whisper_generated", lyrics_status="draft_generated")
            else:
                db.set_lyrics_job(track_id, status="failed", stage="Ошибка", progress=100, error="Не удалось обнаружить вокал или текст")
                return

        # Parse reference into immutable ReferenceLine objects
        ref_lines = parse_reference_lrc(lyrics_content)
        if not ref_lines:
            db.set_lyrics_job(track_id, status="failed", stage="Ошибка", progress=100, error="Референтный текст пуст")
            return

        # Point 1: Calculate actual anchors AFTER parse_reference_lrc
        anchors_info = inspect_reference_anchors(ref_lines)
        has_line_anchors = anchors_info["has_line_anchors"]
        anchored_lines_count = anchors_info["anchored_lines"]
        total_lines_count = anchors_info["total_lines"]
        anchor_coverage = anchors_info["coverage"]

        # Point 3:
        # coverage == 0 -> plain without word alignment!
        if anchor_coverage == 0.0:
            db.update_track_lyrics_data(
                track_id=track_id,
                lyrics_source=lyrics_source or "embedded_plain",
                lyrics_status="plain",
                clear_word_data=True,
            )
            db.set_lyrics_job(
                track_id,
                status="completed",
                stage="Готово (текст без таймингов, line fallback)",
                progress=100,
                error=None,
            )
            print(f"[WordAlignment] Track {track_id} has zero line anchors ({lyrics_source}). Saved as plain without word alignment.")
            return

        # Run alignment on anchored / partial reference
        db.set_lyrics_job(track_id, status="processing", stage="Синхронизация таймингов (WhisperAnchor)...", progress=45)
        backend = WhisperAnchorBackend()
        result = backend.align(audio_path, ref_lines, language=language)
        result.reference_source = lyrics_source or "lrclib_synced_lrc"
        result.has_line_anchors = has_line_anchors
        result.anchored_lines_count = anchored_lines_count
        result.total_lines_count = total_lines_count
        result.anchor_coverage = anchor_coverage
        result.stats["reference_source"] = result.reference_source
        result.stats["has_line_anchors"] = has_line_anchors
        result.stats["anchored_lines_count"] = anchored_lines_count
        result.stats["total_lines_count"] = total_lines_count
        result.stats["anchor_coverage"] = anchor_coverage

        # Serialize result JSON
        word_data_json = json.dumps(result.to_dict(), ensure_ascii=False)

        # Point 10: Distinct statuses
        if lyrics_source == "whisper_generated":
            new_status = "draft_generated"
        elif anchor_coverage < 0.80:
            new_status = "partial_anchor"
        else:
            new_status = "word_synced"

        db.update_track_lyrics_data(
            track_id=track_id,
            lyrics_word_data=word_data_json,
            lyrics_source=lyrics_source or "embedded_synced_lrc",
            lyrics_status=new_status,
            lyrics_language=result.language,
        )

        db.set_lyrics_job(
            track_id,
            status="completed",
            stage="Готово!",
            progress=100,
            error=None,
        )
        print(f"[WordAlignment] Job completed successfully for track {track_id} (status={new_status}, match_rate={result.stats.get('final_word_level_match_rate_pct')}%)")

    except Exception as e:
        print(f"[WordAlignment] Job failed for track {track_id}: {e}")
        db.set_lyrics_job(
            track_id,
            status="failed",
            stage="Ошибка",
            progress=100,
            error=str(e),
        )


# Backwards compatibility alias for test suite
generate_and_save_word_lrc = process_word_lyrics_job
