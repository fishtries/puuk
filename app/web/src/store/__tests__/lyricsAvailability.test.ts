import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Track } from '../../types/track.ts';

const realPlayerTypesUrl = new URL('../../types/player.ts', import.meta.url).href;
const realTrackTypesUrl = new URL('../../types/track.ts', import.meta.url).href;
const runtimeTypeShims = new Map([
  [realPlayerTypesUrl, new URL('./playerTypesShim.ts', import.meta.url).href],
  [realTrackTypesUrl, new URL('./trackTypesShim.ts', import.meta.url).href],
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
  src = '';
  preload = 'metadata';
  crossOrigin = '';
  paused = true;
  currentTime = 0;
  duration = 0;
  volume = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  load(): void {}
  play(): Promise<void> { return Promise.resolve(); }
  pause(): void {}
}
(globalThis as unknown as { Audio: typeof FakeAudioElement }).Audio = FakeAudioElement;

const { hasLyricsContent } = await import('../playerStoreHelpers.ts');
const { usePlayerStore } = await import('../usePlayerStore.ts');

describe('Lyrics Availability & Non-clickable Button Guards', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      currentTrack: null,
      lyrics: [],
      rawLyricsText: '',
      isLyricsLoading: false,
      isRightPanelOpen: false,
      rightPanelTab: 'queue',
    });
  });

  it('1. hasLyricsContent correctly identifies lyrics presence across various metadata formats', () => {
    // null / undefined track
    assert.equal(hasLyricsContent(null), false);
    assert.equal(hasLyricsContent(undefined), false);

    // Track with has_lyrics: true
    const trackWithFlag: Track = { id: 't1', title: 'T1', artist: 'A1', duration: 100, has_lyrics: true };
    assert.equal(hasLyricsContent(trackWithFlag), true);

    // Track with has_lyrics: false and no lyrics
    const trackNoLyrics: Track = { id: 't2', title: 'T2', artist: 'A2', duration: 100, has_lyrics: false, lyrics: '' };
    assert.equal(hasLyricsContent(trackNoLyrics), false);

    // Track with whitespace-only lyrics
    const trackWhitespace: Track = { id: 't3', title: 'T3', artist: 'A3', duration: 100, lyrics: '   \n  ' };
    assert.equal(hasLyricsContent(trackWhitespace), false);

    // Track with embedded lyrics string
    const trackWithLyrics: Track = { id: 't4', title: 'T4', artist: 'A4', duration: 100, lyrics: 'La la la' };
    assert.equal(hasLyricsContent(trackWithLyrics), true);

    // Track with parsed lyrics array passed separately
    assert.equal(hasLyricsContent(trackNoLyrics, [{ time: 1, text: 'Hello' }]), true);

    // Track with rawLyricsText passed separately
    assert.equal(hasLyricsContent(trackNoLyrics, [], '[00:01.00]Hello'), true);
  });

  it('2. toggleRightPanel("lyrics") is a no-op when current track has no lyrics', () => {
    const trackNoLyrics: Track = { id: 't2', title: 'T2', artist: 'A2', duration: 100, has_lyrics: false, lyrics: '' };
    usePlayerStore.setState({ currentTrack: trackNoLyrics, lyrics: [], rawLyricsText: '', isRightPanelOpen: false });

    usePlayerStore.getState().toggleRightPanel('lyrics');

    assert.equal(usePlayerStore.getState().isRightPanelOpen, false);
    assert.notEqual(usePlayerStore.getState().rightPanelTab, 'lyrics');
  });

  it('3. setRightPanelTab("lyrics") is blocked when track has no lyrics', () => {
    const trackNoLyrics: Track = { id: 't2', title: 'T2', artist: 'A2', duration: 100, has_lyrics: false, lyrics: '' };
    usePlayerStore.setState({ currentTrack: trackNoLyrics, lyrics: [], rawLyricsText: '', rightPanelTab: 'queue', isRightPanelOpen: true });

    usePlayerStore.getState().setRightPanelTab('lyrics');

    assert.equal(usePlayerStore.getState().rightPanelTab, 'queue');
  });

  it('4. toggleRightPanel("lyrics") succeeds when track has lyrics', () => {
    const trackWithLyrics: Track = { id: 't1', title: 'T1', artist: 'A1', duration: 100, has_lyrics: true };
    usePlayerStore.setState({ currentTrack: trackWithLyrics, lyrics: [{ time: 0, text: 'Test' }], isRightPanelOpen: false });

    usePlayerStore.getState().toggleRightPanel('lyrics');

    assert.equal(usePlayerStore.getState().isRightPanelOpen, true);
    assert.equal(usePlayerStore.getState().rightPanelTab, 'lyrics');
  });
});
