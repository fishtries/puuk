"""
Core data types and interfaces for lyrics forced alignment and karaoke in Puuk.
Strictly preserves reference text integrity while decoupling alignment backends.
"""

from typing import Protocol, Optional, List, Dict, Any
from dataclasses import dataclass, field


@dataclass
class NormalizedToken:
    """
    A single word token normalized for acoustic/phonetic matching,
    with an exact slice pointing back to the immutable reference text.
    Punctuation, brackets, quotes, and whitespace are captured in prefix and suffix.
    """
    value: str            # Normalized value (lowercase, ё->е, stripped of quotes/dashes)
    original_text: str    # Verbatim acoustic word without punctuation
    original_start: int   # Start character index of acoustic word in reference line
    original_end: int     # End character index of acoustic word in reference line
    prefix: str = ""      # Leading punctuation/brackets immediately before this word
    suffix: str = ""      # Trailing punctuation/brackets/whitespace after this word


@dataclass
class ReferenceLine:
    """
    An immutable line from reference lyrics (ID3 tag, LRCLIB, syncedlyrics, or manual).
    """
    original_text: str
    start_anchor: Optional[float]  # Timestamp in seconds from LRC [MM:SS.mmm], if available
    next_anchor: Optional[float]   # Timestamp in seconds of succeeding line, if available
    tokens: List[NormalizedToken]
    line_index: int
    language: Optional[str] = None # 'ru', 'en', 'mixed'


@dataclass
class AlignedWord:
    """
    An aligned word with strictly validated start/end timestamps and original text.
    Explicitly tracks alignment state, timestamp source, and surrounding punctuation fragments.
    """
    text: str                       # Verbatim acoustic word (without punctuation)
    start: float                    # Start time in seconds
    end: float                      # End time in seconds
    alignment: str = "matched"      # 'matched' | 'interpolated' | 'unresolved'
    timestamp_source: str = "whisper" # 'whisper' | 'interpolated' | 'line_fallback' | 'unresolved'
    confidence: Optional[float] = None
    is_interpolated: bool = False   # Backwards-compatibility helper (True only if alignment == 'interpolated')
    prefix: str = ""                # Leading punctuation/brackets
    suffix: str = ""                # Trailing punctuation/brackets/whitespace


@dataclass
class AlignedLine:
    """
    A lyric line containing validated AlignedWord objects.
    Explicitly tracks whether word-level timing is valid or downgraded to line-level fallback.
    """
    text: str                       # Verbatim original text of the line
    start: float                    # Line start time in seconds
    end: float                      # Line end time in seconds
    language: str                   # 'ru', 'en', 'mixed'
    words: List[AlignedWord]
    quality: str = "approximate"    # 'approximate' | 'line_fallback' | 'degraded' | 'failed' (never 'exact' for WhisperAnchor)
    word_timing_available: bool = True # False if line fell back to line-level timing
    timestamp_source: str = "whisper" # 'whisper' | 'interpolated' | 'line_fallback' | 'unresolved'
    confidence: Optional[float] = None
    matched_words: int = 0
    interpolated_words: int = 0
    unresolved_words: int = 0
    line_fallback_words: int = 0
    unresolved_rate: float = 0.0


@dataclass
class AlignmentResult:
    """
    Final result of the alignment process ready for JSON serialization.
    """
    version: int = 1
    backend: str = "whisper_anchor"
    quality: str = "approximate"    # 'approximate' | 'line_fallback' | 'degraded' | 'failed' (never 'exact' for WhisperAnchor)
    language: str = "ru"
    confidence: Optional[float] = None
    lines: List[AlignedLine] = field(default_factory=list)
    stats: Dict[str, Any] = field(default_factory=dict)
    reference_source: str = ""
    has_line_anchors: bool = False
    anchored_lines_count: int = 0
    total_lines_count: int = 0
    anchor_coverage: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "backend": self.backend,
            "quality": self.quality,
            "language": self.language,
            "confidence": self.confidence,
            "reference_source": self.reference_source,
            "has_line_anchors": self.has_line_anchors,
            "anchored_lines_count": self.anchored_lines_count,
            "total_lines_count": self.total_lines_count,
            "anchor_coverage": round(self.anchor_coverage, 4),
            "lines": [
                {
                    "start": round(line.start, 3),
                    "end": round(line.end, 3),
                    "language": line.language,
                    "text": line.text,
                    "quality": line.quality,
                    "word_timing_available": line.word_timing_available,
                    "timestamp_source": line.timestamp_source,
                    "confidence": round(line.confidence, 2) if line.confidence is not None else None,
                    "matched_words": line.matched_words,
                    "interpolated_words": line.interpolated_words,
                    "unresolved_words": line.unresolved_words,
                    "line_fallback_words": line.line_fallback_words,
                    "unresolved_rate": round(line.unresolved_rate, 2),
                    "words": [
                        {
                            "text": word.text,
                            "start": round(word.start, 3) if word.start is not None else None,
                            "end": round(word.end, 3) if word.end is not None else None,
                            "alignment": word.alignment,
                            "timestamp_source": word.timestamp_source,
                            "confidence": round(word.confidence, 2) if word.confidence is not None else None,
                            "is_interpolated": word.is_interpolated,
                            "prefix": word.prefix,
                            "suffix": word.suffix,
                        }
                        for word in line.words
                    ],
                }
                for line in self.lines
            ],
            "stats": self.stats,
        }


class AlignmentBackend(Protocol):
    """
    Protocol defining an alignment backend.
    Enables swapping between WhisperAnchorBackend, CtcAlignmentBackend, etc.
    """
    def align(
        self,
        audio_path: str,
        reference_lines: List[ReferenceLine],
        language: Optional[str] = None,
        mode: str = "fast",
        condition_on_previous_text: bool = False,
    ) -> AlignmentResult:
        ...
