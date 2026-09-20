import type { LyricsLine, LyricsWord } from '../types/track';

const TIME_REGEX = /\[(\d{2,}):(\d{2})(?:[.:](\d{2,3}))?\]/g;
const WORD_TIME_REGEX = /<(\d{2,}):(\d{2})(?:[.:](\d{2,3}))?>/g;

export function parseWordLevelTokens(rawContent: string): { text: string; words?: LyricsWord[] } {
  if (!rawContent || !WORD_TIME_REGEX.test(rawContent)) {
    const cleanText = rawContent.replace(WORD_TIME_REGEX, '').replace(/\s+/g, ' ').trim();
    return { text: cleanText || '♪' };
  }

  // Reset regex state
  WORD_TIME_REGEX.lastIndex = 0;
  const matches = Array.from(rawContent.matchAll(WORD_TIME_REGEX));

  if (matches.length === 0) {
    return { text: rawContent.trim() || '♪' };
  }

  const words: LyricsWord[] = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    let ms = 0;

    if (match[3]) {
      if (match[3].length === 2) {
        ms = parseInt(match[3], 10) * 10;
      } else {
        ms = parseInt(match[3].slice(0, 3), 10);
      }
    }

    const startTime = minutes * 60 + seconds + ms / 1000;
    const startPos = (match.index ?? 0) + match[0].length;
    const endPos = i + 1 < matches.length ? (matches[i + 1].index ?? rawContent.length) : rawContent.length;
    const chunk = rawContent.slice(startPos, endPos).trim();

    if (chunk) {
      words.push({
        text: chunk,
        startTime,
        endTime: startTime + 0.4,
        alignment: 'matched',
        timestampSource: 'whisper',
        confidence: null,
        isInterpolated: false,
      });
    }
  }

  words.sort((a, b) => {
    const aTime = typeof a.startTime === 'number' ? a.startTime : 0;
    const bTime = typeof b.startTime === 'number' ? b.startTime : 0;
    return aTime - bTime;
  });

  // Derive realistic endTime from next word startTime if available
  for (let i = 0; i < words.length; i++) {
    const currentWord = words[i];
    const currentStart: number = typeof currentWord.startTime === 'number' ? currentWord.startTime : 0;
    if (i + 1 < words.length) {
      const nextWord = words[i + 1];
      const nextStart: number = typeof nextWord.startTime === 'number' ? nextWord.startTime : currentStart + 0.4;
      currentWord.endTime = Math.max(currentStart + 0.08, nextStart);
    } else {
      currentWord.endTime = currentStart + Math.max(0.25, currentWord.text.length * 0.06);
    }
  }

  const cleanText = rawContent
    .replace(WORD_TIME_REGEX, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    text: cleanText || '♪',
    words: words.length > 0 ? words : undefined,
  };
}

export function parseLRC(lrcText: string): LyricsLine[] {
  if (!lrcText || typeof lrcText !== 'string') {
    return [];
  }

  const lines = lrcText.split(/\r?\n/);
  const result: LyricsLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^\[(ti|ar|al|au|by|length|re|ve|offset):/i.test(trimmed)) {
      continue;
    }

    const matches = Array.from(trimmed.matchAll(TIME_REGEX));
    if (matches.length === 0) continue;

    const rawContent = trimmed.replace(TIME_REGEX, '').trim();
    const { text, words } = parseWordLevelTokens(rawContent);

    for (const match of matches) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      let ms = 0;

      if (match[3]) {
        if (match[3].length === 2) {
          ms = parseInt(match[3], 10) * 10;
        } else {
          ms = parseInt(match[3].slice(0, 3), 10);
        }
      }

      const totalSeconds = minutes * 60 + seconds + ms / 1000;
      result.push({
        time: totalSeconds,
        text,
        quality: 'approximate',
        wordTimingAvailable: Boolean(words && words.length > 0),
        displayMode: words && words.length > 0 ? 'word' : 'line',
        words,
      });
    }
  }

  result.sort((a, b) => a.time - b.time);

  // Plain text without timestamps should remain unsynced (return empty array).
  // Do NOT synthesize fake timestamps like `index * 4`.
  return result;
}

export function findActiveLyricIndex(lyrics: LyricsLine[], currentTime: number): number {
  if (!lyrics || lyrics.length === 0) return -1;

  let activeIndex = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (currentTime >= lyrics[i].time - 0.04) {
      activeIndex = i;
    } else {
      break;
    }
  }

  return activeIndex;
}

export function findActiveWordIndex(
  words: LyricsWord[] | undefined,
  currentTime: number
): number {
  if (!words || words.length === 0) return -1;

  let activeIndex = -1;
  for (let i = 0; i < words.length; i++) {
    const wStart = words[i].startTime;
    // 50ms preload threshold (-0.05s), safe null check
    if (typeof wStart === 'number' && currentTime >= wStart - 0.05) {
      activeIndex = i;
    } else {
      break;
    }
  }

  return activeIndex;
}
