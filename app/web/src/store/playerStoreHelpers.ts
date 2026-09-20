import { LyricsLine, WordLyricsPayload, WordLyricsPayloadDTO } from '../types/track';
import { parseLRC } from '../engine/lrcParser';
import { mapWordLyricsPayloadDTO } from '../engine/lyricsMapper';

/**
 * Deterministic accent color derived from track identity (title + artist),
 * mirrored in CSS custom properties for dynamic theming.
 */
export function generateAccentColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return `hsl(${h}, 70%, 55%)`;
}

export function applyAccentColor(accent: string): void {
  document.documentElement.style.setProperty('--accent-color', accent);
  document.documentElement.style.setProperty('--accent-glow', `${accent}40`);
}

/**
 * Parses remote lyrics payload into display lines, preferring rich
 * word-level data when present and falling back to raw LRC parsing.
 */
export function parseLyricsPayload(data: {
  lyrics?: string | null;
  wordData?: WordLyricsPayloadDTO | null;
}): { lyrics: LyricsLine[]; rawLyricsText: string; wordData: WordLyricsPayload | null } {
  const lrc = data.lyrics || '';
  const mappedPayload = mapWordLyricsPayloadDTO(data.wordData);
  let parsed: LyricsLine[] = [];

  if (mappedPayload && mappedPayload.lines && mappedPayload.lines.length > 0) {
    parsed = mappedPayload.lines;
  } else {
    parsed = parseLRC(lrc);
  }

  return { lyrics: parsed, rawLyricsText: lrc, wordData: mappedPayload };
}

/** Removes a demo/mix track guard: virtual demo tracks never hit backend history. */
export function isDemoTrack(trackId: string): boolean {
  return trackId.startsWith('demo-') || trackId.startsWith('mix-');
}
