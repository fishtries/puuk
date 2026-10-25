import { LyricsLine, Track } from '../types/track';
import { parseLRC } from '../engine/lrcParser';

/**
 * Parses remote lyrics payload into display lines from canonical LRC.
 */
export function parseLyricsPayload(data: {
  lyrics?: string | null;
}): { lyrics: LyricsLine[]; rawLyricsText: string } {
  const lrc = data.lyrics || '';
  const parsed = parseLRC(lrc);

  return { lyrics: parsed, rawLyricsText: lrc };
}

/**
 * Returns true if the track has non-empty lyrics (parsed, raw text, or explicit metadata flag).
 */
export function hasLyricsContent(
  currentTrack: Track | null | undefined,
  lyrics?: LyricsLine[] | null,
  rawLyricsText?: string | null
): boolean {
  if (!currentTrack) return false;
  if (lyrics && lyrics.length > 0) return true;
  if (rawLyricsText && rawLyricsText.trim().length > 0) return true;
  if (typeof currentTrack.lyrics === 'string' && currentTrack.lyrics.trim().length > 0) return true;
  if (currentTrack.has_lyrics) return true;
  return false;
}

/** Removes a demo/mix track guard: virtual demo tracks never hit backend history. */
export function isDemoTrack(trackId: string): boolean {
  return trackId.startsWith('demo-') || trackId.startsWith('mix-');
}
