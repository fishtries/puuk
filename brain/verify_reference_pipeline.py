"""
Verification script for the 3 real/fixture scenarios:
1. Track with real synced LRC
2. Track with only plain lyrics in ID3
3. Track without any lyrics (Whisper ASR draft fallback)

Outputs a comprehensive reference pipeline report.
"""

import os
import sys
import json
import requests

sys.path.insert(0, os.path.dirname(__file__))

import db
from lyrics_normalizer import (
    validate_synced_lrc,
    is_synced_lrc,
    parse_reference_lrc,
    inspect_reference_anchors,
)
from api import app, process_word_lyrics_job
from fastapi.testclient import TestClient


def run_verification():
    client = TestClient(app)
    report = {}

    print("=" * 80)
    print("RUNNING 3-TRACK REFERENCE PIPELINE VERIFICATION")
    print("=" * 80)

    # -------------------------------------------------------------------------
    # SCENARIO 1: Track with REAL Synced LRC (Ashleytears - я не приду на выпускной)
    # -------------------------------------------------------------------------
    print("\n>>> Scenario 1: Track with Real Synced LRC")
    track_1_id = "verify-track-synced-001"
    audio_1_path = os.path.join(os.path.dirname(__file__), "temp_audio", "ashleytears - я не приду на выпускной.mp3")
    album_id = db.add_or_get_album("Выпускной Альбом")

    db.add_or_update_track(
        track_1_id,
        audio_1_path,
        "я не приду на выпускной",
        album_id,
        "ashleytears",
        lyrics=None,
    )

    # Trigger GET to fetch synced LRC from LRCLIB
    res1_get = client.get(f"/api/tracks/{track_1_id}/lyrics?force=true")
    data1_get = res1_get.json()
    print(f"  GET /lyrics result: isSynced={data1_get['isSynced']}, source={data1_get['referenceSource']}, status={data1_get['lyricsStatus']}")
    print(f"  Anchors info: hasLineAnchors={data1_get['hasLineAnchors']}, coverage={data1_get['anchorCoverage']:.1%}, count={data1_get['anchoredLinesCount']}/{data1_get['totalLinesCount']}")

    # Process alignment job
    print("  Executing alignment job...")
    process_word_lyrics_job(track_1_id, audio_1_path, language="ru")

    # Re-fetch after job
    res1_post = client.get(f"/api/tracks/{track_1_id}/lyrics")
    data1_post = res1_post.json()
    has_word_data = bool(data1_post.get("wordData"))
    print(f"  After alignment: status={data1_post['lyricsStatus']}, wordData present={has_word_data}")
    if has_word_data:
        wd = data1_post["wordData"]
        print(f"  wordData stats: match_rate={wd['stats'].get('final_word_level_match_rate_pct')}%, quality={wd['quality']}, coverage={wd['stats'].get('anchor_coverage')}")

    report["scenario_1_synced_lrc"] = {
        "title": "я не приду на выпускной",
        "artist": "ashleytears",
        "isSynced": data1_post["isSynced"],
        "referenceSource": data1_post["referenceSource"],
        "lyricsStatus": data1_post["lyricsStatus"],
        "hasLineAnchors": data1_post["hasLineAnchors"],
        "anchorCoverage": data1_post["anchorCoverage"],
        "anchoredLinesCount": data1_post["anchoredLinesCount"],
        "totalLinesCount": data1_post["totalLinesCount"],
        "wordDataPresent": has_word_data,
        "quality": data1_post["wordData"]["quality"] if has_word_data else None,
    }

    # -------------------------------------------------------------------------
    # SCENARIO 2: Track with ONLY Plain Lyrics in ID3
    # -------------------------------------------------------------------------
    print("\n>>> Scenario 2: Track with ONLY Plain Lyrics in ID3 (No Line Anchors)")
    track_2_id = "verify-track-plain-002"
    audio_2_path = os.path.join(os.path.dirname(__file__), "temp_audio", "zhanulka, Какая Разница - крестики-нолики.mp3")

    plain_lyrics_text = (
        "Первый куплет без временных меток\n"
        "Вторая строка обычного текста\n"
        "Третья строка без таймстемпов\n"
        "Четвёртая строка завершает куплет\n"
        "Припев звучит громко и просто"
    )

    db.add_or_update_track(
        track_2_id,
        audio_2_path,
        "Несуществующий Трек Без Таймингов",
        album_id,
        "Неизвестный Автор Текстов",
        lyrics=plain_lyrics_text,
    )
    db.update_track_lyrics_data(
        track_2_id,
        lyrics_source="embedded_plain",
        lyrics_status="plain",
        clear_word_data=True,
    )

    # GET /lyrics
    res2_get = client.get(f"/api/tracks/{track_2_id}/lyrics")
    data2_get = res2_get.json()
    print(f"  GET /lyrics result: isSynced={data2_get['isSynced']}, source={data2_get['referenceSource']}, status={data2_get['lyricsStatus']}")
    print(f"  Anchors info: hasLineAnchors={data2_get['hasLineAnchors']}, coverage={data2_get['anchorCoverage']:.1%}, count={data2_get['anchoredLinesCount']}/{data2_get['totalLinesCount']}")
    print(f"  wordData: {data2_get['wordData']}")

    # Process alignment job (must honestly refuse anchored alignment and keep plain)
    print("  Executing alignment job...")
    process_word_lyrics_job(track_2_id, audio_2_path, language="ru")

    res2_post = client.get(f"/api/tracks/{track_2_id}/lyrics")
    data2_post = res2_post.json()
    print(f"  After alignment attempt: status={data2_post['lyricsStatus']}, wordData={data2_post['wordData']}")
    print(f"  Zero anchors preserved: hasLineAnchors={data2_post['hasLineAnchors']}, isSynced={data2_post['isSynced']}")

    report["scenario_2_plain_lyrics"] = {
        "isSynced": data2_post["isSynced"],
        "referenceSource": data2_post["referenceSource"],
        "lyricsStatus": data2_post["lyricsStatus"],
        "hasLineAnchors": data2_post["hasLineAnchors"],
        "anchorCoverage": data2_post["anchorCoverage"],
        "anchoredLinesCount": data2_post["anchoredLinesCount"],
        "totalLinesCount": data2_post["totalLinesCount"],
        "wordDataPresent": data2_post["wordData"] is not None,
        "passed": (data2_post["wordData"] is None and data2_post["lyricsStatus"] == "plain" and not data2_post["hasLineAnchors"]),
    }

    # -------------------------------------------------------------------------
    # SCENARIO 3: Track WITHOUT Any Lyrics at all (Whisper ASR Draft Fallback)
    # -------------------------------------------------------------------------
    print("\n>>> Scenario 3: Track WITHOUT Any Lyrics (Whisper ASR Draft Fallback)")
    track_3_id = "verify-track-none-003"
    audio_3_path = os.path.join(os.path.dirname(__file__), "temp_audio", "jfk.wav")

    db.add_or_update_track(
        track_3_id,
        audio_3_path,
        "JFK Speech Audio",
        album_id,
        "Historical Archives",
        lyrics=None,
    )
    db.update_track_lyrics_data(
        track_3_id,
        lyrics_source=None,
        lyrics_status="empty",
        clear_word_data=True,
    )

    # Process alignment job
    print("  Executing alignment job (ASR draft generation on jfk.wav)...")
    process_word_lyrics_job(track_3_id, audio_3_path, language="en")

    res3_post = client.get(f"/api/tracks/{track_3_id}/lyrics")
    data3_post = res3_post.json()
    has_word_data_3 = bool(data3_post.get("wordData"))
    print(f"  After ASR draft job: source={data3_post['referenceSource']}, status={data3_post['lyricsStatus']}")
    print(f"  Computed anchors: hasLineAnchors={data3_post['hasLineAnchors']}, count={data3_post['anchoredLinesCount']}/{data3_post['totalLinesCount']}, coverage={data3_post['anchorCoverage']:.1%}")

    report["scenario_3_whisper_draft"] = {
        "isSynced": data3_post["isSynced"],
        "referenceSource": data3_post["referenceSource"],
        "lyricsStatus": data3_post["lyricsStatus"],
        "hasLineAnchors": data3_post["hasLineAnchors"],
        "anchorCoverage": data3_post["anchorCoverage"],
        "anchoredLinesCount": data3_post["anchoredLinesCount"],
        "totalLinesCount": data3_post["totalLinesCount"],
        "wordDataPresent": has_word_data_3,
    }

    print("\n" + "=" * 80)
    print("3-TRACK VERIFICATION SUMMARY")
    print("=" * 80)
    print(json.dumps(report, indent=2, ensure_ascii=False))

    # Clean up DB test entries
    conn = db.get_connection()
    c = conn.cursor()
    c.execute("DELETE FROM tracks WHERE id IN (?, ?, ?)", (track_1_id, track_2_id, track_3_id))
    c.execute("DELETE FROM lyrics_jobs WHERE track_id IN (?, ?, ?)", (track_1_id, track_2_id, track_3_id))
    conn.commit()
    conn.close()

    return report


if __name__ == "__main__":
    run_verification()
