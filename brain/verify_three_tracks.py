"""
Comprehensive Verification Script for Punctuation Invariant, Word/Line Display Modes,
and 3-Track Quality Analysis (Russian Pop, Russian Rap, English Control).
"""

import os
import sys
import json
import re
from typing import Dict, Any, List

sys.path.append("/home/fish/projects/puuk/brain")

from lyrics_normalizer import tokenize_line, parse_reference_lrc
from whisper_anchor_backend import WhisperAnchorBackend
from benchmark_alignment import fetch_reference_lrc_info


def test_punctuation_reconstruction_examples():
    print("================================================================================")
    print("1. PUNCTUATION RECONSTRUCTION UNIT INVARIANT TESTS")
    print("================================================================================")
    
    test_cases = [
        "(А в его—) А в его мешке",
        "head)?",
        "American,",
        "«Привет» — сказал",
        "Раз  два   три",
        "  (Leading brackets and double   spaces)  ",
        "Punctuation only: ... --- !!!",
        "♪",
        "Don't stop, won't stop; (yeah!)",
        "«Город дорог» (feat. Баста) — часть 2",
    ]
    
    all_passed = True
    for text in test_cases:
        tokens = tokenize_line(text)
        reconstructed = "".join(t.prefix + t.original_text + t.suffix for t in tokens)
        match = (reconstructed == text)
        if not match:
            all_passed = False
            print(f"[FAIL] Original:      '{text}'")
            print(f"       Reconstructed: '{reconstructed}'")
        else:
            print(f"[PASS] Invariant held: '{text}'")
            # Verify clean acoustic tokens
            for t in tokens:
                for forbidden in ["(", ")", "[", "]", "{", "}", "«", "»", "—", ",", ";", ":", "!", "?"]:
                    if forbidden in t.original_text:
                        print(f"       [ERROR] Punctuation '{forbidden}' leaked into original_text '{t.original_text}'!")
                        all_passed = False
            # Verify token count
            num_acoustic = len(tokens)
            print(f"       Tokens ({num_acoustic}): " + ", ".join(f"[{repr(t.prefix)} + {repr(t.original_text)} + {repr(t.suffix)}]" for t in tokens))

    assert all_passed, "Punctuation reconstruction tests failed!"
    print("\n>>> All Punctuation Invariant Unit Tests PASSED successfully!\n")


def evaluate_track(backend: WhisperAnchorBackend, title: str, artist: str, audio_path: str, lang: str):
    print("================================================================================")
    print(f"TRACK VERIFICATION: '{title}' by '{artist}' ({lang})")
    print(f"Audio file: {os.path.basename(audio_path)}")
    print("================================================================================")

    lrc_info = fetch_reference_lrc_info(title, artist)
    if not lrc_info:
        raise RuntimeError(f"Could not fetch reference LRC for {title} {artist}")

    ref_lines = parse_reference_lrc(lrc_info["lrc_text"])
    print(f"Reference LRC lines count: {len(ref_lines)}")

    align_res = backend.align(
        audio_path,
        ref_lines,
        language=lang,
        mode="fast",
        condition_on_previous_text=False,
    )

    res_dict = align_res.to_dict()
    lines = res_dict["lines"]
    stats = res_dict["stats"]

    print(f"Alignment stats:")
    print(f"  Overall quality: {res_dict['quality']}")
    print(f"  Reference words: {stats['reference_words_count']}")
    print(f"  Matched words:   {stats['matched_words']}")
    print(f"  Final match rate:{stats['final_word_level_match_rate_pct']}%")
    print(f"  Line fallback:   {stats['line_fallback_rate_pct']}% ({stats.get('line_fallback_count', 0)}/{stats.get('total_lines', len(lines))} lines)")
    print(f"  Overlaps:        {stats['introduced_overlaps']}")

    # 1. Test Invariant on 100% of lines
    invariant_failed_lines = []
    canonical_anchor_mismatches = []
    
    word_mode_lines = []
    line_mode_lines = []
    line_mode_causes = {"line_fallback": 0, "unresolved_rate_gte_20": 0, "no_timing": 0}

    for idx, line in enumerate(lines):
        ref_line = ref_lines[idx]
        original_text = ref_line.original_text

        # Reconstruct line from words
        reconstructed = "".join(w["prefix"] + w["text"] + w["suffix"] for w in line["words"])
        if reconstructed != original_text:
            invariant_failed_lines.append((idx, original_text, reconstructed))

        # Check canonical start anchor preservation
        if ref_line.start_anchor is not None:
            if abs(line["start"] - ref_line.start_anchor) > 1e-4:
                canonical_anchor_mismatches.append((idx, ref_line.start_anchor, line["start"]))

        # Apply frontend displayMode policy:
        total_words = len(line["words"])
        if total_words == 0:
            line_mode_lines.append((idx, line, "empty_words"))
            line_mode_causes["no_timing"] += 1
            continue

        unresolved_count = sum(1 for w in line["words"] if w.get("alignment") == "unresolved")
        unresolved_rate = unresolved_count / total_words

        is_line_fallback = (line.get("quality") == "line_fallback") or not line.get("word_timing_available", True)

        if is_line_fallback:
            line_mode_lines.append((idx, line, f"line_fallback (quality={line.get('quality')})"))
            line_mode_causes["line_fallback"] += 1
        elif unresolved_rate >= 0.20:
            line_mode_lines.append((idx, line, f"unresolved_rate={unresolved_rate:.1%} >= 20%"))
            line_mode_causes["unresolved_rate_gte_20"] += 1
        else:
            word_mode_lines.append((idx, line, f"word_mode (unresolved_rate={unresolved_rate:.1%} < 20%)"))

    print(f"\nVerification checks across all {len(lines)} lines:")
    print(f"  1. Invariant ''.join(prefix + text + suffix) == original_line: {'PASSED (100%)' if not invariant_failed_lines else f'FAILED on {len(invariant_failed_lines)} lines'}")
    print(f"  2. Canonical line.time == LRC anchor (not technical word[0].start): {'PASSED (100%)' if not canonical_anchor_mismatches else f'FAILED on {len(canonical_anchor_mismatches)} lines'}")
    print(f"  3. Total lines:             {len(lines)}")
    print(f"     - displayMode='word':    {len(word_mode_lines)} ({len(word_mode_lines)/len(lines)*100:.1f}%)")
    print(f"     - displayMode='line':    {len(line_mode_lines)} ({len(line_mode_lines)/len(lines)*100:.1f}%)")
    print(f"       * breakdown: line_fallback: {line_mode_causes['line_fallback']}, unresolved_rate >= 20%: {line_mode_causes['unresolved_rate_gte_20']}")

    # Print sample lines from word mode
    print(f"\n--- Sample WORD MODE lines (Interactive Word Karaoke) ---")
    for idx, line, reason in word_mode_lines[:3]:
        print(f"Line {idx} [{line['start']:.2f}s] ({reason}): \"{line['text']}\"")
        for w in line["words"]:
            print(f"   prefix={repr(w['prefix']):<6} text={repr(w['text']):<15} suffix={repr(w['suffix']):<8} [{w.get('start', 'None')} - {w.get('end', 'None')}] {w.get('alignment')}")

    # Print sample lines from line mode
    print(f"\n--- Sample LINE MODE lines (Canonical Line Fallback) ---")
    for idx, line, reason in line_mode_lines[:3]:
        print(f"Line {idx} [{line['start']:.2f}s] ({reason}): \"{line['text']}\"")
        unres = [w['text'] for w in line['words'] if w.get('alignment') == 'unresolved']
        print(f"   Unresolved words: {unres}")

    return {
        "title": title,
        "artist": artist,
        "lang": lang,
        "total_lines": len(lines),
        "word_mode_count": len(word_mode_lines),
        "line_mode_count": len(line_mode_lines),
        "line_mode_causes": line_mode_causes,
        "invariant_passed": len(invariant_failed_lines) == 0,
        "canonical_anchors_passed": len(canonical_anchor_mismatches) == 0,
        "stats": stats,
    }


def main():
    test_punctuation_reconstruction_examples()

    backend = WhisperAnchorBackend()

    tracks = [
        {
            "title": "я не приду на выпускной",
            "artist": "ashleytears",
            "audio_path": "/home/fish/projects/puuk/brain/temp_audio/ashleytears - я не приду на выпускной.mp3",
            "lang": "ru",
        },
        {
            "title": "ПОРНХАБ КРИСМАС КЛАБ",
            "artist": "Пошлая Молли",
            "audio_path": "/home/fish/projects/puuk/brain/temp_audio/Poshlaya Molly - ПОРНХАБ КРИСМАС КЛАБ.mp3",
            "lang": "ru",
        },
        {
            "title": "Feel It Still",
            "artist": "Portugal. The Man",
            "audio_path": "/home/fish/projects/puuk/brain/temp_audio/Portugal. The Man - Feel It Still.mp3",
            "lang": "en",
        },
    ]

    results = []
    for tr in tracks:
        res = evaluate_track(backend, tr["title"], tr["artist"], tr["audio_path"], tr["lang"])
        results.append(res)

    print("\n" + "="*80)
    print("FINAL SUMMARY REPORT FOR THE 3 TRACKS")
    print("="*80)
    for r in results:
        print(f"Track: {r['title']} ({r['lang']})")
        print(f"  Total lines: {r['total_lines']}")
        print(f"  Word mode lines: {r['word_mode_count']} ({r['word_mode_count']/r['total_lines']*100:.1f}%)")
        print(f"  Line mode lines: {r['line_mode_count']} ({r['line_mode_count']/r['total_lines']*100:.1f}%)")
        print(f"    - line_fallback: {r['line_mode_causes']['line_fallback']}")
        print(f"    - unresolved >= 20%: {r['line_mode_causes']['unresolved_rate_gte_20']}")
        print(f"  Invariant held on 100% of lines: {r['invariant_passed']}")
        print(f"  Canonical LRC anchors preserved: {r['canonical_anchors_passed']}")
        print(f"  Match rate: {r['stats']['final_word_level_match_rate_pct']}%")
        print()

    out_file = "/home/fish/projects/puuk/brain/three_tracks_verification.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"Saved full results to: {out_file}")


if __name__ == "__main__":
    main()
