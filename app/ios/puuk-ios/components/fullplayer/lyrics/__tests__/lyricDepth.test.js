import {
  computeActiveLyricIndex,
  getLyricTarget,
  getProgressiveValues,
  getWaveSpring,
  SCROLL_CLARITY,
  LEADING_SPRING,
  MANUAL_SPRING,
} from '../lyricDepth';

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

  describe('getProgressiveValues parity with web', () => {
    it('returns crisp lifted profile for the active line', () => {
      expect(getProgressiveValues(2, 2)).toEqual({
        blur: 0,
        opacity: 1,
        scale: 1.03,
      });
    });

    it('returns soft intro profile when activeIndex is -1', () => {
      const line0 = getProgressiveValues(0, -1);
      const line2 = getProgressiveValues(2, -1);
      expect(line0.blur).toBe(0);
      expect(line0.opacity).toBe(0.75);
      expect(line0.scale).toBe(0.97);
      expect(line2.blur).toBeGreaterThan(line0.blur);
      expect(line2.opacity).toBeLessThan(line0.opacity);
    });

    it('deepens blur and reduces opacity with distance from active line', () => {
      const d1 = getProgressiveValues(3, 2);
      const d2 = getProgressiveValues(4, 2);
      const d3 = getProgressiveValues(5, 2);
      const d4 = getProgressiveValues(6, 2);

      expect(d1).toEqual({ blur: 0.5, opacity: 0.65, scale: 0.985 });
      expect(d2).toEqual({ blur: 2.0, opacity: 0.42, scale: 0.97 });
      expect(d3).toEqual({ blur: 4.5, opacity: 0.25, scale: 0.955 });
      expect(d4.blur).toBe(6.0);
      expect(d4.opacity).toBe(0.21);
      expect(d4.scale).toBe(0.94);
    });

    it('exposes SCROLL_CLARITY constant', () => {
      expect(SCROLL_CLARITY).toEqual({ blur: 0, opacity: 1, scale: 1 });
    });
  });

  describe('getWaveSpring traffic-jam wave profile', () => {
    it('returns synchronous MANUAL_SPRING when manual scrolling', () => {
      expect(getWaveSpring(5, 2, false, true)).toEqual(MANUAL_SPRING);
      expect(getWaveSpring(2, 2, false, true)).toEqual(MANUAL_SPRING);
      expect(MANUAL_SPRING.delay).toBe(0);
    });

    it('returns LEADING_SPRING with 0 delay for the active line', () => {
      expect(getWaveSpring(3, 3, false, false)).toEqual(LEADING_SPRING);
      expect(LEADING_SPRING.delay).toBe(0);
      expect(LEADING_SPRING.stiffness).toBe(185);
    });

    it('returns reaction delays and heavier mass for cars behind (index > activeIndex)', () => {
      const dist1 = getWaveSpring(3, 2, false, false);
      const dist2 = getWaveSpring(4, 2, false, false);
      const dist3 = getWaveSpring(5, 2, false, false);
      const dist4 = getWaveSpring(6, 2, false, false);

      expect(dist1.delay).toBe(0.13);
      expect(dist2.delay).toBe(0.23);
      expect(dist3.delay).toBe(0.31);
      expect(dist4.delay).toBe(0.38);

      expect(dist1.stiffness).toBeGreaterThan(dist2.stiffness);
      expect(dist2.stiffness).toBeGreaterThan(dist3.stiffness);
      expect(dist1.mass).toBeLessThan(dist2.mass);
    });

    it('returns cascade pull upward delays for cars ahead (index < activeIndex)', () => {
      const dist1 = getWaveSpring(1, 2, false, false);
      const dist2 = getWaveSpring(0, 2, false, false);

      expect(dist1.delay).toBe(0.045);
      expect(dist2.delay).toBe(0.10);
      expect(dist1.stiffness).toBe(170);
      expect(dist2.stiffness).toBe(170);
    });

    it('handles initial mount and intro gracefully', () => {
      const initial = getWaveSpring(3, 2, true, false);
      expect(initial.delay).toBe(0);
      expect(initial.stiffness).toBe(175);

      const intro = getWaveSpring(1, -1, false, false);
      expect(intro.delay).toBe(0);
      expect(intro.stiffness).toBe(175);
    });
  });
});
