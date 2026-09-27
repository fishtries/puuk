import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const realPlayerTypesUrl = new URL('../../types/player.ts', import.meta.url).href;
const realTrackTypesUrl = new URL('../../types/track.ts', import.meta.url).href;
const runtimeTypeShims = new Map([
  [realPlayerTypesUrl, new URL('../../store/__tests__/playerTypesShim.ts', import.meta.url).href],
  [realTrackTypesUrl, new URL('../../store/__tests__/trackTypesShim.ts', import.meta.url).href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let resolved;
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        resolved = nextResolve(`${specifier}.ts`, context);
      } catch {
        resolved = nextResolve(specifier, context);
      }
    } else {
      resolved = nextResolve(specifier, context);
    }

    const shimUrl = runtimeTypeShims.get(resolved.url);
    if (shimUrl) return { url: shimUrl, shortCircuit: true };
    return resolved;
  },
});

class FakeAudioElement {
  preload = 'metadata';
  crossOrigin = '';
  paused = true;
  currentTime = 0;
  duration = 0;
  volume = 1;
  src = '';
  private handlers = new Map<string, ((event: Event) => void)[]>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(listener);
    this.handlers.set(type, list);
  }

  load(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
}

const fakeAudio = new FakeAudioElement();
globalThis.Audio = function (): HTMLAudioElement {
  return fakeAudio as unknown as HTMLAudioElement;
} as unknown as typeof Audio;

const { AudioEngine } = await import('../AudioEngine.ts');
const {
  computeTrackNormalizationGainDb,
  getInitialLoudnessSetting,
} = await import('../../store/usePlayerStore.ts');
import type { Track } from '../../types/track.ts';

describe('Loudness Normalization (Web Unit Tests)', () => {
  describe('1. AudioEngine.dbToLinear conversion', () => {
    it('converts 0 dB to 1.0 linear gain', () => {
      const linear = AudioEngine.dbToLinear(0);
      assert.equal(Math.round(linear * 1000) / 1000, 1.0);
    });

    it('converts +6 dB to ~1.995 linear gain', () => {
      const linear = AudioEngine.dbToLinear(6);
      assert.equal(Math.round(linear * 100) / 100, 2.0);
    });

    it('converts -6 dB to ~0.501 linear gain', () => {
      const linear = AudioEngine.dbToLinear(-6);
      assert.equal(Math.round(linear * 100) / 100, 0.5);
    });

    it('clamps excessive boost (+20 dB) to +12 dB (~3.98)', () => {
      const linear = AudioEngine.dbToLinear(20);
      const maxLinear = AudioEngine.dbToLinear(12);
      assert.equal(linear, maxLinear);
      assert.ok(linear < 4.0);
    });

    it('clamps excessive attenuation (-30 dB) to -12 dB (~0.25)', () => {
      const linear = AudioEngine.dbToLinear(-30);
      const minLinear = AudioEngine.dbToLinear(-12);
      assert.equal(linear, minLinear);
    });

    it('safely handles NaN, Infinity, -Infinity', () => {
      assert.equal(AudioEngine.dbToLinear(NaN), 1.0);
      assert.equal(AudioEngine.dbToLinear(Infinity), 1.0);
      assert.equal(AudioEngine.dbToLinear(-Infinity), 1.0);
    });

    it('AudioEngine.clampGainDb clamps to [-12, +12] range', () => {
      assert.equal(AudioEngine.clampGainDb(25), 12.0);
      assert.equal(AudioEngine.clampGainDb(-30), -12.0);
      assert.equal(AudioEngine.clampGainDb(3.5), 3.5);
      assert.equal(AudioEngine.clampGainDb(NaN), 0.0);
      assert.equal(AudioEngine.clampGainDb(Infinity), 0.0);
    });
  });

  describe('2. AudioEngine Effective Gain Calculation & Fallback', () => {
    const engine = AudioEngine.getInstance();

    beforeEach(() => {
      engine.setUserVolume(1.0);
      engine.setNormalizationGainDb(0);
      engine.setMuted(false);
    });

    it('multiplies userVolume and normalizationGainDb', () => {
      engine.setUserVolume(0.8);
      engine.setNormalizationGainDb(6); // ~2.0
      const effective = engine.getEffectiveGain();
      // 0.8 * ~1.995 = ~1.596
      assert.equal(Math.round(effective * 10) / 10, 1.6);
    });

    it('setNormalizationGainDb clamps stored value to [-12, +12]', () => {
      engine.setNormalizationGainDb(25);
      assert.equal(engine.getNormalizationGainDb(), 12);
      engine.setNormalizationGainDb(-30);
      assert.equal(engine.getNormalizationGainDb(), -12);
    });

    it('mutes effective gain to 0 while keeping normalizationGainDb intact', () => {
      engine.setUserVolume(0.8);
      engine.setNormalizationGainDb(3.5);
      engine.setMuted(true);

      assert.equal(engine.getEffectiveGain(), 0);
      assert.equal(engine.getNormalizationGainDb(), 3.5);

      // Unmute restores
      engine.setMuted(false);
      assert.ok(engine.getEffectiveGain() > 0);
    });

    it('clamps effective gain to maximum safe ceiling (MAX_EFFECTIVE_GAIN)', () => {
      engine.setUserVolume(1.0);
      engine.setNormalizationGainDb(12); // ~3.98
      const effective = engine.getEffectiveGain();
      assert.ok(effective <= 4.0);
      assert.ok(effective > 3.9);
    });

    it('fallback mode clamps HTMLAudioElement.volume to [0, 1]', () => {
      // In Node test environment, Web Audio Context is not initialized so applyEffectiveGain falls back to HTMLAudioElement
      engine.setUserVolume(1.0);
      engine.setNormalizationGainDb(6); // effective gain ~2.0
      engine.applyEffectiveGain();
      // HTMLAudioElement.volume must be capped to 1.0
      assert.equal(fakeAudio.volume, 1.0);

      engine.setUserVolume(0.3);
      engine.setNormalizationGainDb(-6); // effective gain ~0.3 * 0.5 = 0.15
      engine.applyEffectiveGain();
      assert.equal(Math.round(fakeAudio.volume * 100) / 100, 0.15);

      engine.setMuted(true);
      engine.applyEffectiveGain();
      assert.equal(fakeAudio.volume, 0.0);
    });
  });

  describe('3. computeTrackNormalizationGainDb helper', () => {
    it('returns 0 when normalization is disabled', () => {
      const track: Track = {
        id: 't1',
        title: 'Title',
        artist: 'Artist',
        duration: 100,
        loudness_status: 'analyzed',
        normalization_gain_db: 4.5,
      };
      assert.equal(computeTrackNormalizationGainDb(track, false), 0);
    });

    it('returns track gain when normalization is enabled and track is analyzed', () => {
      const track: Track = {
        id: 't2',
        title: 'Title',
        artist: 'Artist',
        duration: 100,
        loudness_status: 'analyzed',
        normalization_gain_db: 3.2,
      };
      assert.equal(computeTrackNormalizationGainDb(track, true), 3.2);
    });

    it('returns 0 when track status is pending or failed', () => {
      const pendingTrack: Track = {
        id: 't3',
        title: 'Title',
        artist: 'Artist',
        duration: 100,
        loudness_status: 'pending',
        normalization_gain_db: null,
      };
      assert.equal(computeTrackNormalizationGainDb(pendingTrack, true), 0);

      const failedTrack: Track = {
        id: 't4',
        title: 'Title',
        artist: 'Artist',
        duration: 100,
        loudness_status: 'failed',
        normalization_gain_db: null,
      };
      assert.equal(computeTrackNormalizationGainDb(failedTrack, true), 0);
    });

    it('returns 0 for null or missing track', () => {
      assert.equal(computeTrackNormalizationGainDb(null, true), 0);
      assert.equal(computeTrackNormalizationGainDb(undefined, true), 0);
    });
  });

  describe('4. getInitialLoudnessSetting with localStorage', () => {
    const originalLocalStorage = globalThis.localStorage;

    beforeEach(() => {
      // Mock simple in-memory localStorage for Node environment
      const store = new Map<string, string>();
      // @ts-expect-error mock
      globalThis.localStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, val: string) => store.set(key, val),
        removeItem: (key: string) => store.delete(key),
        clear: () => store.clear(),
      };
    });

    it('defaults to true when nothing is in localStorage', () => {
      assert.equal(getInitialLoudnessSetting(), true);
    });

    it('reads false correctly from localStorage', () => {
      localStorage.setItem('puuk:loudness-normalization:v1', 'false');
      assert.equal(getInitialLoudnessSetting(), false);
    });

    it('reads true correctly from localStorage', () => {
      localStorage.setItem('puuk:loudness-normalization:v1', 'true');
      assert.equal(getInitialLoudnessSetting(), true);
    });

    it('falls back to default true on corrupted or unknown values', () => {
      const corruptedValues = ['invalid_garbage', '0', '1', '', '{ enabled: true }', 'undefined', 'null'];
      for (const val of corruptedValues) {
        localStorage.setItem('puuk:loudness-normalization:v1', val);
        assert.equal(getInitialLoudnessSetting(), true, `Expected true for corrupted value: "${val}"`);
      }
    });
  });
});
