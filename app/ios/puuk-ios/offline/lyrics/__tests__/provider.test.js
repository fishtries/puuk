import { createLyricsProvider, parseLyricsResult } from '../provider';
import wordLyrics from '../../../components/fullplayer/lyrics/__tests__/fixtures/word_lyrics_synthetic.json';
import { computeActiveLyricIndex } from '../../../components/fullplayer/lyrics/lyricDepth';

const owner = { origin: 'https://library.example', userId: '17' };
const initialSession = { owner, activationId: 'first-login', generation: 1 };
const mediaKey = { owner, trackId: wordLyrics.trackId, contentVersion: wordLyrics.audioSha256 };
const nextKey = { ...mediaKey, contentVersion: '2'.repeat(64) };
const plain = { lyrics: 'First line\nSecond line', lyricsSource: 'embedded_plain' };
const lrc = { lyrics: '[00:01.20]First\n[00:04.321]Second', isSynced: true };
const wordOnly = { lyrics: null, wordLyrics };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  let session = initialSession;
  let selected = mediaKey;
  const saved = new Map();
  const index = {
    isOfflineSessionCurrent: candidate => candidate === session,
    readMediaKey: jest.fn(async (_, trackId, version) =>
      trackId !== mediaKey.trackId ? null :
        version ? [mediaKey, nextKey].find(key => key.contentVersion === version) : selected),
    readLyrics: jest.fn(async (_, key) => saved.get(key.contentVersion)),
    saveLyricsResult: jest.fn(async (_, key, result) => {
      if (result.state !== 'unknown' || !saved.has(key.contentVersion)) {
        saved.set(key.contentVersion, result);
      }
      return true;
    }),
  };
  const fetchLyrics = jest.fn();
  const fetchContentVersion = jest.fn(async () => mediaKey.contentVersion);
  const provider = createLyricsProvider({
    ...index, fetchLyrics, fetchContentVersion, getAuthGeneration: () => session.generation,
  });

  return {
    index, saved, fetchLyrics, fetchContentVersion, provider,
    select: key => { selected = key; },
    changeSession: replacement => { session = replacement; },
  };
}

describe('versioned lyrics provider', () => {
  it.each([
    ['plain', plain, { plainText: plain.lyrics, isSynced: false }],
    ['LRC', lrc, { plainText: 'First\nSecond', isSynced: true }],
    ['word-only', wordOnly, { isSynced: true, hasWords: true }],
  ])('publishes and reads %s through the index with the network unavailable', async (_, payload, expected) => {
    const { provider, fetchLyrics, saved } = setup();
    fetchLyrics.mockResolvedValueOnce(payload);
    expect(await provider.refreshLyrics(initialSession, mediaKey)).toMatchObject({ state: 'ready', payload });
    expect(saved.get(mediaKey.contentVersion)).toMatchObject({ state: 'ready', payload, checkedAt: expect.any(Number) });
    if (payload.wordLyrics) expect(saved.get(mediaKey.contentVersion).lyricsRevision).toBe(wordLyrics.revision);
    fetchLyrics.mockRejectedValue(new Error('offline'));
    const result = await provider.readSelectedLyrics(initialSession, mediaKey.trackId);
    const parsed = parseLyricsResult(result, mediaKey.trackId);
    expect(parsed).toMatchObject(expected);
    expect(fetchLyrics).toHaveBeenCalledTimes(1);
    if (payload === lrc) {
      expect(parsed.lines.map(line => line.time)).toEqual([1.2, 4.321]);
      expect(computeActiveLyricIndex(parsed.lines, 4.5)).toBe(1);
      expect(computeActiveLyricIndex(parsed.lines, 1.5)).toBe(0);
    }
  });

  it.each([
    [{ lyricsStatus: 'absent', lyrics: null, wordLyrics: null }, 'absent'],
    [{ lyricsStatus: 'failed', lyrics: null }, 'unknown'],
    [{ lyricsStatus: 'empty', lyrics: null }, 'unknown'],
    [{ has_lyrics: false, lyrics: null }, 'unknown'],
    [{ lyricsStatus: 'absent', ...wordOnly }, 'ready'],
    [{ ...wordOnly, wordLyrics: { ...wordLyrics, audioSha256: nextKey.contentVersion } }, 'unknown'],
    [{ ...wordOnly, wordLyrics: { ...wordLyrics, schemaVersion: 2 } }, 'unknown'],
  ])('classifies lyrics response %# as %s', async (payload, state) => {
    const { provider, fetchLyrics } = setup();
    fetchLyrics.mockResolvedValue(payload);
    await expect(provider.refreshLyrics(initialSession, mediaKey)).resolves.toMatchObject({ state });
  });

  it('keeps the previous ready result after a transient network error', async () => {
    const { saved, index, provider, fetchLyrics } = setup();
    const previous = { state: 'ready', payload: lrc, checkedAt: 1 };
    saved.set(mediaKey.contentVersion, previous);
    fetchLyrics.mockRejectedValue(new Error('network error'));
    await expect(provider.refreshLyrics(initialSession, mediaKey)).resolves.toEqual({ state: 'unknown' });
    expect(index.saveLyricsResult).not.toHaveBeenCalled();
    expect(saved.get(mediaKey.contentVersion)).toBe(previous);
  });

  it('rejects a legacy result when metadata confirms a different server version', async () => {
    const { index, provider, fetchLyrics, fetchContentVersion } = setup();
    fetchLyrics.mockResolvedValue(lrc);
    fetchContentVersion.mockResolvedValue(nextKey.contentVersion);
    await expect(provider.refreshLyrics(initialSession, mediaKey)).resolves.toEqual({ state: 'unknown' });
    expect(index.saveLyricsResult).not.toHaveBeenCalled();
  });

  it.each([
    { ...initialSession, owner: { ...owner, userId: '18' }, activationId: 'other-user' },
    { ...initialSession, owner: { ...owner, origin: 'https://other.example' }, activationId: 'other-origin' },
    { ...initialSession, activationId: 'same-user-new-login' },
    { ...initialSession, generation: 2 },
  ])('discards a response from a superseded session %#', async replacement => {
    const { provider, index, fetchLyrics, changeSession } = setup();
    const started = deferred();
    const response = deferred();
    fetchLyrics.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const result = provider.readSelectedLyrics(initialSession, mediaKey.trackId);
    await started.promise;
    changeSession(replacement);
    response.resolve(wordOnly);
    await expect(result).resolves.toEqual({ state: 'unknown' });
    expect(index.saveLyricsResult).not.toHaveBeenCalled();
  });

  it('checks the selected version again after a delayed local read', async () => {
    const { provider, index, select, fetchLyrics } = setup();
    const started = deferred();
    const read = deferred();
    index.readLyrics.mockImplementationOnce(() => {
      started.resolve();
      return read.promise;
    });
    const result = provider.readSelectedLyrics(initialSession, mediaKey.trackId);
    await started.promise;
    select(nextKey);
    read.resolve({ state: 'ready', payload: lrc });
    await expect(result).resolves.toEqual({ state: 'unknown' });
    expect(fetchLyrics).not.toHaveBeenCalled();
  });

  it('shares the network request with the publisher and cancels only the departing screen', async () => {
    const { provider, index, fetchLyrics } = setup();
    const started = deferred();
    const response = deferred();
    fetchLyrics.mockImplementation((_, signal) => {
      started.resolve(signal);
      return response.promise;
    });
    const controller = new AbortController();
    const view = provider.readSelectedLyrics(initialSession, mediaKey.trackId, undefined, { signal: controller.signal });
    const signal = await started.promise;
    const publication = provider.refreshLyrics(initialSession, mediaKey);
    controller.abort();
    expect(signal.aborted).toBe(false);
    response.resolve(wordOnly);
    await expect(view).resolves.toEqual({ state: 'unknown' });
    await expect(publication).resolves.toMatchObject({ state: 'ready' });
    expect(fetchLyrics).toHaveBeenCalledTimes(1);
    expect(index.saveLyricsResult).toHaveBeenCalledTimes(1);
  });

  it('treats a cancelled refresh as unknown and ignores its late result', async () => {
    const { provider, index, fetchLyrics } = setup();
    const started = deferred();
    const response = deferred();
    fetchLyrics.mockImplementation((_, signal) => {
      started.resolve(signal);
      return response.promise;
    });
    const controller = new AbortController();
    const refresh = provider.refreshLyrics(initialSession, mediaKey, { signal: controller.signal });
    const signal = await started.promise;
    controller.abort();
    expect(signal.aborted).toBe(true);
    response.resolve(wordOnly);
    await expect(refresh).resolves.toEqual({ state: 'unknown' });
    expect(index.saveLyricsResult).not.toHaveBeenCalled();
  });

  it('uses the existing endpoint without persisting when no media key is known', async () => {
    const { provider, index, fetchLyrics, select } = setup();
    select(null);
    fetchLyrics.mockResolvedValueOnce(plain);
    await expect(provider.readSelectedLyrics(initialSession, mediaKey.trackId))
      .resolves.toMatchObject({ state: 'ready', payload: plain });
    expect(index.saveLyricsResult).not.toHaveBeenCalled();
  });
});
