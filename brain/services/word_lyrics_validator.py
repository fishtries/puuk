"""Word lyrics contract validator and canonical revision computation.

Contract v1:
- schemaVersion: 1
- revision: sha256 of canonical snapshot without the revision field itself
- trackId: opaque track id (matches tracks.id)
- audioSha256: sha256 of imported audio file
- durationMs: total audio duration in milliseconds (integer > 0)
- lines: list of line objects:
  - id: string
  - text: original line text
  - startMs: integer >= 0
  - endMs: integer > startMs and <= durationMs
  - words: list of word objects:
    - id: string
    - from: integer >= 0 (code point index)
    - to: integer > from and <= len(code points in text)
    - startMs: integer >= line.startMs
    - endMs: integer > startMs and <= line.endMs
"""
import hashlib
import json
import re
from typing import Any, Dict, Optional, Tuple


def count_code_points(text: str) -> int:
    """Returns number of Unicode code points in text (matches Array.from(text).length in JS)."""
    return len(text)


def compute_canonical_revision(payload: Dict[str, Any]) -> str:
    """Computes sha256 hash of canonical JSON without the 'revision' key."""
    clone = {k: v for k, v in payload.items() if k != "revision"}
    canonical_json = json.dumps(
        clone,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


def validate_word_lyrics_payload(
    payload: Any,
    expected_track_id: Optional[str] = None,
    expected_audio_sha256: Optional[str] = None,
    verify_revision: bool = True,
) -> Tuple[bool, Optional[str]]:
    """
    Validates a word lyrics payload against Contract v1.

    Returns:
        (True, None) if valid.
        (False, error_reason) if invalid.
    """
    if not isinstance(payload, dict):
        return False, "Payload must be a dictionary"

    # Schema version
    if type(payload.get("schemaVersion")) is not int or payload["schemaVersion"] != 1:
        return False, f"Unsupported schemaVersion: {payload.get('schemaVersion')}, expected 1"

    # Track ID
    track_id = payload.get("trackId")
    if not isinstance(track_id, str) or not track_id.strip():
        return False, "Missing or invalid trackId"
    if expected_track_id and track_id != expected_track_id:
        return False, f"trackId mismatch: got '{track_id}', expected '{expected_track_id}'"

    # Audio sha256
    audio_sha256 = payload.get("audioSha256")
    if not isinstance(audio_sha256, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", audio_sha256):
        return False, "Missing or invalid audioSha256 (must be 64-char hex)"
    if expected_audio_sha256 and audio_sha256.lower() != expected_audio_sha256.lower():
        return False, f"audioSha256 mismatch: got '{audio_sha256}', expected '{expected_audio_sha256}'"

    # Duration
    duration_ms = payload.get("durationMs")
    if not isinstance(duration_ms, int) or isinstance(duration_ms, bool) or duration_ms <= 0:
        return False, "Missing or invalid durationMs (must be positive integer)"

    # Revision
    revision = payload.get("revision")
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", revision):
        return False, "Missing or invalid revision (must be 64-char hex)"

    if verify_revision:
        expected_revision = compute_canonical_revision(payload)
        if revision.lower() != expected_revision.lower():
            return False, f"Revision hash mismatch: got '{revision}', expected '{expected_revision}'"

    # Lines
    lines = payload.get("lines")
    if not isinstance(lines, list) or len(lines) == 0:
        return False, "Lines must be a non-empty list"

    seen_line_ids = set()

    for l_idx, line in enumerate(lines):
        if not isinstance(line, dict):
            return False, f"Line {l_idx} must be a dictionary"

        line_id = line.get("id")
        if not isinstance(line_id, str) or not line_id.strip():
            return False, f"Line {l_idx} has invalid id"
        if line_id in seen_line_ids:
            return False, f"Duplicate line id: '{line_id}'"
        seen_line_ids.add(line_id)

        line_text = line.get("text")
        if not isinstance(line_text, str):
            return False, f"Line '{line_id}' text must be a string"

        line_start = line.get("startMs")
        line_end = line.get("endMs")

        if not isinstance(line_start, int) or isinstance(line_start, bool) or line_start < 0:
            return False, f"Line '{line_id}' has invalid startMs: {line_start}"
        if not isinstance(line_end, int) or isinstance(line_end, bool) or line_end <= line_start:
            return False, f"Line '{line_id}' has invalid endMs: {line_end} (startMs: {line_start})"
        if line_end > duration_ms:
            return False, f"Line '{line_id}' endMs {line_end} exceeds durationMs {duration_ms}"

        # Preserve source text order even when vocal times overlap or invert.

        # Words
        words = line.get("words")
        if not isinstance(words, list):
            return False, f"Line '{line_id}' words must be a list"

        line_code_points = count_code_points(line_text)
        prev_word_end_char = 0
        seen_word_ids = set()

        for w_idx, word in enumerate(words):
            if not isinstance(word, dict):
                return False, f"Line '{line_id}' word {w_idx} must be a dictionary"

            word_id = word.get("id")
            if not isinstance(word_id, str) or not word_id.strip():
                return False, f"Line '{line_id}' word {w_idx} has invalid id"
            if word_id in seen_word_ids:
                return False, f"Line '{line_id}' duplicate word id '{word_id}'"
            seen_word_ids.add(word_id)

            char_from = word.get("from")
            char_to = word.get("to")
            if not isinstance(char_from, int) or isinstance(char_from, bool) or char_from < 0:
                return False, f"Word '{word_id}' invalid 'from': {char_from}"
            if not isinstance(char_to, int) or isinstance(char_to, bool) or char_to <= char_from:
                return False, f"Word '{word_id}' invalid 'to': {char_to} ('from': {char_from})"
            if char_to > line_code_points:
                return False, f"Word '{word_id}' 'to' {char_to} exceeds line character length {line_code_points}"

            # Rule 4: Non-overlapping character ranges
            if char_from < prev_word_end_char:
                return False, f"Word '{word_id}' character range [{char_from}, {char_to}) overlaps with previous ending at {prev_word_end_char}"
            prev_word_end_char = char_to

            w_start = word.get("startMs")
            w_end = word.get("endMs")
            if not isinstance(w_start, int) or isinstance(w_start, bool) or w_start < 0:
                return False, f"Word '{word_id}' invalid startMs: {w_start}"
            if not isinstance(w_end, int) or isinstance(w_end, bool) or w_end <= w_start:
                return False, f"Word '{word_id}' invalid endMs: {w_end} (startMs: {w_start})"
            if w_end > duration_ms:
                return False, f"Word '{word_id}' endMs {w_end} exceeds durationMs {duration_ms}"

            # Word bounds within line
            if w_start < line_start or w_end > line_end:
                return False, f"Word '{word_id}' timing [{w_start}, {w_end}) outside line [{line_start}, {line_end})"

        if words:
            # Only aggregate after validating every word and its time fields.
            if line_start != min(w["startMs"] for w in words):
                return False, f"Line '{line_id}' startMs does not match min word startMs"
            if line_end != max(w["endMs"] for w in words):
                return False, f"Line '{line_id}' endMs does not match max word endMs"

    return True, None
