#!/usr/bin/env python3
"""Export verified word-level lyrics to Puuk Contract v1 format.

Reads word alignment data, builds the canonical wordLyrics JSON structure,
validates it against Contract v1 rules, and writes the output.
"""
import argparse
import hashlib
import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "brain"))
from services.word_lyrics_validator import (
    compute_canonical_revision,
    validate_word_lyrics_payload,
)


def compute_file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def get_audio_duration_ms(path: str, fallback_seconds: Optional[float] = None) -> int:
    """Gets audio duration in milliseconds using mutagen or fallback."""
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(path)
        if audio and audio.info and audio.info.length:
            return round(audio.info.length * 1000)
    except Exception:
        pass
    if fallback_seconds is not None:
        return round(fallback_seconds * 1000)
    raise ValueError(f"Cannot determine duration for {path}")


def build_word_lyrics_snapshot(
    track_id: str,
    audio_path: str,
    reference_data: Dict[str, Any],
    aligned_words: List[Dict[str, Any]],
    base_engine: str,
    review_status: str,
    source_export_path: Optional[str] = None,
    source_checksum: Optional[str] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """
    Builds Contract v1 wordLyrics object and provenance metadata.

    Returns:
        (word_lyrics_dict, provenance_dict, quality_report)
    """
    audio_sha256 = compute_file_sha256(audio_path)
    ref_duration = reference_data.get("duration")
    duration_ms = get_audio_duration_ms(audio_path, fallback_seconds=ref_duration)

    ref_lines = reference_data["lines"]
    word_map = {w["id"]: w for w in aligned_words}

    contract_lines = []
    report_words_count = 0
    report_locked_count = 0
    report_fallback_lines = 0
    report_overlaps = 0
    report_long_words = 0
    warnings = []

    for l_idx, r_line in enumerate(ref_lines):
        line_id = f"line-{l_idx:04d}"
        line_text = r_line["text"]
        line_anchor_sec = r_line.get("anchor")
        
        # Words belonging to this line in reference
        line_ref_words = [w for w in reference_data["words"] if w["line"] == l_idx]
        
        # Gather timed words
        has_invalid_word = False
        line_contract_words = []
        prev_word_end_ms = -1
        prev_word_start_ms = -1

        for w_idx, rw in enumerate(line_ref_words):
            wid = rw["id"]
            aw = word_map.get(wid)
            if not aw:
                has_invalid_word = True
                warnings.append(f"Line {l_idx}: word {wid} '{rw['text']}' missing in alignment data")
                break

            start_sec = aw.get("start")
            end_sec = aw.get("end")
            if (
                start_sec is None
                or end_sec is None
                or not math.isfinite(start_sec)
                or not math.isfinite(end_sec)
                or start_sec < 0
                or end_sec <= start_sec
            ):
                has_invalid_word = True
                warnings.append(f"Line {l_idx}: word {wid} '{rw['text']}' has invalid timing ({start_sec}, {end_sec})")
                break

            start_ms = round(start_sec * 1000)
            end_ms = round(end_sec * 1000)
            if end_ms <= start_ms or end_ms > duration_ms:
                has_invalid_word = True
                warnings.append(f"Line {l_idx}: word {wid} cannot be represented within audio duration")
                break

            if aw.get("locked"):
                report_locked_count += 1

            if start_ms < prev_word_start_ms:
                warnings.append(f"Line {l_idx}: word {wid} starts before the previous word; source timing preserved")
            prev_word_start_ms = start_ms
            if start_ms < prev_word_end_ms:
                report_overlaps += 1
            prev_word_end_ms = end_ms

            if end_ms - start_ms > 2000:
                report_long_words += 1

            # Word ID: preserve occurrence identity
            word_contract_id = f"word-{wid:04d}"
            line_contract_words.append({
                "id": word_contract_id,
                "from": rw["char_start"],
                "to": rw["char_end"],
                "startMs": start_ms,
                "endMs": end_ms,
            })

        # Keep occurrence order and exact rounded times, including inversions.
        if not has_invalid_word and len(line_contract_words) > 0:
            min_start = min(w["startMs"] for w in line_contract_words)
            max_end = max(w["endMs"] for w in line_contract_words)
            line_start_ms = min_start
            line_end_ms = max_end
            words_for_line = line_contract_words
            report_words_count += len(line_contract_words)
        else:
            # Fallback line with words: []
            report_fallback_lines += 1
            words_for_line = []
            if line_anchor_sec is not None:
                line_start_ms = round(line_anchor_sec * 1000)
            else:
                raise ValueError(f"Line {l_idx}: missing LRC anchor for fallback")
            
            # Next line anchor or duration
            next_anchor = None
            for next_l in ref_lines[l_idx + 1:]:
                if next_l.get("anchor") is not None and round(next_l["anchor"] * 1000) > line_start_ms:
                    next_anchor = round(next_l["anchor"] * 1000)
                    break
            line_end_ms = next_anchor if next_anchor is not None else duration_ms

        contract_lines.append({
            "id": line_id,
            "text": line_text,
            "startMs": line_start_ms,
            "endMs": line_end_ms,
            "words": words_for_line,
        })

    payload_without_rev = {
        "schemaVersion": 1,
        "trackId": track_id,
        "audioSha256": audio_sha256,
        "durationMs": duration_ms,
        "lines": contract_lines,
    }

    revision = compute_canonical_revision(payload_without_rev)
    payload = {
        **payload_without_rev,
        "revision": revision,
    }

    # Validate against Contract v1
    is_valid, error = validate_word_lyrics_payload(
        payload,
        expected_track_id=track_id,
        expected_audio_sha256=audio_sha256,
        verify_revision=True,
    )
    if not is_valid:
        raise ValueError(f"Built payload failed validation: {error}")

    provenance = {
        "trackId": track_id,
        "baseEngine": base_engine,
        "reviewStatus": review_status,
        "sourceExportPath": source_export_path,
        "sourceChecksum": source_checksum,
        "audioSha256": audio_sha256,
        "revision": revision,
        "durationMs": duration_ms,
        "totalLines": len(contract_lines),
        "totalWords": report_words_count,
        "lockedManualWords": report_locked_count,
        "fallbackLines": report_fallback_lines,
        "warnings": warnings,
    }

    quality_report = {
        "track_id": track_id,
        "revision": revision,
        "lines": len(contract_lines),
        "words": report_words_count,
        "locked_manual_edits": report_locked_count,
        "fallback_lines": report_fallback_lines,
        "word_overlaps": report_overlaps,
        "long_words_gt_2s": report_long_words,
        "warnings": warnings,
    }

    return payload, provenance, quality_report


def main():
    parser = argparse.ArgumentParser(description="Export word lyrics to Contract v1 JSON")
    parser.add_argument("--track-id", required=True, help="Target track UUID in Puuk")
    parser.add_argument("--audio", required=True, help="Path to track audio file")
    parser.add_argument("--reference", required=True, help="Path to reference.json")
    parser.add_argument("--aligned-json", help="Path to aligned result JSON (e.g. psychoboost-aligned.json)")
    parser.add_argument("--model-json", help="Path to engine output JSON (e.g. mms.json)")
    parser.add_argument("--manual-json", help="Path to manual annotations JSON (e.g. storage dump)")
    parser.add_argument("--track-slug", help="Track slug for manual annotation lookup (e.g. stateside, without-me)")
    parser.add_argument("--base-engine", default="stable-retry", help="Base alignment engine name")
    parser.add_argument("--review-status", default="draft_with_protected_manual_edits")
    parser.add_argument("--output", required=True, help="Output wordLyrics JSON path")
    parser.add_argument("--provenance-output", help="Output provenance JSON path")
    args = parser.parse_args()

    with open(args.reference, "r", encoding="utf-8") as f:
        ref_data = json.load(f)

    if args.aligned_json:
        with open(args.aligned_json, "r", encoding="utf-8") as f:
            aligned_data = json.load(f)
        aligned_words = aligned_data["words"]
        base_engine = aligned_data.get("base_engine", args.base_engine)
        review_status = aligned_data.get("review_status", args.review_status)
        source_chk = compute_file_sha256(args.aligned_json)
        source_path = os.path.abspath(args.aligned_json)
    elif args.model_json:
        with open(args.model_json, "r", encoding="utf-8") as f:
            model_data = json.load(f)
        source_chk = compute_file_sha256(args.model_json)
        source_path = os.path.abspath(args.model_json)
        base_engine = args.base_engine
        review_status = args.review_status
        
        # Merge model words with manual annotations if provided
        aligned_words = []
        manual_map = {}
        if args.manual_json and os.path.exists(args.manual_json):
            with open(args.manual_json, "r", encoding="utf-8") as f:
                raw_manual = json.load(f)
            # Filter by track slug or track id
            slug = args.track_slug or args.track_id
            for k, v in raw_manual.items():
                if k.startswith(f"{slug}:"):
                    wid = int(k.split(":")[1])
                    manual_map[wid] = v

        for rw in ref_data["words"]:
            wid = rw["id"]
            if wid in manual_map:
                mv = manual_map[wid]
                aligned_words.append({
                    "id": wid,
                    "line": rw["line"],
                    "text": rw["text"],
                    "char_start": rw["char_start"],
                    "char_end": rw["char_end"],
                    "start": mv["start"],
                    "end": mv["end"],
                    "source": "manual",
                    "locked": True,
                })
            else:
                mw = next((w for w in model_data["words"] if w["id"] == wid), None)
                if mw:
                    aligned_words.append({
                        "id": wid,
                        "line": rw["line"],
                        "text": rw["text"],
                        "char_start": rw["char_start"],
                        "char_end": rw["char_end"],
                        "start": mw["start"],
                        "end": mw["end"],
                        "source": base_engine,
                        "locked": False,
                    })
                else:
                    aligned_words.append({
                        "id": wid,
                        "line": rw["line"],
                        "text": rw["text"],
                        "char_start": rw["char_start"],
                        "char_end": rw["char_end"],
                        "start": None,
                        "end": None,
                        "source": None,
                        "locked": False,
                    })
    else:
        raise ValueError("Must provide either --aligned-json or --model-json")

    payload, provenance, quality_report = build_word_lyrics_snapshot(
        track_id=args.track_id,
        audio_path=args.audio,
        reference_data=ref_data,
        aligned_words=aligned_words,
        base_engine=base_engine,
        review_status=review_status,
        source_export_path=source_path,
        source_checksum=source_chk,
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump({"wordLyrics": payload}, f, ensure_ascii=False, indent=2)

    if args.provenance_output:
        os.makedirs(os.path.dirname(os.path.abspath(args.provenance_output)), exist_ok=True)
        with open(args.provenance_output, "w", encoding="utf-8") as f:
            json.dump(provenance, f, ensure_ascii=False, indent=2)

    print(f"Exported revision: {payload['revision']}")
    print(f"Quality report: {json.dumps(quality_report, indent=2, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
