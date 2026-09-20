import { LyricsLine } from '../types/track';
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

/** Removes a demo/mix track guard: virtual demo tracks never hit backend history. */
export function isDemoTrack(trackId: string): boolean {
  return trackId.startsWith('demo-') || trackId.startsWith('mix-');
}
