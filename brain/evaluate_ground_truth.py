"""
Ground Truth Timing Accuracy Evaluation and Line-by-Line Demucs Comparison Script.

Evaluates:
1. Manual timing MAE (start MAE, end MAE, boundary MAE) across 4 cohorts:
   - Russian Pop, original
   - Russian Rap, original
   - Russian Rap, Demucs vocal stem
   - English control
2. Percentages of words within 100ms and 200ms tolerances.
3. Verification that line_fallback words and synthetic timestamps NEVER enter word-level MAE.
4. Detailed Line-by-Line comparison between Original Mix and Demucs Vocal Stem on Russian Rap.
"""

import os
import sys
import json
import numpy as np
from typing import Dict, Any, List, Optional, Tuple

sys.path.append("/home/fish/projects/puuk/brain")

from benchmark_alignment import fetch_reference_lrc_info
from lyrics_normalizer import parse_reference_lrc
from whisper_anchor_backend import WhisperAnchorBackend


def evaluate_cohort(
    cohort_key: str,
    cohort_data: Dict[str, Any],
    backend: WhisperAnchorBackend,
    mode: str = "fast",
) -> Dict[str, Any]:
    title = cohort_data["track_title"]
    artist = cohort_data["artist"]
    audio_path = cohort_data["audio_path"]
    lang = cohort_data["language"]
    annotations = cohort_data["annotations"]

    print(f"\n=======================================================")
    print(f"Cohort: {cohort_key}")
    print(f"Track: '{title}' by '{artist}' | File: {os.path.basename(audio_path)}")
    print(f"=======================================================")

    lrc_info = fetch_reference_lrc_info(title, artist)
    if not lrc_info:
        raise RuntimeError(f"Could not fetch reference LRC for {title} {artist}")

    ref_lines = parse_reference_lrc(lrc_info["lrc_text"])

    align_res = backend.align(
        audio_path,
        ref_lines,
        language=lang,
        mode=mode,
        condition_on_previous_text=False,
    )

    stats = align_res.stats
    lines = align_res.lines

    # Strict invariant checks on alignment result
    assert stats["introduced_overlaps"] == 0, f"Introduced overlaps must be 0! Got {stats['introduced_overlaps']}"
    assert align_res.quality != "exact", "WhisperAnchorBackend must never output quality='exact'"

    start_errors_ms: List[float] = []
    end_errors_ms: List[float] = []
    boundary_errors_ms: List[float] = []
    within_100ms_count = 0
    within_200ms_count = 0

    annotated_total = len(annotations)
    timing_evaluated_count = 0
    line_fallback_excluded_count = 0
    unresolved_excluded_count = 0

    details = []

    for ann in annotations:
        line_idx = ann["line_index"]
        word_idx = ann["word_index"]
        expected_text = ann["word_text"]
        m_start = ann["manual_start"]
        m_end = ann["manual_end"]

        aligned_line = lines[line_idx]
        aligned_words = aligned_line.words

        if word_idx >= len(aligned_words):
            line_fallback_excluded_count += 1
            continue

        w = aligned_words[word_idx]

        # REQUIREMENT 2:
        # Check that line_fallback and technical timestamps DO NOT enter word-level timing accuracy!
        if (
            not aligned_line.word_timing_available
            or aligned_line.quality == "line_fallback"
            or w.timestamp_source == "line_fallback"
        ):
            line_fallback_excluded_count += 1
            details.append({
                "word": expected_text,
                "status": "EXCLUDED (line_fallback)",
                "manual": f"[{m_start:.2f}-{m_end:.2f}]",
                "aligned": f"[{w.start:.2f}-{w.end:.2f}] (fallback)",
                "boundary_err_ms": None,
            })
            continue

        if w.alignment == "unresolved" or w.timestamp_source == "unresolved":
            unresolved_excluded_count += 1
            details.append({
                "word": expected_text,
                "status": "EXCLUDED (unresolved)",
                "manual": f"[{m_start:.2f}-{m_end:.2f}]",
                "aligned": "unresolved",
                "boundary_err_ms": None,
            })
            continue

        # Valid word timing
        s_err = abs(w.start - m_start) * 1000.0
        e_err = abs(w.end - m_end) * 1000.0
        b_err = (s_err + e_err) / 2.0

        start_errors_ms.append(s_err)
        end_errors_ms.append(e_err)
        boundary_errors_ms.append(b_err)
        timing_evaluated_count += 1

        if b_err <= 100.0:
            within_100ms_count += 1
        if b_err <= 200.0:
            within_200ms_count += 1

        details.append({
            "word": expected_text,
            "status": f"EVALUATED ({w.alignment}/{w.timestamp_source})",
            "manual": f"[{m_start:.2f}-{m_end:.2f}]",
            "aligned": f"[{w.start:.2f}-{w.end:.2f}]",
            "s_err_ms": round(s_err, 1),
            "e_err_ms": round(e_err, 1),
            "b_err_ms": round(b_err, 1),
        })

    start_mae = round(float(np.mean(start_errors_ms)), 1) if start_errors_ms else None
    end_mae = round(float(np.mean(end_errors_ms)), 1) if end_errors_ms else None
    boundary_mae = round(float(np.mean(boundary_errors_ms)), 1) if boundary_errors_ms else None
    pct_within_100 = round((within_100ms_count / timing_evaluated_count) * 100.0, 1) if timing_evaluated_count > 0 else 0.0
    pct_within_200 = round((within_200ms_count / timing_evaluated_count) * 100.0, 1) if timing_evaluated_count > 0 else 0.0

    print(f"Overall Track Quality: {align_res.quality}")
    print(f"Reference Words: {stats['reference_words_count']}")
    print(f"Final Matched Words: {stats['matched_words']} ({stats['final_word_level_match_rate_pct']}%)")
    print(f"Line Fallback Lines: {stats['line_fallback_count']} ({stats['line_fallback_rate_pct']}%)")
    print(f"Introduced Overlaps: {stats['introduced_overlaps']} (STRICT ZERO)")
    print(f"\nGround Truth Annotation Evaluation ({annotated_total} annotated words):")
    print(f"  Timing Evaluated Words: {timing_evaluated_count}")
    print(f"  Excluded (Line Fallback): {line_fallback_excluded_count}")
    print(f"  Excluded (Unresolved): {unresolved_excluded_count}")
    print(f"  Start MAE:    {start_mae} ms" if start_mae is not None else "  Start MAE: N/A")
    print(f"  End MAE:      {end_mae} ms" if end_mae is not None else "  End MAE: N/A")
    print(f"  Boundary MAE: {boundary_mae} ms" if boundary_mae is not None else "  Boundary MAE: N/A")
    print(f"  Words <= 100ms: {within_100ms_count}/{timing_evaluated_count} ({pct_within_100}%)")
    print(f"  Words <= 200ms: {within_200ms_count}/{timing_evaluated_count} ({pct_within_200}%)")

    return {
        "cohort": cohort_key,
        "mode": mode,
        "track_title": title,
        "artist": artist,
        "overall_quality": align_res.quality,
        "stats": stats,
        "annotated_total": annotated_total,
        "timing_evaluated_count": timing_evaluated_count,
        "line_fallback_excluded_count": line_fallback_excluded_count,
        "unresolved_excluded_count": unresolved_excluded_count,
        "start_mae_ms": start_mae,
        "end_mae_ms": end_mae,
        "boundary_mae_ms": boundary_mae,
        "pct_within_100ms": pct_within_100,
        "pct_within_200ms": pct_within_200,
        "details": details,
        "alignment_result": align_res,
    }


def compare_demucs_lines(
    orig_res: Any,
    demucs_res: Any,
) -> Dict[str, Any]:
    print("\n" + "=" * 80)
    print("LINE-BY-LINE COMPARISON: Russian Rap (Original Mix vs Demucs Vocal Stem)")
    print("=" * 80)

    lines_orig = orig_res.lines
    lines_demucs = demucs_res.lines
    total_lines = len(lines_orig)

    upgraded_lines = []
    downgraded_lines = []
    equal_lines = []

    line_diffs = []

    for i in range(total_lines):
        lo = lines_orig[i]
        ld = lines_demucs[i]

        diff_matched = ld.matched_words - lo.matched_words
        is_upgraded = (lo.quality == "line_fallback" and ld.quality != "line_fallback")
        is_downgraded = (lo.quality != "line_fallback" and ld.quality == "line_fallback")

        diff_record = {
            "line_index": i,
            "text": lo.text,
            "anchor": lo.start,
            "orig_quality": lo.quality,
            "orig_matched": lo.matched_words,
            "orig_total": len(lo.words),
            "demucs_quality": ld.quality,
            "demucs_matched": ld.matched_words,
            "demucs_total": len(ld.words),
            "delta_matched": diff_matched,
            "status": "UPGRADED" if is_upgraded else ("DOWNGRADED" if is_downgraded else "EQUAL"),
        }
        line_diffs.append(diff_record)

        if is_upgraded:
            upgraded_lines.append(diff_record)
        elif is_downgraded:
            downgraded_lines.append(diff_record)
        else:
            equal_lines.append(diff_record)

    print(f"Total Lines: {total_lines}")
    print(f"Lines UPGRADED from line_fallback to approximate: {len(upgraded_lines)} lines")
    print(f"Lines DOWNGRADED: {len(downgraded_lines)} lines")
    print(f"Lines with net positive word match gain: {sum(1 for d in line_diffs if d['delta_matched'] > 0)}")
    print(f"Total Net Word Gain: {sum(d['delta_matched'] for d in line_diffs)} words")

    print("\nNotable Line Upgrades under Demucs:")
    for u in upgraded_lines[:12]:
        print(f"  Line {u['line_index']:2d} [{u['anchor']:6.2f}s]: '{u['text']}'")
        print(f"     Orig: {u['orig_quality']} ({u['orig_matched']}/{u['orig_total']}) -> Demucs: {u['demucs_quality']} ({u['demucs_matched']}/{u['demucs_total']}) [Δ={u['delta_matched']:+d}]")

    return {
        "total_lines": total_lines,
        "upgraded_lines_count": len(upgraded_lines),
        "downgraded_lines_count": len(downgraded_lines),
        "total_net_word_gain": sum(d['delta_matched'] for d in line_diffs),
        "upgraded_lines": upgraded_lines,
        "line_diffs": line_diffs,
    }


def main():
    gt_file = "/home/fish/projects/puuk/brain/manual_ground_truth.json"
    with open(gt_file, "r", encoding="utf-8") as f:
        gt_data = json.load(f)

    backend = WhisperAnchorBackend()
    cohort_results = {}

    for cohort_key in [
        "russian_pop_original",
        "russian_rap_original",
        "russian_rap_demucs_vocals",
        "english_control",
    ]:
        cohort_res = evaluate_cohort(
            cohort_key,
            gt_data["cohorts"][cohort_key],
            backend,
            mode="fast",
        )
        cohort_results[cohort_key] = cohort_res

    # Line-by-line comparison
    line_comp = compare_demucs_lines(
        cohort_results["russian_rap_original"]["alignment_result"],
        cohort_results["russian_rap_demucs_vocals"]["alignment_result"],
    )

    # Save summary report
    summary_report = {
        "cohorts": {
            k: {
                "overall_quality": v["overall_quality"],
                "reference_words_count": v["stats"]["reference_words_count"],
                "final_matched_words": v["stats"]["matched_words"],
                "final_word_level_match_rate_pct": v["stats"]["final_word_level_match_rate_pct"],
                "line_fallback_rate_pct": v["stats"]["line_fallback_rate_pct"],
                "introduced_overlaps": v["stats"]["introduced_overlaps"],
                "annotated_total": v["annotated_total"],
                "timing_evaluated_count": v["timing_evaluated_count"],
                "line_fallback_excluded_count": v["line_fallback_excluded_count"],
                "start_mae_ms": v["start_mae_ms"],
                "end_mae_ms": v["end_mae_ms"],
                "boundary_mae_ms": v["boundary_mae_ms"],
                "pct_within_100ms": v["pct_within_100ms"],
                "pct_within_200ms": v["pct_within_200ms"],
            }
            for k, v in cohort_results.items()
        },
        "demucs_line_comparison": {
            "total_lines": line_comp["total_lines"],
            "upgraded_lines_count": line_comp["upgraded_lines_count"],
            "downgraded_lines_count": line_comp["downgraded_lines_count"],
            "total_net_word_gain": line_comp["total_net_word_gain"],
            "upgraded_samples": line_comp["upgraded_lines"][:10],
        },
    }

    out_json = "/home/fish/projects/puuk/brain/ground_truth_evaluation_results.json"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(summary_report, f, indent=2, ensure_ascii=False)

    print(f"\nEvaluation successfully saved to: {out_json}")


if __name__ == "__main__":
    main()
