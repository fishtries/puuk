import type { LyricsLine } from '../types/track';

const TIME_REGEX = /\[(\d{2,}):(\d{2})(?:[.:](\d{2,3}))?\]/g;
const WORD_TIME_REGEX = /<(\d{2,}):(\d{2})(?:[.:](\d{2,3}))?>/g;

export function stripLegacyWordTags(rawContent: string): string {
  return rawContent.replace(WORD_TIME_REGEX, '').replace(/\s+/g, ' ').trim();
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
    const text = stripLegacyWordTags(rawContent) || '♪';

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
