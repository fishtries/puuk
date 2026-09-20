"""
Comprehensive benchmark and quality evaluation script for WhisperAnchorBackend.
Tests key representative audio types:
1. Russian vocal (Pop/Indie)
2. English vocal (Pop/Rock)
3. Mixed Russian/English
4. Rap / Fast speech (Poshlaya Molly)
5. Backing vocals / Duet (zhanulka)
6. Instrumental intro / Repetitive (Daft Punk)

Supports CLI flags:
  --mode fast|quality|all (default: fast)
  --condition-on-previous-text true|false|both (default: false)
  --track-index 0..5 (optional)
  --four-tracks (runs: 0=Russian Pop, 3=Russian Rap, 2=Mixed RU/EN, 1=English Control)
"""

import os
import sys
import time
import json
import argparse
import requests
import librosa
from typing import Dict, Any, Optional, List, Tuple

from lyrics_normalizer import parse_reference_lrc
from whisper_anchor_backend import WhisperAnchorBackend


TEST_TRACKS = [
    {
        "index": 0,
        "category": "1. Russian Pop/Indie",
        "file": "/home/fish/projects/puuk/brain/temp_audio/ashleytears - я не приду на выпускной.mp3",
        "title": "я не приду на выпускной",
        "artist": "ashleytears",
        "lang": "ru",
    },
    {
        "index": 1,
        "category": "2. English Pop/Rock (Control)",
        "file": "/home/fish/projects/puuk/brain/temp_audio/Portugal. The Man - Feel It Still.mp3",
        "title": "Feel It Still",
        "artist": "Portugal. The Man",
        "lang": "en",
    },
    {
        "index": 2,
        "category": "3. Mixed Russian/English",
        "file": "/home/fish/projects/puuk/brain/temp_audio/люблю москву но снится london - ivycraft.mp3",
        "title": "люблю москву но снится london",
        "artist": "ivycraft",
        "lang": "mixed",
    },
    {
        "index": 3,
        "category": "4. Russian Rap / Fast Speech",
        "file": "/home/fish/projects/puuk/brain/temp_audio/Poshlaya Molly - ПОРНХАБ КРИСМАС КЛАБ.mp3",
        "title": "ПОРНХАБ КРИСМАС КЛАБ",
        "artist": "Пошлая Молли",
        "lang": "ru",
    },
    {
        "index": 4,
        "category": "5. Backing Vocals / Duet",
        "file": "/home/fish/projects/puuk/brain/temp_audio/zhanulka, Какая Разница - крестики-нолики.mp3",
        "title": "крестики-нолики",
        "artist": "zhanulka",
        "lang": "ru",
    },
    {
        "index": 5,
        "category": "6. Instrumental Intro / Repetitive",
        "file": "/home/fish/projects/puuk/brain/temp_audio/Daft Punk - Around the World.mp3",
        "title": "Around the World",
        "artist": "Daft Punk",
        "lang": "en",
    },
]


def fetch_reference_lrc_info(title: str, artist: str) -> Optional[Dict[str, Any]]:
    """Fetches line-level LRC and metadata from LRCLIB."""
    for p in [
        {"track_name": title, "artist_name": artist},
        {"q": f"{title} {artist}"},
        {"q": title},
    ]:
        try:
            res = requests.get(
                "https://lrclib.net/api/search",
                params=p,
                timeout=6,
            )
            if res.status_code == 200:
                results = res.json()
                if results and isinstance(results, list):
                    for r in results:
                        synced = r.get("syncedLyrics")
                        if synced:
                            return {
                                "lrc_text": synced,
                                "source_title": r.get("trackName"),
                                "source_artist": r.get("artistName"),
                                "source_duration": r.get("duration"),
                                "is_synced": True,
                            }
                    for r in results:
                        plain = r.get("plainLyrics")
                        if plain:
                            return {
                                "lrc_text": plain,
                                "source_title": r.get("trackName"),
                                "source_artist": r.get("artistName"),
                                "source_duration": r.get("duration"),
                                "is_synced": False,
                            }
        except Exception as e:
            print(f"[WARN] LRCLIB fetch error for '{title}': {e}")

    return None


def run_single_evaluation(
    item: Dict[str, Any],
    mode: str,
    cond_prev: bool,
    backend: WhisperAnchorBackend,
) -> Optional[Dict[str, Any]]:
    cat = item["category"]
    filepath = item["file"]
    title = item["title"]
    artist = item["artist"]

    print(f"\n---> Evaluating: {cat}")
    print(f"     Track: '{title}' by '{artist}' [mode={mode}, cond_prev={cond_prev}]")

    if not os.path.isfile(filepath):
        print(f"     [SKIP] Audio file not found: {filepath}")
        return None

    audio_duration = round(librosa.get_duration(path=filepath), 2)

    lrc_info = fetch_reference_lrc_info(title, artist)
    source_dur = None
    source_title = None
    source_artist = None
    reference_mismatch = False

    if lrc_info:
        lrc_text = lrc_info["lrc_text"]
        source_dur = lrc_info.get("source_duration")
        source_title = lrc_info.get("source_title")
        source_artist = lrc_info.get("source_artist")

        if source_dur is not None and abs(audio_duration - source_dur) > 10.0:
            reference_mismatch = True
            print(
                f"     [WARN] Reference duration mismatch: audio={audio_duration}s vs LRCLIB={source_dur}s"
            )
    else:
        print("     [WARN] Could not fetch LRC from LRCLIB. Using local placeholder.")
        lrc_text = f"[00:05.00]{title}\n[00:10.00]Track by {artist}"
        reference_mismatch = True

    ref_lines = parse_reference_lrc(lrc_text)
    print(f"     Reference lines parsed: {len(ref_lines)}, audio_duration={audio_duration}s")

    t0 = time.time()
    align_res = backend.align(
        filepath,
        ref_lines,
        language=item["lang"],
        mode=mode,
        condition_on_previous_text=cond_prev,
    )
    inference_time = round(time.time() - t0, 2)

    res_dict = align_res.to_dict()
    stats = res_dict["stats"]

    # Calculate detailed line-by-line verification strictly from final JSON output
    json_total_words = 0
    json_matched_words = 0
    json_interpolated_words = 0
    json_unresolved_words = 0
    json_line_fallback_words = 0
    json_line_fallback_count = 0
    invalid_intervals = 0
    reference_text_integrity = True
    reference_word_sequence_integrity = True

    for line_idx, line in enumerate(res_dict["lines"]):
        words = line["words"]
        ref_line = ref_lines[line_idx]

        # 1. Character-exact line text check (preserving spaces, casing, punctuation, Unicode, dashes, quotes)
        if line["text"] != ref_line.original_text:
            reference_text_integrity = False

        # 2. Word sequence verbatim check
        if len(words) != len(ref_line.tokens):
            reference_word_sequence_integrity = False
        else:
            for w_idx, w in enumerate(words):
                if w["text"] != ref_line.tokens[w_idx].original_text:
                    reference_word_sequence_integrity = False

        if line.get("quality") == "line_fallback" or not line.get("word_timing_available", True):
            json_line_fallback_count += 1

        for w in words:
            json_total_words += 1
            align_state = w.get("alignment", "matched")
            ts_src = w.get("timestamp_source", "whisper")

            if ts_src == "line_fallback":
                json_line_fallback_words += 1
            elif align_state == "matched" and ts_src == "whisper":
                json_matched_words += 1
            elif align_state == "interpolated" and ts_src == "interpolated":
                json_interpolated_words += 1
            else:
                json_unresolved_words += 1

            if w["start"] >= w["end"]:
                invalid_intervals += 1

    # Strict reconciliation check between backend stats and recomputed JSON
    reconciliation_errors = []
    if json_total_words != (json_matched_words + json_interpolated_words + json_unresolved_words + json_line_fallback_words):
        reconciliation_errors.append("Sum of 4 word categories != total reference words")
    if json_total_words != stats.get("reference_words_count"):
        reconciliation_errors.append(f"total_words ({json_total_words}) != backend ref words ({stats.get('reference_words_count')})")
    if json_matched_words != stats.get("matched_words"):
        reconciliation_errors.append(f"matched_words ({json_matched_words}) != backend matched ({stats.get('matched_words')})")
    if json_interpolated_words != stats.get("interpolated_words"):
        reconciliation_errors.append(f"interpolated_words ({json_interpolated_words}) != backend interpolated ({stats.get('interpolated_words')})")
    if json_unresolved_words != stats.get("unresolved_words"):
        reconciliation_errors.append(f"unresolved_words ({json_unresolved_words}) != backend unresolved ({stats.get('unresolved_words')})")
    if json_line_fallback_words != stats.get("line_fallback_words"):
        reconciliation_errors.append(f"line_fallback_words ({json_line_fallback_words}) != backend fallback ({stats.get('line_fallback_words')})")
    if json_line_fallback_count != stats.get("line_fallback_count"):
        reconciliation_errors.append(f"line_fallback_count ({json_line_fallback_count}) != backend count ({stats.get('line_fallback_count')})")

    assert len(reconciliation_errors) == 0, f"Reconciliation assertion failed: {'; '.join(reconciliation_errors)}"

    text_match_rate = stats.get("text_match_rate_pct", 0.0)
    final_word_level_match_rate = stats.get("final_word_level_match_rate_pct", 0.0)
    interp_rate = stats.get("interpolation_rate_pct", 0.0)
    unres_rate = stats.get("unresolved_rate_pct", 0.0)
    fallback_rate = stats.get("line_fallback_rate_pct", 0.0)

    record = {
        "category": cat,
        "title": title,
        "artist": artist,
        "mode": mode,
        "condition_on_previous_text": cond_prev,
        "backend_quality": res_dict["quality"],
        "detected_language": res_dict["language"],
        "audio_duration_sec": audio_duration,
        "source_duration_sec": source_dur,
        "reference_mismatch": reference_mismatch,
        "inference_time_sec": inference_time,
        "reference_words": json_total_words,
        "matched_words": json_matched_words,
        "interpolated_words": json_interpolated_words,
        "unresolved_words": json_unresolved_words,
        "line_fallback_words": json_line_fallback_words,
        "line_fallback_count": json_line_fallback_count,
        "text_match_rate_pct": text_match_rate,
        "final_word_level_match_rate_pct": final_word_level_match_rate,
        "interpolation_rate_pct": interp_rate,
        "unresolved_rate_pct": unres_rate,
        "line_fallback_rate_pct": fallback_rate,
        "alignment_confidence": res_dict.get("confidence"),
        "mean_whisper_probability": stats.get("mean_whisper_probability"),
        "anchor_deviation_ms": stats.get("anchor_deviation_ms"),
        "manual_timing_mae_ms": None,  # Ground truth MAE (null until manual verification phase)
        "raw_overlaps": stats.get("raw_overlaps", 0),
        "fixed_overlaps": stats.get("fixed_overlaps", 0),
        "introduced_overlaps": stats.get("introduced_overlaps", 0),
        "invalid_intervals": invalid_intervals,
        "outlier_intervals": stats.get("outlier_intervals", 0),
        "temporal_constraint_violations": stats.get("temporal_constraint_violations", 0),
        "matched_whisper_words": stats.get("matched_whisper_words", 0),
        "rejected_whisper_words": stats.get("rejected_whisper_words", 0),
        "whisper_raw_words_count": stats.get("whisper_raw_words_count", 0),
        "reference_text_integrity": reference_text_integrity,
        "reference_word_sequence_integrity": reference_word_sequence_integrity,
        "reconciliation_passed": True,
        "sample_first_line": res_dict["lines"][0] if res_dict["lines"] else None,
    }

    print(f"     Inference time: {inference_time}s")
    print(
        f"     Words (JSON verified): matched={json_matched_words} ({final_word_level_match_rate}%), "
        f"interpolated={json_interpolated_words} ({interp_rate}%), "
        f"unresolved={json_unresolved_words} ({unres_rate}%), "
        f"line_fallback={json_line_fallback_words} ({fallback_rate}% across {json_line_fallback_count} lines)"
    )
    print(
        f"     Text match rate (ASR raw): {text_match_rate}%, "
        f"Final word match rate: {final_word_level_match_rate}%, "
        f"Alignment confidence: {res_dict.get('confidence')}"
    )
    print(
        f"     Matched Whisper words: {stats.get('matched_whisper_words')}/{stats.get('whisper_raw_words_count')} "
        f"(rejected={stats.get('rejected_whisper_words')})"
    )
    print(
        f"     Anchor deviation (heuristic): {stats.get('anchor_deviation_ms')} ms, "
        f"Manual timing MAE: null (awaiting ground truth), "
        f"Mean Whisper prob: {stats.get('mean_whisper_probability')}"
    )
    print(
        f"     Overlaps (raw/fixed/introduced): {stats.get('raw_overlaps', 0)}/{stats.get('fixed_overlaps', 0)}/{stats.get('introduced_overlaps', 0)}, "
        f"Temporal violations: {stats.get('temporal_constraint_violations', 0)}"
    )
    print(
        f"     Reconciliation check: PERFECT (JSON matches backend stats 100%)"
    )
    print(
        f"     Reference text integrity: {'PERFECT (100% exact)' if reference_text_integrity else 'FAILED'}"
    )
    print(
        f"     Reference word sequence integrity: {'PERFECT (100% exact)' if reference_word_sequence_integrity else 'FAILED'}"
    )

    return record


def run_benchmark(
    mode_arg: str = "fast",
    cond_prev_arg: str = "false",
    track_idx: Optional[int] = None,
    four_tracks_only: bool = False,
):
    modes = ["fast", "quality"] if mode_arg == "all" else [mode_arg]
    cond_prevs = [False, True] if cond_prev_arg == "both" else [cond_prev_arg.lower() == "true"]

    backend = WhisperAnchorBackend()
    all_results: List[Dict[str, Any]] = []

    if four_tracks_only:
        # User specified 4 tracks: Russian pop, Russian rap, Mixed RU/EN, English control
        tracks_to_run = [TEST_TRACKS[0], TEST_TRACKS[3], TEST_TRACKS[2], TEST_TRACKS[1]]
    elif track_idx is not None and 0 <= track_idx < len(TEST_TRACKS):
        tracks_to_run = [TEST_TRACKS[track_idx]]
    else:
        tracks_to_run = TEST_TRACKS

    print("=" * 80)
    print(f"STARTING BENCHMARK: modes={modes}, condition_on_prev={cond_prevs}")
    print(f"Testing {len(tracks_to_run)} track(s)...")
    print("=" * 80)

    for mode in modes:
        for cond_prev in cond_prevs:
            for item in tracks_to_run:
                rec = run_single_evaluation(item, mode=mode, cond_prev=cond_prev, backend=backend)
                if rec:
                    all_results.append(rec)

    # Save to json
    results_path = os.path.join(os.path.dirname(__file__), "benchmark_results.json")
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 80)
    print(f"BENCHMARK FINISHED. Saved {len(all_results)} run(s) to: {results_path}")
    print("=" * 80)

    return all_results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WhisperAnchorBackend Benchmark")
    parser.add_argument(
        "--mode",
        choices=["fast", "quality", "all"],
        default="fast",
        help="Inference mode (default: fast)",
    )
    parser.add_argument(
        "--condition-on-previous-text",
        choices=["true", "false", "both"],
        default="false",
        help="condition_on_previous_text parameter (default: false)",
    )
    parser.add_argument(
        "--track-index",
        type=int,
        default=None,
        help="Run single track by index (0: Russian Pop, 1: English, 2: Mixed, 3: Russian Rap, 4: Duet, 5: Daft Punk)",
    )
    parser.add_argument(
        "--four-tracks",
        action="store_true",
        help="Run the 4 key evaluation tracks: Russian Pop, Russian Rap, Mixed RU/EN, English Control",
    )
    args = parser.parse_args()

    run_benchmark(
        mode_arg=args.mode,
        cond_prev_arg=args.condition_on_previous_text,
        track_idx=args.track_index,
        four_tracks_only=args.four_tracks,
    )
