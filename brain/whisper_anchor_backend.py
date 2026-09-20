"""
WhisperAnchorBackend: Approximate ASR-anchor lyrics alignment using single-pass faster-whisper
and Global Window-Constrained Sequence Dynamic Programming.

Note: WhisperAnchorBackend is strictly an approximate ASR-anchor aligner, NOT a forced aligner (CTC/HMM).
It never assigns quality="exact".

Strictly preserves reference text integrity. Whisper never modifies reference words, casing, or punctuation.
"""

import os
import logging
import librosa
from typing import List, Optional, Tuple, Dict, Any
from rapidfuzz import fuzz

from alignment_types import (
    NormalizedToken,
    ReferenceLine,
    AlignedWord,
    AlignedLine,
    AlignmentResult,
    AlignmentBackend,
)
from lyrics_normalizer import normalize_value_for_matching
from alignment.model_cache import get_whisper_model

logger = logging.getLogger(__name__)


class WhisperAnchorBackend(AlignmentBackend):
    """
    Approximate ASR-anchor alignment backend using single full-pass faster-whisper
    and Global Window-Constrained Sequence Dynamic Programming.

    Guarantees:
    - Single-use of Whisper words (no duplicate assignments across overlapping windows)
    - Strict global monotonic order
    - Resolution of window overlaps through global DP backtracking
    - Honest classification: quality is always 'approximate', 'line_fallback', or 'degraded' (never 'exact')
    """

    # Matching penalties & rewards
    MATCH_EXACT_REWARD = 2.5
    REF_GAP_PENALTY = -1.0         # Reference word missing in audio / Whisper
    WHISPER_GAP_PENALTY = -0.35    # Hallucinated extra Whisper word
    SUBSTITUTION_PENALTY = -1.8

    # Timing bounds
    PRE_ROLL = 1.0                 # Seconds before line start anchor
    SAFETY_GAP = 0.20              # Seconds before next line anchor
    MAX_LINE_GAP = 8.0             # Max gap between lines before treating as instrumental pause
    MAX_WORD_DURATION = 3.5        # Outlier duration threshold
    MIN_WORD_DURATION = 0.08       # Minimum physical articulation duration (80ms)
    MIN_INTERPOLATION_GAP = 0.16   # Minimum physical gap to allow interpolation
    MAX_INTERPOLATION_GAP = 4.5    # Max gap allowed for interpolation (otherwise instrumental pause)
    MAX_GAP_PER_WORD = 1.2         # Max duration allocated per missing word in interpolation

    def __init__(self, mode: str = "fast", condition_on_previous_text: bool = False):
        self.mode = mode
        self.condition_on_previous_text = condition_on_previous_text

    def _global_sequence_dp(
        self,
        flat_ref_tokens: List[Dict[str, Any]],
        raw_whisper_words: List[Dict[str, Any]],
    ) -> Tuple[List[Tuple[int, Optional[int], float]], int]:
        """
        Runs Global Window-Constrained Sequence Dynamic Programming over all reference tokens
        and all Whisper words from the full pass.

        Ensures:
        - Exactly one Whisper word can be assigned to at most one reference token (single-use)
        - Strictly monotonic progression
        - Window-based scoring: zero penalty inside line window, quadratic penalty outside
        - Global optimal resolution of overlapping window boundaries

        Returns:
            aligned_pairs: List of (token_idx, whisper_idx or None, score)
            temporal_violations: count of candidate matches rejected by temporal constraint
        """
        N = len(flat_ref_tokens)
        M = len(raw_whisper_words)

        if N == 0:
            return [], 0
        if M == 0:
            return [(i, None, 0.0) for i in range(N)], 0

        dp = [[0.0] * (M + 1) for _ in range(N + 1)]
        backtrack = [[0] * (M + 1) for _ in range(N + 1)]

        for i in range(1, N + 1):
            dp[i][0] = dp[i - 1][0] + self.REF_GAP_PENALTY
            backtrack[i][0] = 2  # ref gap (up)

        for j in range(1, M + 1):
            dp[0][j] = dp[0][j - 1] + self.WHISPER_GAP_PENALTY
            backtrack[0][j] = 3  # whisper gap (left)

        temporal_violations = 0

        for i in range(1, N + 1):
            tok_info = flat_ref_tokens[i - 1]
            ref_val = tok_info["norm_val"]
            w_start = tok_info["window_start"]
            w_end = tok_info["window_end"]
            t_exp = tok_info["expected_time"]
            line_dur = tok_info["line_dur"]

            for j in range(1, M + 1):
                cand = raw_whisper_words[j - 1]
                w_val = cand["norm_val"]
                w_mid = (cand["start"] + cand["end"]) / 2.0

                # 1. Text Score
                if ref_val == w_val:
                    text_score = self.MATCH_EXACT_REWARD
                else:
                    ratio = fuzz.ratio(ref_val, w_val) / 100.0
                    if ratio >= 0.75:
                        text_score = 2.0 * ratio - 0.5
                    else:
                        text_score = self.SUBSTITUTION_PENALTY

                # 2. Window-Constrained Temporal Penalty
                # Inside window [window_start, window_end]: penalty is 0 (plus weak tie-breaker only)
                # Long notes, melismas, and uneven articulation inside line window are NOT penalized!
                if w_start <= w_mid <= w_end:
                    tie_breaker = -0.05 * min(1.0, abs(w_mid - t_exp) / max(0.5, line_dur))
                    temp_penalty = tie_breaker
                else:
                    if w_mid < w_start:
                        dist = w_start - w_mid
                    else:
                        dist = w_mid - w_end
                    temp_penalty = -0.6 * min(4.0, dist) - 0.3 * (max(0.0, dist - 4.0) ** 2)
                    if text_score > 0 and dist > 2.0:
                        temporal_violations += 1

                total_cell_score = text_score + temp_penalty

                diag = dp[i - 1][j - 1] + total_cell_score
                up = dp[i - 1][j] + self.REF_GAP_PENALTY
                left = dp[i][j - 1] + self.WHISPER_GAP_PENALTY

                if diag >= up and diag >= left:
                    dp[i][j] = diag
                    backtrack[i][j] = 1
                elif up >= left:
                    dp[i][j] = up
                    backtrack[i][j] = 2
                else:
                    dp[i][j] = left
                    backtrack[i][j] = 3

        # Backtrack
        aligned_pairs: List[Tuple[int, Optional[int], float]] = []
        curr_i = N
        curr_j = M

        while curr_i > 0 or curr_j > 0:
            step = backtrack[curr_i][curr_j]
            if step == 1:
                ref_idx = curr_i - 1
                w_idx = curr_j - 1
                tok_info = flat_ref_tokens[ref_idx]
                cand = raw_whisper_words[w_idx]

                ref_val = tok_info["norm_val"]
                w_val = cand["norm_val"]
                w_mid = (cand["start"] + cand["end"]) / 2.0

                if ref_val == w_val:
                    sim = 1.0
                else:
                    sim = fuzz.ratio(ref_val, w_val) / 100.0

                # Validate plausible window: not a heavily penalized distant match
                in_plausible_window = (tok_info["window_start"] - 2.5) <= w_mid <= (tok_info["window_end"] + 3.0)
                if sim >= 0.75 and in_plausible_window:
                    aligned_pairs.append((ref_idx, w_idx, sim))
                else:
                    aligned_pairs.append((ref_idx, None, 0.0))
                curr_i -= 1
                curr_j -= 1
            elif step == 2:
                ref_idx = curr_i - 1
                aligned_pairs.append((ref_idx, None, 0.0))
                curr_i -= 1
            elif step == 3:
                curr_j -= 1
            else:
                break

        aligned_pairs.reverse()
        return aligned_pairs, temporal_violations

    def _interpolate_and_resolve_line(
        self,
        ref_tokens: List[NormalizedToken],
        alignment_for_line: List[Tuple[int, Optional[int], float]],
        raw_whisper_words: List[Dict[str, Any]],
        line_start_window: float,
        line_end_window: float,
    ) -> List[AlignedWord]:
        """
        Applies strict rules for word states:
        1. Direct matches -> 'matched', timestamp_source='whisper'
        2. Words before the first matched word -> 'unresolved' (do NOT participate in word wipe)
        3. Words after the last matched word -> 'unresolved' (do NOT participate in word wipe)
        4. Gaps strictly bounded between two matched words -> 'interpolated' IF gap is physically valid
        5. If gap is invalid (instrumental pause / negative gap) -> 'unresolved'
        """
        N = len(ref_tokens)
        aligned_words: List[Optional[AlignedWord]] = [None] * N

        # 1. Place confirmed acoustic matches
        for ref_in_line_idx, w_idx, score in alignment_for_line:
            if w_idx is not None:
                w = raw_whisper_words[w_idx]
                w_s = w["start"]
                w_e = max(w["end"], w_s + self.MIN_WORD_DURATION)
                tok = ref_tokens[ref_in_line_idx]
                aligned_words[ref_in_line_idx] = AlignedWord(
                    text=tok.original_text,
                    start=w_s,
                    end=w_e,
                    alignment="matched",
                    timestamp_source="whisper",
                    confidence=round(score, 2),
                    is_interpolated=False,
                    prefix=tok.prefix,
                    suffix=tok.suffix,
                )

        matched_indices = [idx for idx, w in enumerate(aligned_words) if w is not None]

        if not matched_indices:
            # Entire line has no acoustic matches: all words are unresolved
            dur = max(0.5, line_end_window - line_start_window)
            step = dur / max(1, N)
            for k, tok in enumerate(ref_tokens):
                t_s = line_start_window + k * step
                aligned_words[k] = AlignedWord(
                    text=tok.original_text,
                    start=t_s,
                    end=t_s + step,
                    alignment="unresolved",
                    timestamp_source="line_fallback",
                    confidence=None,
                    is_interpolated=False,
                    prefix=tok.prefix,
                    suffix=tok.suffix,
                )
            return [w for w in aligned_words if w is not None]

        first_matched_idx = matched_indices[0]
        last_matched_idx = matched_indices[-1]

        # 2. Words before the first matched word = unresolved
        if first_matched_idx > 0:
            first_m = aligned_words[first_matched_idx]
            t_bound = first_m.start
            est_step = min(0.3, max(self.MIN_WORD_DURATION, (t_bound - line_start_window) / first_matched_idx))
            cur_t = max(0.0, t_bound - first_matched_idx * est_step)
            for k in range(first_matched_idx):
                tok = ref_tokens[k]
                aligned_words[k] = AlignedWord(
                    text=tok.original_text,
                    start=cur_t,
                    end=cur_t + est_step,
                    alignment="unresolved",
                    timestamp_source="unresolved",
                    confidence=None,
                    is_interpolated=False,
                    prefix=tok.prefix,
                    suffix=tok.suffix,
                )
                cur_t += est_step

        # 3. Words after the last matched word = unresolved
        if last_matched_idx < N - 1:
            last_m = aligned_words[last_matched_idx]
            t_bound = last_m.end
            remaining = (N - 1) - last_matched_idx
            est_step = min(0.3, max(self.MIN_WORD_DURATION, (line_end_window - t_bound) / remaining))
            cur_t = t_bound
            for k in range(last_matched_idx + 1, N):
                tok = ref_tokens[k]
                aligned_words[k] = AlignedWord(
                    text=tok.original_text,
                    start=cur_t,
                    end=cur_t + est_step,
                    alignment="unresolved",
                    timestamp_source="unresolved",
                    confidence=None,
                    is_interpolated=False,
                    prefix=tok.prefix,
                    suffix=tok.suffix,
                )
                cur_t += est_step

        # 4. Gaps strictly bounded between two matched words
        i = first_matched_idx
        while i < last_matched_idx:
            if aligned_words[i] is None:
                gap_start_idx = i
                while i <= last_matched_idx and aligned_words[i] is None:
                    i += 1
                gap_end_idx = i  # exclusive

                prev_m = aligned_words[gap_start_idx - 1]
                next_m = aligned_words[gap_end_idx]
                gap_tokens = ref_tokens[gap_start_idx:gap_end_idx]
                gap_count = len(gap_tokens)

                t_a = prev_m.end
                t_b = next_m.start
                gap_duration = t_b - t_a

                is_gap_valid = (
                    gap_duration >= gap_count * self.MIN_WORD_DURATION
                    and gap_duration <= min(self.MAX_INTERPOLATION_GAP, gap_count * self.MAX_GAP_PER_WORD)
                )

                if is_gap_valid:
                    # Valid gap between confirmed matches -> interpolated
                    char_lengths = [max(1, len(t.value)) for t in gap_tokens]
                    sum_chars = sum(char_lengths)
                    cur_t = t_a
                    for k, tok in enumerate(gap_tokens):
                        w_dur = (char_lengths[k] / sum_chars) * gap_duration
                        aligned_words[gap_start_idx + k] = AlignedWord(
                            text=tok.original_text,
                            start=cur_t,
                            end=cur_t + w_dur,
                            alignment="interpolated",
                            timestamp_source="interpolated",
                            confidence=None,
                            is_interpolated=True,
                            prefix=tok.prefix,
                            suffix=tok.suffix,
                        )
                        cur_t += w_dur
                else:
                    # Invalid gap (too long = instrumental pause) -> unresolved
                    cur_t = t_a
                    w_step = max(self.MIN_WORD_DURATION, gap_duration / gap_count) if gap_duration > 0 else self.MIN_WORD_DURATION
                    for k, tok in enumerate(gap_tokens):
                        aligned_words[gap_start_idx + k] = AlignedWord(
                            text=tok.original_text,
                            start=cur_t,
                            end=cur_t + w_step,
                            alignment="unresolved",
                            timestamp_source="unresolved",
                            confidence=None,
                            is_interpolated=False,
                            prefix=tok.prefix,
                            suffix=tok.suffix,
                        )
                        cur_t += w_step
            else:
                i += 1

        result: List[AlignedWord] = [w for w in aligned_words if w is not None]
        return result

    def _validate_and_finalize_line(
        self,
        words: List[AlignedWord],
        reference_line: ReferenceLine,
    ) -> Tuple[List[AlignedWord], float, float, int, int, int, int]:
        """
        Validates line monotonicity, fixes technical overlaps, and checks for outliers.
        Guarantees:
        - word[i].start >= word[i-1].end
        - word[i].end > word[i].start
        - fixing an overlap NEVER creates a new overlap with neighboring words (introduced_overlaps == 0)

        Returns:
            words, line_start, line_end, raw_overlaps, fixed_overlaps, introduced_overlaps, outlier_intervals
        """
        if not words:
            start_t = reference_line.start_anchor or 0.0
            return [], start_t, start_t + 1.0, 0, 0, 0, 0

        # 1. Check outliers and clamp max duration
        outlier_intervals = 0
        for w in words:
            if w.end - w.start > self.MAX_WORD_DURATION:
                outlier_intervals += 1
                w.end = w.start + self.MAX_WORD_DURATION
            if w.end <= w.start:
                w.end = w.start + self.MIN_WORD_DURATION

        n = len(words)

        # 2. Track raw overlaps before any adjustments
        raw_overlaps = 0
        initially_overlapped = set()
        for k in range(n - 1):
            if words[k].end > words[k + 1].start + 1e-4:
                raw_overlaps += 1
                initially_overlapped.add(k)

        # 3. Form connected components (clusters) of words that overlap
        clusters: List[List[int]] = []
        curr: List[int] = [0]
        for k in range(1, n):
            if words[k - 1].end > words[k].start + 1e-4:
                curr.append(k)
            else:
                clusters.append(curr)
                curr = [k]
        clusters.append(curr)

        # 4. Resolve each cluster within its bounded slot to prevent cascading into neighbors
        min_line_left = max(0.0, reference_line.start_anchor - self.PRE_ROLL) if reference_line.start_anchor is not None else 0.0
        max_line_right = reference_line.next_anchor if reference_line.next_anchor is not None else (words[-1].end + 5.0)

        for cluster in clusters:
            c_len = len(cluster)
            first_idx = cluster[0]
            last_idx = cluster[-1]

            # Left bound is the end of the preceding non-overlapping word (or line start)
            bound_l = min_line_left if first_idx == 0 else words[first_idx - 1].end
            # Right bound is the start of the succeeding non-overlapping word (or line end)
            bound_r = max_line_right if last_idx == n - 1 else words[last_idx + 1].start

            if bound_r <= bound_l + 1e-4:
                bound_r = bound_l + (c_len * self.MIN_WORD_DURATION)

            des_start = words[first_idx].start
            des_end = words[last_idx].end
            needed_span = c_len * self.MIN_WORD_DURATION

            curr_span = des_end - des_start
            if curr_span < needed_span:
                deficit = needed_span - curr_span
                avail_l = max(0.0, des_start - bound_l)
                avail_r = max(0.0, bound_r - des_end)
                take_l = min(avail_l, deficit / 2.0)
                take_r = min(avail_r, deficit - take_l)
                rem = deficit - (take_l + take_r)
                if rem > 0 and avail_l > take_l:
                    extra_l = min(avail_l - take_l, rem)
                    take_l += extra_l
                    rem -= extra_l
                if rem > 0 and avail_r > take_r:
                    extra_r = min(avail_r - take_r, rem)
                    take_r += extra_r
                des_start -= take_l
                des_end += take_r

            des_start = max(bound_l, des_start)
            des_end = min(bound_r, max(des_start + 1e-3, des_end))
            total_span = max(1e-3, des_end - des_start)

            if c_len == 1:
                dur = max(self.MIN_WORD_DURATION, words[first_idx].end - words[first_idx].start)
                words[first_idx].start = max(bound_l, des_start)
                words[first_idx].end = min(bound_r, words[first_idx].start + dur)
                if words[first_idx].end <= words[first_idx].start:
                    words[first_idx].end = words[first_idx].start + self.MIN_WORD_DURATION
            else:
                step = total_span / c_len
                for idx_in_c, w_i in enumerate(cluster):
                    words[w_i].start = des_start + (idx_in_c * step)
                    words[w_i].end = words[w_i].start + step

        # 5. Strictly enforce positive durations and monotonicity
        for k in range(n - 1):
            if words[k].end > words[k + 1].start:
                words[k].end = words[k + 1].start
            if words[k].end <= words[k].start:
                words[k].end = words[k].start + 1e-3

        if n > 0 and words[-1].end <= words[-1].start:
            words[-1].end = words[-1].start + 1e-3

        # 6. Verify and calculate metrics
        fixed_overlaps = 0
        introduced_overlaps = 0
        for k in range(n - 1):
            if words[k].end > words[k + 1].start + 1e-4:
                if k not in initially_overlapped:
                    introduced_overlaps += 1
            else:
                if k in initially_overlapped:
                    fixed_overlaps += 1

        for idx in range(n - 1):
            assert words[idx].end > words[idx].start, f"Word {idx} duration non-positive"
            assert words[idx + 1].start >= words[idx].end - 1e-4, f"Overlap remains between {idx} and {idx+1}"
        if words:
            assert words[-1].end > words[-1].start, "Last word duration non-positive"

        line_start = reference_line.start_anchor if reference_line.start_anchor is not None else (words[0].start if words else 0.0)
        line_end = reference_line.next_anchor if reference_line.next_anchor is not None else (words[-1].end if words else line_start + 1.0)

        return words, line_start, line_end, raw_overlaps, fixed_overlaps, introduced_overlaps, outlier_intervals

    def align(
        self,
        audio_path: str,
        reference_lines: List[ReferenceLine],
        language: Optional[str] = None,
        mode: Optional[str] = None,
        condition_on_previous_text: Optional[bool] = None,
    ) -> AlignmentResult:
        """
        Executes single full-pass faster-whisper inference on the audio file
        followed by Global Window-Constrained Sequence DP.
        """
        if not os.path.isfile(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        run_mode = mode or self.mode
        cond_prev = condition_on_previous_text if condition_on_previous_text is not None else self.condition_on_previous_text

        total_lines_count = len(reference_lines)
        anchored_lines_count = sum(1 for line in reference_lines if line.start_anchor is not None)
        anchor_coverage = (anchored_lines_count / total_lines_count) if total_lines_count > 0 else 0.0
        has_line_anchors = (anchored_lines_count > 0)

        if not reference_lines:
            return AlignmentResult(
                backend="whisper_anchor",
                quality="approximate",
                language=language or "ru",
                lines=[],
                stats={"total_reference_words": 0, "matched_words": 0, "anchor_coverage": 0.0},
                has_line_anchors=False,
                anchored_lines_count=0,
                total_lines_count=0,
                anchor_coverage=0.0,
            )

        # Enforce zero-anchor rejection: do NOT run anchored alignment if zero anchors exist
        if anchored_lines_count == 0:
            logger.warning("align() called with zero line anchors: rejecting anchored alignment, returning line fallback.")
            fallback_lines = []
            for l in reference_lines:
                unanchored_words = [
                    AlignedWord(
                        text=tok.original_text,
                        start=None,
                        end=None,
                        alignment="unresolved",
                        timestamp_source="unanchored",
                        prefix=tok.prefix,
                        suffix=tok.suffix,
                    )
                    for tok in l.tokens
                ]
                fallback_lines.append(
                    AlignedLine(
                        text=l.original_text,
                        start=0.0,
                        end=0.0,
                        language=l.language or "ru",
                        words=unanchored_words,
                        quality="line_fallback",
                        word_timing_available=False,
                        timestamp_source="unanchored",
                        line_fallback_words=len(unanchored_words),
                        unresolved_words=0,
                        unresolved_rate=1.0 if unanchored_words else 0.0,
                    )
                )
            return AlignmentResult(
                backend="whisper_anchor",
                quality="line_fallback",
                language=language or "ru",
                lines=fallback_lines,
                stats={
                    "reference_words_count": sum(len(l.tokens) for l in reference_lines),
                    "matched_words": 0,
                    "anchor_coverage": 0.0,
                    "has_line_anchors": False,
                    "anchored_lines_count": 0,
                    "total_lines_count": total_lines_count,
                    "reason": "zero_line_anchors",
                },
                has_line_anchors=False,
                anchored_lines_count=0,
                total_lines_count=total_lines_count,
                anchor_coverage=0.0,
            )

        # 1. Load audio
        logger.info(f"Loading audio for single full-pass inference: {audio_path}")
        audio_arr, sr = librosa.load(audio_path, sr=16000, mono=True)
        audio_duration = len(audio_arr) / sr

        # 2. Whisper Model and Inference parameters
        beam_size = 5 if run_mode == "quality" else 1
        model_name = "large-v3-turbo"
        model = get_whisper_model(model_name)

        clean_req_lang = None
        if language and language.lower() not in ("auto", "none", "mixed"):
            clean_req_lang = language.lower()

        logger.info(
            f"Starting single full-pass Whisper: mode={run_mode}, beam_size={beam_size}, "
            f"lang={clean_req_lang}, condition_on_prev={cond_prev}"
        )

        segments, info = model.transcribe(
            audio_arr,
            word_timestamps=True,
            temperature=0,
            beam_size=beam_size,
            condition_on_previous_text=cond_prev,
            language=clean_req_lang,
            vad_filter=False,
        )

        # Collect global list of Whisper words with probabilities
        raw_whisper_words: List[Dict[str, Any]] = []
        for s in segments:
            if s.words:
                for w in s.words:
                    w_str = w.word.strip()
                    if not w_str:
                        continue
                    norm_v = normalize_value_for_matching(w_str)
                    if not norm_v:
                        continue
                    prob = getattr(w, "probability", None)
                    if prob is not None and not isinstance(prob, (int, float)):
                        prob = None
                    raw_whisper_words.append({
                        "original": w_str,
                        "norm_val": norm_v,
                        "start": float(w.start),
                        "end": float(w.end),
                        "probability": float(prob) if prob is not None else None,
                    })

        whisper_raw_count = len(raw_whisper_words)
        logger.info(f"Single pass complete: generated {whisper_raw_count} raw Whisper words.")

        # 3. Build flattened reference tokens with window metadata
        flat_ref_tokens: List[Dict[str, Any]] = []
        line_token_spans: List[Tuple[int, int]] = []  # (start_flat_idx, end_flat_idx) for each line
        line_window_bounds: List[Tuple[float, float, float]] = [] # (w_start, w_end, line_dur)

        for line_idx, line in enumerate(reference_lines):
            tokens = line.tokens
            num_tokens = len(tokens)
            if num_tokens == 0 or line.start_anchor is None:
                line_token_spans.append((len(flat_ref_tokens), len(flat_ref_tokens)))
                line_window_bounds.append((0.0, 0.0, 0.0))
                continue

            line_start_anchor = line.start_anchor
            next_anchor = line.next_anchor

            w_start = max(0.0, line_start_anchor - self.PRE_ROLL)
            if next_anchor is not None and next_anchor - line_start_anchor <= self.MAX_LINE_GAP:
                w_end = min(audio_duration, next_anchor - self.SAFETY_GAP)
            else:
                est_dur = min(7.0, max(2.5, num_tokens * 0.45))
                w_end = min(audio_duration, line_start_anchor + est_dur)

            if w_end <= w_start:
                w_end = min(audio_duration, w_start + 2.0)

            line_dur = max(0.5, w_end - w_start)
            line_window_bounds.append((w_start, w_end, line_dur))

            start_span = len(flat_ref_tokens)
            for k, tok in enumerate(tokens):
                t_exp = line_start_anchor + ((k + 0.5) / num_tokens) * line_dur
                flat_ref_tokens.append({
                    "line_idx": line_idx,
                    "tok_idx_in_line": k,
                    "norm_val": tok.value,
                    "original_text": tok.original_text,
                    "window_start": w_start,
                    "window_end": w_end,
                    "line_dur": line_dur,
                    "expected_time": t_exp,
                })
            end_span = len(flat_ref_tokens)
            line_token_spans.append((start_span, end_span))

        # 4. Run Global Window-Constrained Sequence DP
        # Ensures: single-use of Whisper words, global monotonic order, resolution of window overlap
        aligned_pairs, total_temporal_violations = self._global_sequence_dp(
            flat_ref_tokens,
            raw_whisper_words,
        )

        dp_alignment_pairs_count = len(flat_ref_tokens) * len(raw_whisper_words)
        raw_matched_ref_count = sum(1 for _, w_idx, _ in aligned_pairs if w_idx is not None)

        # 5. Process lines and apply strict word status and line fallback rules
        total_ref_words = sum(len(line.tokens) for line in reference_lines)
        total_raw_overlaps = 0
        total_fixed_overlaps = 0
        total_introduced_overlaps = 0
        total_outlier_intervals = 0

        aligned_lines: List[AlignedLine] = []

        for line_idx, line in enumerate(reference_lines):
            start_span, end_span = line_token_spans[line_idx]
            if start_span == end_span:
                start_anchor = line.start_anchor or 0.0
                end_anchor = line.next_anchor or (start_anchor + 2.0)
                unanchored_words = [
                    AlignedWord(
                        text=tok.original_text,
                        start=None,
                        end=None,
                        alignment="unresolved",
                        timestamp_source="unanchored",
                        prefix=tok.prefix,
                        suffix=tok.suffix,
                    )
                    for tok in line.tokens
                ]
                aligned_lines.append(
                    AlignedLine(
                        start=start_anchor,
                        end=end_anchor,
                        language=line.language or "ru",
                        text=line.original_text,
                        quality="line_fallback",
                        word_timing_available=False,
                        timestamp_source="unanchored",
                        words=unanchored_words,
                        line_fallback_words=len(unanchored_words),
                        unresolved_words=0,
                        unresolved_rate=1.0 if unanchored_words else 0.0,
                    )
                )
                continue

            num_tokens = len(line.tokens)
            w_start, w_end, line_dur = line_window_bounds[line_idx]

            # Slice pairs for this line
            line_pairs = aligned_pairs[start_span:end_span]
            line_alignment: List[Tuple[int, Optional[int], float]] = []

            for flat_idx, (r_idx, w_idx, score) in enumerate(line_pairs):
                tok_in_line_idx = flat_idx
                line_alignment.append((tok_in_line_idx, w_idx, score))

            # Interpolate and mark unresolved words
            words = self._interpolate_and_resolve_line(
                line.tokens,
                line_alignment,
                raw_whisper_words,
                line_start_window=w_start,
                line_end_window=w_end,
            )

            # Validate and fix monotonicity
            (
                validated_words,
                l_start,
                l_end,
                raw_ov,
                fixed_ov,
                intro_ov,
                outlier_iv,
            ) = self._validate_and_finalize_line(words, line)

            total_raw_overlaps += raw_ov
            total_fixed_overlaps += fixed_ov
            total_introduced_overlaps += intro_ov
            total_outlier_intervals += outlier_iv

            unresolved_in_line_raw = sum(1 for w in validated_words if w.alignment == "unresolved")

            # Line-level fallback rule:
            # If line has > 50% unresolved words, line cannot support word wipe!
            if (unresolved_in_line_raw / len(validated_words)) > 0.50:
                line_quality = "line_fallback"
                word_timing_avail = False
                ts_source = "line_fallback"
                # Words in line_fallback lines carry technical fallback timestamps only
                # They are alignment="unresolved", timestamp_source="line_fallback", confidence=None
                for w in validated_words:
                    w.alignment = "unresolved"
                    w.timestamp_source = "line_fallback"
                    w.confidence = None
                    w.is_interpolated = False

                matched_in_line = 0
                interpolated_in_line = 0
                unresolved_in_line = 0
                line_fallback_in_line = len(validated_words)
                unresolved_rate = 1.0
                conf = 0.0
            else:
                line_quality = "approximate"  # Strictly 'approximate', never 'exact'
                word_timing_avail = True
                ts_source = "whisper"
                matched_in_line = sum(1 for w in validated_words if w.alignment == "matched")
                interpolated_in_line = sum(1 for w in validated_words if w.alignment == "interpolated")
                unresolved_in_line = sum(1 for w in validated_words if w.alignment == "unresolved")
                line_fallback_in_line = 0
                unresolved_rate = unresolved_in_line / len(validated_words)
                conf = matched_in_line / len(validated_words)

            aligned_lines.append(
                AlignedLine(
                    text=line.original_text,
                    start=l_start,
                    end=l_end,
                    language=line.language or "ru",
                    words=validated_words,
                    quality=line_quality,
                    word_timing_available=word_timing_avail,
                    timestamp_source=ts_source,
                    confidence=round(conf, 2),
                    matched_words=matched_in_line,
                    interpolated_words=interpolated_in_line,
                    unresolved_words=unresolved_in_line,
                    line_fallback_words=line_fallback_in_line,
                    unresolved_rate=round(unresolved_rate, 2),
                )
            )

        # 6. Global stats strictly calculated from finalized lines
        total_matched_words = sum(l.matched_words for l in aligned_lines)
        total_interpolated_words = sum(l.interpolated_words for l in aligned_lines)
        total_unresolved_words = sum(l.unresolved_words for l in aligned_lines)
        total_line_fallback_words = sum(l.line_fallback_words for l in aligned_lines)
        total_line_fallback_count = sum(1 for l in aligned_lines if not l.word_timing_available)

        # Strict partition check
        assert total_ref_words == (
            total_matched_words + total_interpolated_words + total_unresolved_words + total_line_fallback_words
        ), f"Word partition mismatch: {total_ref_words} != {total_matched_words} + {total_interpolated_words} + {total_unresolved_words} + {total_line_fallback_words}"

        # 7. Confirmed matched Whisper words (ONLY from non-downgraded lines)
        final_matched_whisper_indices = set()
        final_matched_probabilities: List[float] = []
        anchor_deviation_accum: List[float] = []

        for line_idx, line in enumerate(aligned_lines):
            if not line.word_timing_available:
                continue
            start_span, end_span = line_token_spans[line_idx]
            line_pairs = aligned_pairs[start_span:end_span]
            for k, w in enumerate(line.words):
                if w.alignment == "matched" and w.timestamp_source == "whisper":
                    r_idx, w_idx, score = line_pairs[k]
                    if w_idx is not None:
                        final_matched_whisper_indices.add(w_idx)
                        prob = raw_whisper_words[w_idx].get("probability")
                        if prob is not None:
                            final_matched_probabilities.append(prob)
                        w_start = raw_whisper_words[w_idx]["start"]
                        t_exp = flat_ref_tokens[start_span + k]["expected_time"]
                        anchor_deviation_accum.append(abs(w_start - t_exp))

        matched_whisper_count = len(final_matched_whisper_indices)
        rejected_whisper_count = whisper_raw_count - matched_whisper_count

        mean_whisper_prob = (
            round(sum(final_matched_probabilities) / len(final_matched_probabilities), 3)
            if final_matched_probabilities
            else None
        )

        anchor_deviation_ms = (
            round((sum(anchor_deviation_accum) / len(anchor_deviation_accum)) * 1000.0, 1)
            if anchor_deviation_accum
            else None
        )

        # 8. Distinct rate metrics
        # Raw text match rate before line-level fallback
        text_match_rate = round((raw_matched_ref_count / total_ref_words * 100), 1) if total_ref_words > 0 else 0.0
        # Final word-level match rate after line-level fallback
        final_word_level_match_rate = round((total_matched_words / total_ref_words * 100), 1) if total_ref_words > 0 else 0.0
        interpolated_rate = round((total_interpolated_words / total_ref_words * 100), 1) if total_ref_words > 0 else 0.0
        unresolved_rate = round((total_unresolved_words / total_ref_words * 100), 1) if total_ref_words > 0 else 0.0
        line_fallback_rate = round((total_line_fallback_words / total_ref_words * 100), 1) if total_ref_words > 0 else 0.0
        alignment_confidence = round(total_matched_words / total_ref_words, 2) if total_ref_words > 0 else 0.0

        # Language rollup
        line_langs = [l.language for l in aligned_lines]
        if all(lang == "ru" for lang in line_langs):
            track_lang = "ru"
        elif all(lang == "en" for lang in line_langs):
            track_lang = "en"
        elif any(lang == "ru" for lang in line_langs) and any(lang == "en" for lang in line_langs):
            track_lang = "mixed"
        else:
            track_lang = clean_req_lang or "ru"

        # Strictly approximate / line_fallback / degraded (never 'exact')
        if anchor_coverage == 0.0:
            overall_quality = "line_fallback"
        elif anchor_coverage < 0.80 or final_word_level_match_rate < 50.0 or (total_line_fallback_count / max(1, len(aligned_lines))) >= 0.50:
            overall_quality = "degraded"
        else:
            overall_quality = "approximate"

        return AlignmentResult(
            version=1,
            backend="whisper_anchor",
            quality=overall_quality,
            language=track_lang,
            confidence=alignment_confidence,
            lines=aligned_lines,
            stats={
                "reference_words_count": total_ref_words,
                "whisper_raw_words_count": whisper_raw_count,
                "matched_words": total_matched_words,
                "interpolated_words": total_interpolated_words,
                "unresolved_words": total_unresolved_words,
                "line_fallback_words": total_line_fallback_words,
                "line_fallback_count": total_line_fallback_count,
                "text_match_rate_pct": text_match_rate,
                "final_word_level_match_rate_pct": final_word_level_match_rate,
                "interpolation_rate_pct": interpolated_rate,
                "unresolved_rate_pct": unresolved_rate,
                "line_fallback_rate_pct": line_fallback_rate,
                "alignment_confidence": alignment_confidence,
                "mean_whisper_probability": mean_whisper_prob,
                "anchor_deviation_ms": anchor_deviation_ms,
                "manual_timing_mae_ms": None,  # Ground truth MAE (null until manual verification phase)
                "raw_overlaps": total_raw_overlaps,
                "fixed_overlaps": total_fixed_overlaps,
                "introduced_overlaps": total_introduced_overlaps,
                "outlier_intervals": total_outlier_intervals,
                "dp_alignment_pairs": dp_alignment_pairs_count,
                "matched_whisper_words": matched_whisper_count,
                "rejected_whisper_words": rejected_whisper_count,
                "temporal_constraint_violations": total_temporal_violations,
                "condition_on_previous_text": cond_prev,
                "mode": run_mode,
                "has_line_anchors": has_line_anchors,
                "anchored_lines_count": anchored_lines_count,
                "total_lines_count": total_lines_count,
                "anchor_coverage": round(anchor_coverage, 4),
            },
            has_line_anchors=has_line_anchors,
            anchored_lines_count=anchored_lines_count,
            total_lines_count=total_lines_count,
            anchor_coverage=round(anchor_coverage, 4),
        )
