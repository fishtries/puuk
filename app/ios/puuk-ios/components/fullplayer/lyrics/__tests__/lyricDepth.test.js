import { computeActiveLyricIndex, getLyricTarget } from '../lyricDepth';

describe('fullplayer/lyrics/lyricDepth', () => {
  it('returns neutral depth at the active line', () => {
    expect(getLyricTarget(0)).toEqual({ scale: 1.0, opacity: 1.0, color: 1.0 });
    expect(getLyricTarget(-3)).toEqual(getLyricTarget(3));
  });

  it('fades lines farther from the active one', () => {
    const near = getLyricTarget(1);
    const far = getLyricTarget(6);
    expect(near.opacity).toBeGreaterThan(far.opacity);
    expect(near.scale).toBeGreaterThan(far.scale);
  });

  it('handles empty and unsynced lyric lists', () => {
    expect(computeActiveLyricIndex([], 5)).toBe(-1);
    expect(computeActiveLyricIndex(null, 5)).toBe(-1);
    expect(computeActiveLyricIndex([{ time: null, text: 'plain' }], 5)).toBe(-2);
  });

  it('locates the active line honoring null-time gaps', () => {
    const lyrics = [
      { time: 10, text: 'a' },
      { time: null, text: 'gap' },
      { time: 30, text: 'b' },
    ];
    expect(computeActiveLyricIndex(lyrics, 5)).toBe(-1);
    expect(computeActiveLyricIndex(lyrics, 10)).toBe(0);
    expect(computeActiveLyricIndex(lyrics, 15)).toBe(0);
    expect(computeActiveLyricIndex(lyrics, 35)).toBe(2);
  });
});
