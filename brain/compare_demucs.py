"""
Compare WhisperAnchorBackend alignment on Original Mix vs Demucs Vocal Stem
for Russian Pop and Russian Rap.
"""

import os
import sys
import time
import json
import librosa
from lyrics_normalizer import parse_reference_lrc
from whisper_anchor_backend import WhisperAnchorBackend
from benchmark_alignment import fetch_reference_lrc_info, TEST_TRACKS

TRACKS = [
    {
        "name": "Russian Pop (ashleytears - я не приду на выпускной)",
        "orig_file": "/home/fish/projects/puuk/brain/temp_audio/ashleytears - я не приду на выпускной.mp3",
        "stem_file": "/home/fish/projects/puuk/brain/temp_audio/separated/htdemucs/ashleytears - я не приду на выпускной/vocals.wav",
        "title": "я не приду на выпускной",
        "artist": "ashleytears",
        "lang": "ru",
    },
    {
        "name": "Russian Rap (Пошлая Молли - ПОРНХАБ КРИСМАС КЛАБ)",
        "orig_file": "/home/fish/projects/puuk/brain/temp_audio/Poshlaya Molly - ПОРНХАБ КРИСМАС КЛАБ.mp3",
        "stem_file": "/home/fish/projects/puuk/brain/temp_audio/separated/htdemucs/Poshlaya Molly - ПОРНХАБ КРИСМАС КЛАБ/vocals.wav",
        "title": "ПОРНХАБ КРИСМАС КЛАБ",
        "artist": "Пошлая Молли",
        "lang": "ru",
    },
]

def evaluate(backend, audio_path, ref_lines, lang):
    t0 = time.time()
    res = backend.align(audio_path, ref_lines, language=lang, mode="fast", condition_on_previous_text=False)
    infer_time = round(time.time() - t0, 2)
    res_dict = res.to_dict()
    stats = res_dict["stats"]
    return {
        "infer_time": infer_time,
        "quality": res_dict["quality"],
        "confidence": res_dict["confidence"],
        "total_words": stats["reference_words_count"],
        "matched": stats["matched_words"],
        "interpolated": stats["interpolated_words"],
        "unresolved": stats["unresolved_words"],
        "line_fallback_words": stats["line_fallback_words"],
        "line_fallback_count": stats["line_fallback_count"],
        "text_match_rate_pct": stats["text_match_rate_pct"],
        "final_word_level_match_rate_pct": stats["final_word_level_match_rate_pct"],
        "interpolation_rate_pct": stats["interpolation_rate_pct"],
        "unresolved_rate_pct": stats["unresolved_rate_pct"],
        "line_fallback_rate_pct": stats["line_fallback_rate_pct"],
        "matched_whisper_words": stats["matched_whisper_words"],
        "whisper_raw_words_count": stats["whisper_raw_words_count"],
        "rejected_whisper_words": stats["rejected_whisper_words"],
        "mean_whisper_probability": stats["mean_whisper_probability"],
        "anchor_deviation_ms": stats["anchor_deviation_ms"],
        "raw_overlaps": stats["raw_overlaps"],
        "fixed_overlaps": stats["fixed_overlaps"],
        "introduced_overlaps": stats["introduced_overlaps"],
    }

def main():
    backend = WhisperAnchorBackend()
    comparisons = []

    print("=" * 80)
    print("DEMUCS VOCAL STEM VS ORIGINAL MIX EVALUATION")
    print("=" * 80)

    for item in TRACKS:
        print(f"\n--- Testing: {item['name']} ---")
        lrc_info = fetch_reference_lrc_info(item["title"], item["artist"])
        ref_lines = parse_reference_lrc(lrc_info["lrc_text"])
        print(f"Parsed {len(ref_lines)} reference lines.")

        print("  1. Running Original Mix...")
        orig_metrics = evaluate(backend, item["orig_file"], ref_lines, item["lang"])
        print(f"     Orig: matched={orig_metrics['matched']} ({orig_metrics['final_word_level_match_rate_pct']}%), raw_text={orig_metrics['text_match_rate_pct']}%, fallback_lines={orig_metrics['line_fallback_count']}")

        print("  2. Running Demucs Vocal Stem...")
        stem_metrics = evaluate(backend, item["stem_file"], ref_lines, item["lang"])
        print(f"     Stem: matched={stem_metrics['matched']} ({stem_metrics['final_word_level_match_rate_pct']}%), raw_text={stem_metrics['text_match_rate_pct']}%, fallback_lines={stem_metrics['line_fallback_count']}")

        comparisons.append({
            "track": item["name"],
            "original_mix": orig_metrics,
            "vocal_stem": stem_metrics,
        })

    out_file = "/home/fish/projects/puuk/brain/demucs_comparison_results.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(comparisons, f, ensure_ascii=False, indent=2)

    print("\n" + "=" * 80)
    print(f"Comparison complete. Saved to: {out_file}")
    print("=" * 80)

if __name__ == "__main__":
    main()
