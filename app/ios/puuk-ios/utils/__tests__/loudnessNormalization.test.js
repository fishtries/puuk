import {
  MIN_NORMALIZATION_GAIN_DB,
  MAX_NORMALIZATION_GAIN_DB,
  clampGainDb,
  dbToLinear,
  computeTrackNormalizationGainDb,
  computeEffectivePlayerVolume,
  applyTrackNormalization,
} from '../loudnessNormalization';

describe('loudnessNormalization', () => {
  describe('clampGainDb', () => {
    test('clamps values exceeding MAX_NORMALIZATION_GAIN_DB', () => {
      expect(clampGainDb(15.5)).toBe(MAX_NORMALIZATION_GAIN_DB);
      expect(clampGainDb(12.0)).toBe(12.0);
    });

    test('clamps values below MIN_NORMALIZATION_GAIN_DB', () => {
      expect(clampGainDb(-18.0)).toBe(MIN_NORMALIZATION_GAIN_DB);
      expect(clampGainDb(-12.0)).toBe(-12.0);
    });

    test('preserves values within range', () => {
      expect(clampGainDb(-3.5)).toBe(-3.5);
      expect(clampGainDb(0)).toBe(0);
      expect(clampGainDb(4.2)).toBe(4.2);
    });

    test('handles NaN and non-finite inputs', () => {
      expect(clampGainDb(NaN)).toBe(0);
      expect(clampGainDb(Infinity)).toBe(0);
      expect(clampGainDb(-Infinity)).toBe(0);
      expect(clampGainDb('invalid')).toBe(0);
    });
  });

  describe('dbToLinear', () => {
    test('returns 1.0 for 0 dB', () => {
      expect(dbToLinear(0)).toBe(1.0);
    });

    test('calculates correct linear factor for -6 dB (~0.501)', () => {
      const linear = dbToLinear(-6.0);
      expect(linear).toBeCloseTo(0.501187, 4);
    });

    test('calculates correct linear factor for +6 dB (~1.995)', () => {
      const linear = dbToLinear(6.0);
      expect(linear).toBeCloseTo(1.99526, 4);
    });

    test('handles invalid inputs gracefully', () => {
      expect(dbToLinear(NaN)).toBe(1.0);
      expect(dbToLinear(Infinity)).toBe(1.0);
    });
  });

  describe('computeTrackNormalizationGainDb', () => {
    test('returns 0 when normalization is disabled', () => {
      const track = {
        loudness_status: 'analyzed',
        normalization_gain_db: -4.5,
      };
      expect(computeTrackNormalizationGainDb(track, false)).toBe(0);
    });

    test('returns normalization_gain_db when enabled and track is analyzed', () => {
      const track = {
        loudness_status: 'analyzed',
        normalization_gain_db: -3.2,
      };
      expect(computeTrackNormalizationGainDb(track, true)).toBe(-3.2);
    });

    test('clamps out-of-range gains from server', () => {
      const loudTrack = {
        loudness_status: 'analyzed',
        normalization_gain_db: -20.0,
      };
      expect(computeTrackNormalizationGainDb(loudTrack, true)).toBe(-12.0);

      const quietTrack = {
        loudness_status: 'analyzed',
        normalization_gain_db: 25.0,
      };
      expect(computeTrackNormalizationGainDb(quietTrack, true)).toBe(12.0);
    });

    test('returns 0 for pending or failed tracks', () => {
      expect(computeTrackNormalizationGainDb({ loudness_status: 'pending', normalization_gain_db: null }, true)).toBe(0);
      expect(computeTrackNormalizationGainDb({ loudness_status: 'failed', normalization_gain_db: null }, true)).toBe(0);
      expect(computeTrackNormalizationGainDb({ loudness_status: 'analyzed', normalization_gain_db: null }, true)).toBe(0);
    });

    test('handles null/undefined tracks safely', () => {
      expect(computeTrackNormalizationGainDb(null, true)).toBe(0);
      expect(computeTrackNormalizationGainDb(undefined, true)).toBe(0);
    });
  });

  describe('computeEffectivePlayerVolume', () => {
    test('returns 1.0 when sound check is disabled', () => {
      const track = { loudness_status: 'analyzed', normalization_gain_db: -5.0 };
      expect(computeEffectivePlayerVolume(track, false)).toBe(1.0);
    });

    test('attenuates loud tracks (-dB) below 1.0', () => {
      const track = { loudness_status: 'analyzed', normalization_gain_db: -6.0 };
      const vol = computeEffectivePlayerVolume(track, true);
      expect(vol).toBeCloseTo(0.501187, 4);
      expect(vol).toBeLessThan(1.0);
      expect(vol).toBeGreaterThan(0.0);
    });

    test('caps boost (+dB) to 1.0 because AVPlayer max volume is 1.0', () => {
      const quietTrack = { loudness_status: 'analyzed', normalization_gain_db: 4.0 };
      const vol = computeEffectivePlayerVolume(quietTrack, true);
      expect(vol).toBe(1.0);
    });

    test('returns 1.0 for 0 dB or unanalyzed track', () => {
      expect(computeEffectivePlayerVolume({ loudness_status: 'analyzed', normalization_gain_db: 0 }, true)).toBe(1.0);
      expect(computeEffectivePlayerVolume({ loudness_status: 'pending' }, true)).toBe(1.0);
      expect(computeEffectivePlayerVolume(null, true)).toBe(1.0);
    });
  });

  describe('applyTrackNormalization', () => {
    test('sets player.volume correctly for attenuated track', () => {
      const player = { volume: 1.0 };
      const track = { loudness_status: 'analyzed', normalization_gain_db: -6.0 };
      const applied = applyTrackNormalization(player, track, true);

      expect(applied).toBeCloseTo(0.501187, 4);
      expect(player.volume).toBeCloseTo(0.501187, 4);
    });

    test('sets player.volume to 1.0 when disabled', () => {
      const player = { volume: 0.5 };
      const track = { loudness_status: 'analyzed', normalization_gain_db: -6.0 };
      const applied = applyTrackNormalization(player, track, false);

      expect(applied).toBe(1.0);
      expect(player.volume).toBe(1.0);
    });

    test('does not throw when player setter fails or player is null', () => {
      expect(() => applyTrackNormalization(null, null, true)).not.toThrow();

      const brokenPlayer = {
        get volume() { return 1.0; },
        set volume(val) { throw new Error('setter error'); },
      };
      expect(() => applyTrackNormalization(brokenPlayer, { loudness_status: 'analyzed', normalization_gain_db: -3 }, true)).not.toThrow();
    });
  });
});
