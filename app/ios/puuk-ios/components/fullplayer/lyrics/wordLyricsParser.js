/**
 * Word-level lyrics parser and timing helper (Contract v1).
 *
 * Implements:
 * - Strict schemaVersion: 1 validation
 * - Track ID matching
 * - Canonical code point string segmentation (Array.from for emoji/Unicode)
 * - Safe pre-segmentation into words and inter-word whitespace/punctuation
 * - Word states: 'future' (dimmed), 'active' (contrasted), 'past' (readable)
 * - Auto-scroll line selection (latest started line by time, tiebreak by original order)
 */

/**
 * Splits text by Unicode code points (safe for emoji & non-BMP characters).
 */
export function getCodePoints(text) {
  return Array.from(text || '');
}

/**
 * Slices a string by Unicode code point indices [from, to).
 */
export function sliceCodePoints(codePoints, from, to) {
  return codePoints.slice(from, to).join('');
}

/**
 * Pre-segments line text into words and intervening non-word characters.
 */
export function buildLineSegments(lineText, words) {
  if (!words || words.length === 0) {
    return [{ isWord: false, text: lineText }];
  }

  const codePoints = getCodePoints(lineText);
  const segments = [];
  let cursor = 0;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.from > cursor) {
      segments.push({
        isWord: false,
        text: sliceCodePoints(codePoints, cursor, w.from),
      });
    }
    segments.push({
      isWord: true,
      id: w.id,
      text: sliceCodePoints(codePoints, w.from, w.to),
      startMs: w.startMs,
      endMs: w.endMs,
    });
    cursor = w.to;
  }

  if (cursor < codePoints.length) {
    segments.push({
      isWord: false,
      text: sliceCodePoints(codePoints, cursor, codePoints.length),
    });
  }

  return segments;
}

/**
 * Validates and parses wordLyrics payload against Contract v1.
 * Returns normalized object { revision, trackId, durationMs, lines } or null if invalid.
 */
export function validateAndParseWordLyrics(payload, expectedTrackId = null) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  // Schema version 1
  if (payload.schemaVersion !== 1) {
    return null;
  }

  // Track ID
  const trackId = payload.trackId;
  if (!trackId || typeof trackId !== 'string') {
    return null;
  }
  if (expectedTrackId && String(trackId) !== String(expectedTrackId)) {
    return null;
  }

  // Duration
  const durationMs = payload.durationMs;
  if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs <= 0) {
    return null;
  }

  // Revision
  if (!payload.revision || typeof payload.revision !== 'string' || !/^[0-9a-fA-F]{64}$/.test(payload.revision)) {
    return null;
  }

  // Lines
  const lines = payload.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    return null;
  }

  if (typeof payload.audioSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(payload.audioSha256)) {
    return null;
  }
  const parsedLines = [];
  const seenLineIds = new Set();

  for (let lIdx = 0; lIdx < lines.length; lIdx++) {
    const line = lines[lIdx];
    if (!line || typeof line !== 'object') return null;

    const lineId = line.id;
    if (typeof lineId !== 'string' || !lineId.trim() || seenLineIds.has(lineId)) return null;
    seenLineIds.add(lineId);

    const lineText = line.text;
    if (typeof lineText !== 'string') return null;

    const startMs = line.startMs;
    const endMs = line.endMs;
    if (!Number.isInteger(startMs) || startMs < 0) return null;
    if (!Number.isInteger(endMs) || endMs <= startMs || endMs > durationMs) return null;

    // Keep source text order even when vocal intervals overlap.

    const words = line.words;
    if (!Array.isArray(words)) return null;

    const codePoints = getCodePoints(lineText);
    const codePointCount = codePoints.length;
    let prevCharEnd = 0;
    const parsedWords = [];
    const seenWordIds = new Set();

    for (let wIdx = 0; wIdx < words.length; wIdx++) {
      const word = words[wIdx];
      if (!word || typeof word !== 'object') return null;

      const wordId = word.id;
      if (typeof wordId !== 'string' || !wordId.trim() || seenWordIds.has(wordId)) return null;
      seenWordIds.add(wordId);

      const from = word.from;
      const to = word.to;
      if (!Number.isInteger(from) || from < 0) return null;
      if (!Number.isInteger(to) || to <= from || to > codePointCount) return null;

      // Character range non-overlapping
      if (from < prevCharEnd) return null;
      prevCharEnd = to;

      const wStartMs = word.startMs;
      const wEndMs = word.endMs;
      if (!Number.isInteger(wStartMs) || wStartMs < startMs) return null;
      if (!Number.isInteger(wEndMs) || wEndMs <= wStartMs || wEndMs > endMs) return null;

      // Word occurrence order is textual, not temporal.

      parsedWords.push({
        id: wordId,
        from,
        to,
        startMs: wStartMs,
        endMs: wEndMs,
        text: sliceCodePoints(codePoints, from, to),
      });
    }

    if (parsedWords.length && (
      startMs !== Math.min(...parsedWords.map((word) => word.startMs)) ||
      endMs !== Math.max(...parsedWords.map((word) => word.endMs))
    )) return null;

    const segments = buildLineSegments(lineText, parsedWords);

    parsedLines.push({
      id: lineId,
      text: lineText,
      startMs,
      endMs,
      time: startMs / 1000,
      words: parsedWords,
      segments,
      hasWordTimings: parsedWords.length > 0,
    });
  }

  return {
    schemaVersion: payload.schemaVersion,
    revision: payload.revision,
    trackId: payload.trackId,
    audioSha256: payload.audioSha256,
    durationMs,
    lines: parsedLines,
  };
}

/**
 * Returns word state: 'future' | 'active' | 'past'.
 */
export function getWordState(word, currentMs) {
  if (currentMs < word.startMs) return 'future';
  if (currentMs >= word.endMs) return 'past';
  return 'active';
}

/**
 * Finds active line index for word lyrics:
 * - Returns -1 if before the first line
 * - Latest line where line.time <= currentTime (tiebreak by later original index)
 */
export function computeActiveWordLineIndex(lines, currentTime) {
  if (!lines || lines.length === 0) return -1;


  let activeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (currentTime >= lines[i].time && (activeIdx < 0 || lines[i].time >= lines[activeIdx].time)) {
      activeIdx = i;
    }
  }
  return activeIdx;
}
