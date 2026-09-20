import type {
  LineDisplayMode,
  LyricsLine,
  LyricsWord,
  WordAlignment,
  WordLyricsLineDTO,
  WordLyricsPayload,
  WordLyricsPayloadDTO,
  WordLyricsWordDTO,
  WordTimestampSource,
} from '../types/track';

/**
 * Type guard ensuring a word is safe to animate in the word wipe loop.
 * Guarantees that:
 * - word is non-null
 * - startTime and endTime are valid numbers and not NaN
 * - endTime > startTime
 * - word is NOT unresolved
 * - timestampSource is NOT line_fallback and NOT unresolved
 */
export function canAnimateWord(
  word: LyricsWord | null | undefined
): word is LyricsWord & { startTime: number; endTime: number } {
  if (!word) return false;
  if (typeof word.startTime !== 'number' || typeof word.endTime !== 'number') return false;
  if (Number.isNaN(word.startTime) || Number.isNaN(word.endTime)) return false;
  if (word.endTime <= word.startTime) return false;
  if (word.alignment === 'unresolved') return false;
  if (word.timestampSource === 'line_fallback' || word.timestampSource === 'unresolved') return false;
  return true;
}

/**
 * Type guard ensuring a word can be clicked to seek audio.
 * Guarantees that:
 * - word is non-null
 * - startTime is a valid number and not NaN
 * - word is NOT unresolved
 * - timestampSource is NOT line_fallback and NOT unresolved
 */
export function canSeekToWord(
  word: LyricsWord | null | undefined
): word is LyricsWord & { startTime: number } {
  if (!word) return false;
  if (typeof word.startTime !== 'number') return false;
  if (Number.isNaN(word.startTime)) return false;
  if (word.alignment === 'unresolved') return false;
  if (word.timestampSource === 'line_fallback' || word.timestampSource === 'unresolved') return false;
  return true;
}

/**
 * Maps a single backend word DTO to the frontend domain LyricsWord model.
 * Performs explicit null/undefined/NaN sanitization without masking null under 0.
 * Preserves leading prefix and trailing suffix punctuation/separators.
 */
export function mapWordDTO(dto: WordLyricsWordDTO): LyricsWord {
  const rawStart = typeof dto.start === 'number' && !Number.isNaN(dto.start) ? dto.start : null;
  const rawEnd = typeof dto.end === 'number' && !Number.isNaN(dto.end) ? dto.end : null;

  let alignment: WordAlignment = 'matched';
  if (dto.alignment === 'unresolved' || dto.timestamp_source === 'unresolved') {
    alignment = 'unresolved';
  } else if (dto.alignment === 'interpolated' || dto.timestamp_source === 'interpolated' || dto.is_interpolated) {
    alignment = 'interpolated';
  }

  let timestampSource: WordTimestampSource = 'whisper';
  if (dto.timestamp_source === 'line_fallback') {
    timestampSource = 'line_fallback';
  } else if (dto.timestamp_source === 'unresolved' || alignment === 'unresolved') {
    timestampSource = 'unresolved';
  } else if (dto.timestamp_source === 'interpolated' || alignment === 'interpolated') {
    timestampSource = 'interpolated';
  }

  const confidence = typeof dto.confidence === 'number' && !Number.isNaN(dto.confidence)
    ? dto.confidence
    : null;

  const isInterpolated = Boolean(dto.is_interpolated || alignment === 'interpolated' || timestampSource === 'interpolated');

  return {
    text: dto.text || '',
    startTime: rawStart,
    endTime: rawEnd,
    alignment,
    timestampSource,
    confidence,
    isInterpolated,
    prefix: dto.prefix || '',
    suffix: dto.suffix || '',
  };
}

/**
 * Maps a single backend line DTO to the frontend domain LyricsLine model.
 * Enforces frontend display policy without mutating backend alignment states:
 * - line_fallback or word_timing_available === false -> displayMode = 'line'
 * - unresolvedRate >= 0.20 -> displayMode = 'line'
 * - otherwise -> displayMode = 'word'
 *
 * Rejects invalid line start (does not mask null/NaN as 0).
 */
export function mapLineDTO(dto: WordLyricsLineDTO): LyricsLine | null {
  if (typeof dto.start !== 'number' || Number.isNaN(dto.start) || dto.start < 0) {
    return null;
  }

  const lineStart = dto.start;
  const lineEnd = typeof dto.end === 'number' && !Number.isNaN(dto.end) ? dto.end : undefined;

  const words = Array.isArray(dto.words)
    ? dto.words.map(mapWordDTO)
    : undefined;

  const totalWords = words ? words.length : 0;
  let unresolvedCount = 0;
  if (words) {
    for (const w of words) {
      if (w.alignment === 'unresolved' || w.timestampSource === 'unresolved' || w.startTime === null) {
        unresolvedCount++;
      }
    }
  }

  const unresolvedRate = totalWords > 0 ? unresolvedCount / totalWords : 0;
  const isExplicitFallback = dto.quality === 'line_fallback' || dto.word_timing_available === false;
  const wordTimingAvailable = !isExplicitFallback && totalWords > 0;

  // Frontend display policy:
  // - line_fallback or word_timing_available === false -> displayMode = 'line'
  // - unresolvedRate >= 0.20 -> displayMode = 'line'
  // - otherwise -> displayMode = 'word'
  const displayMode: LineDisplayMode = (isExplicitFallback || unresolvedRate >= 0.20 || totalWords === 0)
    ? 'line'
    : 'word';

  return {
    time: lineStart,
    endTime: lineEnd,
    text: dto.text || '',
    language: dto.language,
    quality: dto.quality || (isExplicitFallback ? 'line_fallback' : 'approximate'),
    wordTimingAvailable,
    displayMode,
    unresolvedRate: Number(unresolvedRate.toFixed(2)),
    timestampSource: dto.timestamp_source,
    confidence: typeof dto.confidence === 'number' && !Number.isNaN(dto.confidence) ? dto.confidence : null,
    matchedWords: dto.matched_words,
    interpolatedWords: dto.interpolated_words,
    unresolvedWords: dto.unresolved_words,
    lineFallbackWords: dto.line_fallback_words,
    words,
  };
}

/**
 * Maps the complete backend WordLyricsPayloadDTO to the frontend WordLyricsPayload.
 * Validates the structure and returns null if invalid.
 * If any line has corrupted start timestamps, the entire payload is rejected (returns null),
 * cleanly triggering fallback to canonical LRC without shifting indices or deleting lines.
 */
export function mapWordLyricsPayloadDTO(
  dto: WordLyricsPayloadDTO | null | undefined
): WordLyricsPayload | null {
  if (!dto || typeof dto !== 'object') {
    return null;
  }

  if (!Array.isArray(dto.lines) || dto.lines.length === 0) {
    return null;
  }

  const mappedLines: LyricsLine[] = [];
  for (const lineDTO of dto.lines) {
    const mapped = mapLineDTO(lineDTO);
    if (!mapped) {
      // Reject entire payload to prevent silent line deletion from the middle of the lyrics
      return null;
    }
    mappedLines.push(mapped);
  }

  return {
    version: dto.version || 1,
    backend: dto.backend || 'whisper_anchor',
    quality: dto.quality || 'approximate',
    language: dto.language || 'ru',
    confidence: typeof dto.confidence === 'number' && !Number.isNaN(dto.confidence) ? dto.confidence : null,
    lines: mappedLines,
    stats: dto.stats,
  };
}
