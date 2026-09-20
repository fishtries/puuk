"""
Lyrics normalization module for line-level LRC parsing and validation.
Guarantees that the original text is NEVER mutated or reconstructed.
"""

import re
from dataclasses import dataclass
from typing import List, Optional, Tuple, Dict, Any

# Regex matching LRC timestamp headers: [MM:SS.mmm] or [MM:SS:mmm] or [MM:SS]
LRC_TIMESTAMP_REGEX = re.compile(r"\[(\d{2,}):(\d{2})(?:[.:](\d{2,3}))?\]")

# Metadata tags: [ar:...], [ti:...], [al:...], [by:...], [offset:...], [length:...], etc.
LRC_METADATA_REGEX = re.compile(r"^\[(ar|ti|al|au|by|offset|length|re|ve):", re.IGNORECASE)

# Inline word-level tags in legacy Enhanced LRC: <MM:SS.mmm> — stripped from display text.
LEGACY_WORD_TAG_REGEX = re.compile(r"<\d{2,}:\d{2}(?:[.:]\d{2,3})?>")


@dataclass
class ReferenceLine:
    """A single parsed lyric line with an optional line-level timestamp anchor."""
    original_text: str
    start_anchor: Optional[float]  # Timestamp in seconds from LRC [MM:SS.mmm], if available
    next_anchor: Optional[float]   # Timestamp in seconds of succeeding line, if available
    line_index: int
    language: Optional[str] = None  # 'ru', 'en', 'mixed'


def detect_line_language(text: str) -> str:
    """
    Determines language on a per-line basis ('ru', 'en', 'mixed').
    Counts Cyrillic vs Latin characters.
    """
    if not text:
        return "ru"

    cyrillic_chars = len(re.findall(r"[\u0400-\u04FF]", text))
    latin_chars = len(re.findall(r"[a-zA-Z]", text))
    total_letters = cyrillic_chars + latin_chars

    if total_letters == 0:
        return "ru"

    cyr_ratio = cyrillic_chars / total_letters
    lat_ratio = latin_chars / total_letters

    if cyr_ratio >= 0.70:
        return "ru"
    elif lat_ratio >= 0.70:
        return "en"
    elif cyr_ratio >= 0.20 and lat_ratio >= 0.20:
        return "mixed"
    elif cyr_ratio > lat_ratio:
        return "ru"
    else:
        return "en"


def parse_timestamp_seconds(match: re.Match) -> float:
    """
    Parses regex match of [MM:SS.mmm] into seconds as float.
    """
    minutes = int(match.group(1))
    seconds = int(match.group(2))
    ms_str = match.group(3)
    ms = 0
    if ms_str:
        if len(ms_str) == 2:
            ms = int(ms_str) * 10
        else:
            ms = int(ms_str[:3])
    return minutes * 60 + seconds + ms / 1000.0


def parse_reference_lrc(lrc_content: str) -> List[ReferenceLine]:
    """
    Parses canonical reference text (line-level LRC or plain lyrics) into ReferenceLine objects.
    Preserves original verbatim text, line breaks, casing, and punctuation.
    """
    if not lrc_content or not isinstance(lrc_content, str):
        return []

    raw_lines = lrc_content.splitlines()
    parsed_items: List[Tuple[Optional[float], str]] = []

    for line in raw_lines:
        stripped = line.strip()
        if not stripped:
            continue

        # Skip ID3 / LRC metadata tags like [ti:Song], [ar:Artist]
        if LRC_METADATA_REGEX.match(stripped):
            continue

        # Check for timestamp
        time_matches = list(LRC_TIMESTAMP_REGEX.finditer(stripped))
        if time_matches:
            # First timestamp is line start anchor
            first_match = time_matches[0]
            start_sec = parse_timestamp_seconds(first_match)
            # Remove all timestamps from the line to get the clean display text
            clean_display = LRC_TIMESTAMP_REGEX.sub("", stripped).strip()
            clean_display = LEGACY_WORD_TAG_REGEX.sub("", clean_display).strip()
            if clean_display:
                parsed_items.append((start_sec, clean_display))
        else:
            # Plain lyrics line (no timestamp anchor)
            clean_display = LEGACY_WORD_TAG_REGEX.sub("", stripped).strip()
            if clean_display:
                parsed_items.append((None, clean_display))

    reference_lines: List[ReferenceLine] = []
    total = len(parsed_items)

    for i, (start_anchor, display_text) in enumerate(parsed_items):
        # Look ahead for next anchor
        next_anchor = None
        for j in range(i + 1, total):
            if parsed_items[j][0] is not None:
                next_anchor = parsed_items[j][0]
                break

        reference_lines.append(
            ReferenceLine(
                original_text=display_text,
                start_anchor=start_anchor,
                next_anchor=next_anchor,
                line_index=i,
                language=detect_line_language(display_text),
            )
        )

    return reference_lines


def validate_synced_lrc(lrc_content: Optional[str]) -> Dict[str, Any]:
    """
    Validates synchronized LRC text across multiple dimensions:
    - Line anchor count and coverage (anchored / total >= 0.8)
    - Monotonicity (strictly non-decreasing timestamps, tolerance 50ms)
    - Duplicate timestamp spikes
    - Anomalous time gaps (> 90s)
    Returns detailed diagnostics dictionary with boolean 'is_synced'.
    """
    if not lrc_content or not isinstance(lrc_content, str):
        return {
            "is_synced": False,
            "total_lines": 0,
            "anchored_lines": 0,
            "coverage": 0.0,
            "monotonic": True,
            "duplicate_timestamps": 0,
            "max_gap_seconds": 0.0,
            "anomalous_gaps": [],
            "issues": ["empty_lyrics"],
        }

    raw_lines = lrc_content.splitlines()
    text_lines: List[Tuple[Optional[float], str]] = []

    for line in raw_lines:
        stripped = line.strip()
        if not stripped or LRC_METADATA_REGEX.match(stripped):
            continue
        time_matches = list(LRC_TIMESTAMP_REGEX.finditer(stripped))
        if time_matches:
            first_match = time_matches[0]
            start_sec = parse_timestamp_seconds(first_match)
            clean_display = LRC_TIMESTAMP_REGEX.sub("", stripped).strip()
            text_lines.append((start_sec, clean_display))
        else:
            text_lines.append((None, stripped))

    total_lines = len(text_lines)
    if total_lines == 0:
        return {
            "is_synced": False,
            "total_lines": 0,
            "anchored_lines": 0,
            "coverage": 0.0,
            "monotonic": True,
            "duplicate_timestamps": 0,
            "max_gap_seconds": 0.0,
            "anomalous_gaps": [],
            "issues": ["empty_lyrics"],
        }

    anchors = [t[0] for t in text_lines if t[0] is not None]
    anchored_lines = len(anchors)
    coverage = anchored_lines / total_lines

    if anchored_lines == 0:
        return {
            "is_synced": False,
            "total_lines": total_lines,
            "anchored_lines": 0,
            "coverage": 0.0,
            "monotonic": True,
            "duplicate_timestamps": 0,
            "max_gap_seconds": 0.0,
            "anomalous_gaps": [],
            "issues": ["zero_anchors"],
        }

    monotonic = True
    duplicate_timestamps = 0
    max_gap = 0.0
    anomalous_gaps = []
    issues: List[str] = []

    for k in range(1, len(anchors)):
        gap = anchors[k] - anchors[k - 1]
        if gap < -0.05:
            monotonic = False
            issues.append(f"non_monotonic({anchors[k-1]:.2f}s -> {anchors[k]:.2f}s)")
        elif abs(gap) < 0.001:
            duplicate_timestamps += 1
        if gap > max_gap:
            max_gap = gap
        if gap > 90.0:
            anomalous_gaps.append({"prev": anchors[k - 1], "curr": anchors[k], "gap": gap})

    if not monotonic:
        issues.append("non_monotonic_timestamps")
    if duplicate_timestamps > max(2, int(len(anchors) * 0.35)):
        issues.append("excessive_duplicate_timestamps")
    if coverage < 0.80:
        issues.append(f"low_coverage({coverage:.1%} < 80%)")
    if anomalous_gaps:
        issues.append("anomalous_time_gaps")

    is_synced = (
        anchored_lines > 0
        and coverage >= 0.80
        and monotonic
        and "excessive_duplicate_timestamps" not in issues
    )

    return {
        "is_synced": is_synced,
        "total_lines": total_lines,
        "anchored_lines": anchored_lines,
        "coverage": round(coverage, 4),
        "monotonic": monotonic,
        "duplicate_timestamps": duplicate_timestamps,
        "max_gap_seconds": round(max_gap, 3),
        "anomalous_gaps": anomalous_gaps,
        "issues": issues,
    }


def is_synced_lrc(lrc_content: Optional[str]) -> bool:
    """Returns True if the LRC content passes full multi-dimensional validation."""
    return validate_synced_lrc(lrc_content)["is_synced"]


def inspect_reference_anchors(reference_lines: List[ReferenceLine]) -> Dict[str, Any]:
    """
    Inspects parsed ReferenceLine objects to determine anchor coverage and mode:
    - coverage >= 0.8 -> 'anchored'
    - 0 < coverage < 0.8 -> 'partial'
    - coverage == 0 -> 'plain'
    """
    total_lines = len(reference_lines)
    if total_lines == 0:
        return {
            "total_lines": 0,
            "anchored_lines": 0,
            "coverage": 0.0,
            "has_line_anchors": False,
            "anchor_mode": "plain",
        }

    anchored_lines = sum(1 for l in reference_lines if l.start_anchor is not None)
    coverage = anchored_lines / total_lines
    has_anchors = (anchored_lines > 0)

    if coverage >= 0.8:
        mode = "anchored"
    elif coverage > 0.0:
        mode = "partial"
    else:
        mode = "plain"

    return {
        "total_lines": total_lines,
        "anchored_lines": anchored_lines,
        "coverage": round(coverage, 4),
        "has_line_anchors": has_anchors,
        "anchor_mode": mode,
    }
