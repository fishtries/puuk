import { PlaybackCoordinator, normalizeStreamUrl, PlaybackError, classifyPlaybackError } from '../playbackCoordinator';
import { TRACK_STATUS } from '../preloadScheduler';

describe('PlaybackCoordinator', () => {
  let mockPlayer;
  let mockCache;
  let mockScheduler;
  let schedulerListeners;
  let mockPreloadNative;
  let coordinator;

  beforeEach(() => {
    jest.useFakeTimers();

    mockPlayer = {
      replace: jest.fn(),
      play: jest.fn(),
      pause: jest.fn(),
      setActiveForLockScreen: jest.fn(),
    };

    mockCache = {
      cached: new Map(),
      getCachedUri: jest.fn((id) => mockCache.cached.get(String(id)) || null),
      isCached: jest.fn((id) => mockCache.cached.has(String(id))),
      getOrFetch: jest.fn((id, url) => Promise.resolve(`file:///mock/${id}.audio`)),
      cancel: jest.fn(),
    };

    schedulerListeners = new Set();
    mockScheduler = {
      syncQueue: jest.fn(),
      getStatus: jest.fn(() => TRACK_STATUS.IDLE),
      getError: jest.fn(() => null),
      addListener: jest.fn((fn) => {
        schedulerListeners.add(fn);
        return () => schedulerListeners.delete(fn);
      }),
    };

    mockPreloadNative = jest.fn();

    coordinator = new PlaybackCoordinator({
      cache: mockCache,
      scheduler: mockScheduler,
      preloadNative: mockPreloadNative,
      serverUrl: 'https://puuk.app',
      bypassCache: false,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    coordinator.destroy();
  });

  test('play() uses local cache if track is already cached', async () => {
    mockCache.cached.set('1', 'file:///mock/1.mp3');

    const track = { id: 1, title: 'Cached Song', artist: 'Artist' };
    const res = await coordinator.play(mockPlayer, track);

    expect(res.isLocal).toBe(true);
    expect(res.uri).toBe('file:///mock/1.mp3');
    expect(mockPlayer.replace).toHaveBeenCalledWith({ uri: 'file:///mock/1.mp3' });
    expect(mockPlayer.play).toHaveBeenCalled();
    expect(mockPlayer.setActiveForLockScreen).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ title: 'Cached Song' }),
      expect.any(Object)
    );
  });

  test('play() falls back to remote stream URL and launches background cache if track is not cached', async () => {
    const track = { id: 2, title: 'Remote Song', stream_url: 'https://puuk.app/api/stream/2' };
    const headers = { Authorization: 'Bearer token123' };

    const res = await coordinator.play(mockPlayer, track, { headers });

    expect(res.isLocal).toBe(false);
    expect(res.uri).toBe('https://puuk.app/api/stream/2');
    expect(mockPlayer.replace).toHaveBeenCalledWith({ uri: 'https://puuk.app/api/stream/2', headers });
    expect(mockPlayer.play).toHaveBeenCalled();
    // Cache was triggered in background
    expect(mockCache.getOrFetch).toHaveBeenCalledWith('2', 'https://puuk.app/api/stream/2', { headers });
  });

  test('play() plays cached track without calling getHeadersAsync, and calls getHeadersAsync only for remote stream', async () => {
    const getHeadersAsyncMock = jest.fn().mockResolvedValue({ Authorization: 'Bearer async_token' });

    // 1. Local track
    mockCache.cached.set('10', 'file:///mock/10.mp3');
    const localTrack = { id: 10, title: 'Local Song' };
    const localRes = await coordinator.play(mockPlayer, localTrack, { getHeadersAsync: getHeadersAsyncMock });

    expect(localRes.isLocal).toBe(true);
    expect(mockPlayer.replace).toHaveBeenCalledWith({ uri: 'file:///mock/10.mp3' });
    expect(getHeadersAsyncMock).not.toHaveBeenCalled();

    // 2. Remote track
    mockPlayer.replace.mockClear();
    const remoteTrack = { id: 20, title: 'Remote Song', stream_url: 'https://puuk.app/api/stream/20' };
    const remoteRes = await coordinator.play(mockPlayer, remoteTrack, { getHeadersAsync: getHeadersAsyncMock });

    expect(remoteRes.isLocal).toBe(false);
    expect(getHeadersAsyncMock).toHaveBeenCalledTimes(1);
    expect(mockPlayer.replace).toHaveBeenCalledWith({
      uri: 'https://puuk.app/api/stream/20',
      headers: { Authorization: 'Bearer async_token' },
    });
  });

  test('handles track with id: 0 correctly in normalizeStreamUrl and play()', async () => {
    const track = { id: 0, title: 'Zero Track' };
    const url = normalizeStreamUrl(track, 'https://puuk.app');
    expect(url).toBe('https://puuk.app/api/stream/0');

    const res = await coordinator.play(mockPlayer, track);
    expect(coordinator.currentTrackId).toBe('0');
    expect(res.uri).toBe('https://puuk.app/api/stream/0');
    expect(mockPlayer.replace).toHaveBeenCalledWith(expect.objectContaining({ uri: 'https://puuk.app/api/stream/0' }));
  });

  test('play() accepts track DTO with track_id instead of id', async () => {
    const track = { track_id: 42, title: 'DTO Track ID Song' };
    const res = await coordinator.play(mockPlayer, track);

    expect(coordinator.currentTrackId).toBe('42');
    expect(res.uri).toBe('https://puuk.app/api/stream/42');
    expect(mockPlayer.replace).toHaveBeenCalledWith(expect.objectContaining({ uri: 'https://puuk.app/api/stream/42' }));
  });

  test('updateQueue() handles next track with id: 0 and track_id', () => {
    mockScheduler.getStatus.mockReturnValue(TRACK_STATUS.DOWNLOADING);

    // Track with id: 0
    coordinator.updateQueue({ id: 1 }, [{ id: 0, title: 'Zero Track' }]);
    expect(mockScheduler.getStatus).toHaveBeenCalledWith('0');
    expect(coordinator.getState().nextTrackStatus).toBe(TRACK_STATUS.DOWNLOADING);

    // Track with track_id
    coordinator.updateQueue({ id: 1 }, [{ track_id: 99, title: 'Track 99' }]);
    expect(mockScheduler.getStatus).toHaveBeenCalledWith('99');
  });

  test('updateQueue() syncs scheduler without calling native preload', () => {
    const currentTrack = { id: 1 };
    const upNext = [
      { id: 2, title: 'Next' },
      { id: 3, title: 'NextNext' },
    ];

    coordinator.updateQueue(currentTrack, upNext);

    expect(mockScheduler.syncQueue).toHaveBeenCalledWith(currentTrack, upNext, {});
    expect(mockPreloadNative).not.toHaveBeenCalled();
  });

  test('detects slow network when player buffers for longer than 3.5s', () => {
    const states = [];
    coordinator.subscribe((s) => states.push(s.networkStatus));

    // Start buffering
    coordinator.handleBufferingStatus(true);
    expect(coordinator.getState().networkStatus).toBe('good');

    // Advance 3.5 seconds
    jest.advanceTimersByTime(3600);
    expect(coordinator.getState().networkStatus).toBe('slow');
    expect(coordinator.getState().isBufferingSlow).toBe(true);

    // Buffering ends
    coordinator.handleBufferingStatus(false);
    expect(coordinator.getState().networkStatus).toBe('good');
    expect(coordinator.getState().isBufferingSlow).toBe(false);
  });

  test('updates networkStatus to error when next track fails to preload', () => {
    const currentTrack = { id: 1 };
    const upNext = [{ id: 2, title: 'Next' }];
    coordinator.updateQueue(currentTrack, upNext);

    // Simulate scheduler failure event
    for (const listener of schedulerListeners) {
      listener({
        trackId: '2',
        status: TRACK_STATUS.FAILED,
        error: new Error('Network timeout'),
      });
    }

    expect(coordinator.getState().nextTrackStatus).toBe(TRACK_STATUS.FAILED);
    expect(coordinator.getState().networkStatus).toBe('error');
    expect(coordinator.getState().networkError).toBe('Network timeout');
  });

  test('updateQueue() skips native preload if next track is already cached locally', () => {
    mockCache.cached.set('2', 'file:///mock/2.mp3');
    const currentTrack = { id: 1 };
    const upNext = [{ id: 2, title: 'Next' }];

    coordinator.updateQueue(currentTrack, upNext);

    expect(mockScheduler.syncQueue).toHaveBeenCalled();
    expect(mockPreloadNative).not.toHaveBeenCalled();
  });

  test('play() falls back to remote stream URL if local replace throws an error', async () => {
    mockCache.cached.set('1', 'file:///mock/corrupt.mp3');
    mockPlayer.replace.mockImplementationOnce(() => {
      throw new Error('AVPlayer cannot read file');
    });

    const track = { id: 1, title: 'Corrupt Local Song', stream_url: 'https://puuk.app/api/stream/1' };
    const res = await coordinator.play(mockPlayer, track);

    expect(res.isLocal).toBe(false);
    expect(res.uri).toBe('https://puuk.app/api/stream/1');
    expect(mockPlayer.replace).toHaveBeenCalledTimes(2);
    expect(mockPlayer.play).toHaveBeenCalled();
  });

  test('play() bypasses cache when bypassCache option is true', async () => {
    mockCache.cached.set('1', 'file:///mock/1.mp3');
    coordinator.bypassCache = true;

    const track = { id: 1, title: 'Bypassed Cache Song', stream_url: 'https://puuk.app/api/stream/1' };
    const res = await coordinator.play(mockPlayer, track);

    expect(res.isLocal).toBe(false);
    expect(res.uri).toBe('https://puuk.app/api/stream/1');
    expect(mockPlayer.replace).toHaveBeenCalledWith({ uri: 'https://puuk.app/api/stream/1' });
    expect(mockCache.getCachedUri).not.toHaveBeenCalled();
  });

  describe('Idempotent playback', () => {
    test('does not re-run replace or trigger background cache when same track and source are re-played', async () => {
      const track = { id: 10, title: 'Idempotent Song', stream_url: 'https://puuk.app/api/stream/10' };
      const firstRes = await coordinator.play(mockPlayer, track);

      expect(firstRes.reused).toBeUndefined();
      expect(mockPlayer.replace).toHaveBeenCalledTimes(1);
      expect(mockCache.getOrFetch).toHaveBeenCalledTimes(1);
      expect(mockPlayer.play).toHaveBeenCalledTimes(1);

      mockPlayer.replace.mockClear();
      mockCache.getOrFetch.mockClear();
      mockPlayer.play.mockClear();

      const secondRes = await coordinator.play(mockPlayer, track);

      expect(secondRes.reused).toBe(true);
      expect(secondRes.uri).toBe('https://puuk.app/api/stream/10');
      expect(mockPlayer.replace).not.toHaveBeenCalled();
      expect(mockCache.getOrFetch).not.toHaveBeenCalled();
      expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    });

    test('reloads track when force: true is provided', async () => {
      const track = { id: 10, title: 'Forced Song', stream_url: 'https://puuk.app/api/stream/10' };
      await coordinator.play(mockPlayer, track);

      mockPlayer.replace.mockClear();
      const forcedRes = await coordinator.play(mockPlayer, track, { force: true });

      expect(forcedRes.reused).toBeUndefined();
      expect(mockPlayer.replace).toHaveBeenCalledTimes(1);
    });

    test('reloads if source URI changes between play calls', async () => {
      const track = { id: 10, title: 'Cache Transition Song', stream_url: 'https://puuk.app/api/stream/10' };
      const remoteRes = await coordinator.play(mockPlayer, track);
      expect(remoteRes.isLocal).toBe(false);

      // Cache finishes in the background
      mockCache.cached.set('10', 'file:///mock/10.mp3');
      mockPlayer.replace.mockClear();

      const localRes = await coordinator.play(mockPlayer, track);
      expect(localRes.reused).toBeUndefined();
      expect(localRes.isLocal).toBe(true);
      expect(localRes.uri).toBe('file:///mock/10.mp3');
      expect(mockPlayer.replace).toHaveBeenCalledWith({ uri: 'file:///mock/10.mp3' });
    });

    test('reloads if auth headers change between play calls for remote stream', async () => {
      const track = { id: 10, title: 'Header Change Song', stream_url: 'https://puuk.app/api/stream/10' };
      const res1 = await coordinator.play(mockPlayer, track, { headers: { Authorization: 'Bearer token_v1' } });
      expect(res1.reused).toBeUndefined();
      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'https://puuk.app/api/stream/10',
        headers: { Authorization: 'Bearer token_v1' },
      });

      mockPlayer.replace.mockClear();

      // Play with changed headers: must re-replace source
      const res2 = await coordinator.play(mockPlayer, track, { headers: { Authorization: 'Bearer token_v2' } });
      expect(res2.reused).toBeUndefined();
      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'https://puuk.app/api/stream/10',
        headers: { Authorization: 'Bearer token_v2' },
      });

      mockPlayer.replace.mockClear();

      // Play again with identical headers: must reuse source
      const res3 = await coordinator.play(mockPlayer, track, { headers: { Authorization: 'Bearer token_v2' } });
      expect(res3.reused).toBe(true);
      expect(mockPlayer.replace).not.toHaveBeenCalled();
    });

    test('throws classified play_error and updates coordinator state if player.play fails during idempotent resume', async () => {
      const track = { id: 10, title: 'Resume Fail Song', stream_url: 'https://puuk.app/api/stream/10' };
      await coordinator.play(mockPlayer, track);

      mockPlayer.play.mockImplementationOnce(() => {
        throw new Error('Audio session disrupted');
      });

      let thrownErr;
      try {
        await coordinator.play(mockPlayer, track);
      } catch (err) {
        thrownErr = err;
      }

      expect(thrownErr).toBeInstanceOf(PlaybackError);
      expect(thrownErr.type).toBe('play_error');
      expect(thrownErr.trackId).toBe('10');
      expect(coordinator.getState().networkStatus).toBe('error');
      expect(coordinator.getState().networkError).toBe('Audio session disrupted');
      expect(coordinator.lastErrorType).toBe('play_error');
    });

    test('records local_cache_error in lastCacheError on cache lookup failure before remote fallback', async () => {
      mockCache.getCachedUri.mockImplementationOnce(() => {
        throw new Error('Corrupt cache entry');
      });

      const track = { id: 42, title: 'Cache Error Track', stream_url: 'https://puuk.app/api/stream/42' };
      const res = await coordinator.play(mockPlayer, track);

      expect(res.isLocal).toBe(false);
      expect(res.uri).toBe('https://puuk.app/api/stream/42');
      expect(coordinator.lastCacheError).toBeInstanceOf(PlaybackError);
      expect(coordinator.lastCacheError.type).toBe('local_cache_error');
    });
  });

  describe('Generation token and rapid track switching', () => {
    test('supersedes slow track A when track B is requested concurrently', async () => {
      let resolveA;
      mockPlayer.replace.mockImplementationOnce(() => new Promise((resolve) => {
        resolveA = resolve;
      }));

      const trackA = { id: 100, title: 'Track A', stream_url: 'https://puuk.app/api/stream/100' };
      const trackB = { id: 200, title: 'Track B', stream_url: 'https://puuk.app/api/stream/200' };

      const playPromiseA = coordinator.play(mockPlayer, trackA);
      const playPromiseB = coordinator.play(mockPlayer, trackB);

      const resB = await playPromiseB;
      expect(resB.superseded).toBeUndefined();
      expect(resB.uri).toBe('https://puuk.app/api/stream/200');
      expect(coordinator.currentTrackId).toBe('200');

      resolveA();
      const resA = await playPromiseA;
      expect(resA.superseded).toBe(true);
      expect(coordinator.currentTrackId).toBe('200');
      expect(mockPlayer.setActiveForLockScreen).toHaveBeenLastCalledWith(
        true,
        expect.objectContaining({ title: 'Track B' }),
        expect.any(Object)
      );
    });

    test('re-applies current track source if slow track A replace finishes after track B has already played', async () => {
      let resolveA;
      mockPlayer.replace.mockImplementationOnce(() => new Promise((resolve) => {
        resolveA = resolve;
      }));

      const trackA = { id: 100, title: 'Slow Track A', stream_url: 'https://puuk.app/api/stream/100' };
      const trackB = { id: 200, title: 'Fast Track B', stream_url: 'https://puuk.app/api/stream/200' };

      const playPromiseA = coordinator.play(mockPlayer, trackA);
      const playPromiseB = coordinator.play(mockPlayer, trackB);

      // Track B finishes playing
      const resB = await playPromiseB;
      expect(resB.uri).toBe('https://puuk.app/api/stream/200');
      expect(coordinator.currentTrackId).toBe('200');

      // Now slow Track A's replace finally completes
      resolveA();
      const resA = await playPromiseA;
      expect(resA.superseded).toBe(true);

      // Final call on mockPlayer.replace MUST be Track B, not Track A!
      expect(mockPlayer.replace).toHaveBeenLastCalledWith(
        expect.objectContaining({ uri: 'https://puuk.app/api/stream/200' })
      );
    });

    test('suppresses error and network state pollution from superseded track A', async () => {
      let rejectA;
      mockPlayer.replace.mockImplementationOnce(() => new Promise((_, reject) => {
        rejectA = reject;
      }));

      const trackA = { id: 100, title: 'Slow Failing Track A', stream_url: 'https://puuk.app/api/stream/100' };
      const trackB = { id: 200, title: 'Healthy Track B', stream_url: 'https://puuk.app/api/stream/200' };

      const stateListener = jest.fn();
      coordinator.subscribe(stateListener);
      stateListener.mockClear();

      const playPromiseA = coordinator.play(mockPlayer, trackA);
      const playPromiseB = coordinator.play(mockPlayer, trackB);

      await playPromiseB;

      rejectA(new Error('Network error on track A'));
      const resA = await playPromiseA;

      expect(resA.superseded).toBe(true);
      expect(coordinator.getState().networkStatus).toBe('good');
      expect(coordinator.getState().networkError).toBeNull();
      expect(stateListener).not.toHaveBeenCalledWith(expect.objectContaining({ networkStatus: 'error' }));
    });

    test('destroy() invalidates and supersedes in-flight play operation', async () => {
      let resolveA;
      mockPlayer.replace.mockImplementationOnce(() => new Promise((resolve) => {
        resolveA = resolve;
      }));

      const trackA = { id: 100, title: 'In Flight Song', stream_url: 'https://puuk.app/api/stream/100' };
      const playPromiseA = coordinator.play(mockPlayer, trackA);

      coordinator.destroy();
      resolveA();

      const resA = await playPromiseA;
      expect(resA.superseded).toBe(true);
      expect(coordinator.currentTrackId).toBeNull();
      expect(coordinator.currentPlayUri).toBeNull();
    });
  });

  describe('Error classification (classifyPlaybackError & PlaybackError)', () => {
    test('returns existing PlaybackError unchanged', () => {
      const existing = new PlaybackError('Original', { type: 'local_cache_error', trackId: '5' });
      expect(classifyPlaybackError(existing)).toBe(existing);
    });

    test('classifies 401 and auth messages as auth_error', () => {
      const err1 = classifyPlaybackError({ status: 401, message: 'Forbidden' }, '1');
      expect(err1.type).toBe('auth_error');
      expect(err1.code).toBe('auth_error');
      expect(err1.trackId).toBe('1');

      const err2 = classifyPlaybackError(new Error('Unauthorized request'), '2');
      expect(err2.type).toBe('auth_error');

      const err3 = classifyPlaybackError(new Error('JWT auth expired'));
      expect(err3.type).toBe('auth_error');
    });

    test('classifies 408 and timeouts as network_timeout', () => {
      const err1 = classifyPlaybackError({ status: 408 }, '1');
      expect(err1.type).toBe('network_timeout');

      const err2 = classifyPlaybackError(new Error('Network connection timed out'));
      expect(err2.type).toBe('network_timeout');

      const err3 = classifyPlaybackError({ name: 'TimeoutError', message: 'The operation timed out' });
      expect(err3.type).toBe('network_timeout');
    });

    test('classifies play/playback failures as play_error', () => {
      const err1 = classifyPlaybackError(new Error('Failed to play sound'));
      expect(err1.type).toBe('play_error');

      const err2 = classifyPlaybackError(new Error('Audio playback device lost'));
      expect(err2.type).toBe('play_error');
    });

    test('classifies cache/local issues as local_cache_error', () => {
      const err1 = classifyPlaybackError(new Error('Local file does not exist'));
      expect(err1.type).toBe('local_cache_error');

      const err2 = classifyPlaybackError(new Error('Cache read failure'));
      expect(err2.type).toBe('local_cache_error');
    });

    test('classifies unhandled errors as remote_replace_error by default', () => {
      const err = classifyPlaybackError(new Error('HTTP 500 Internal Server Error'), '7');
      expect(err.type).toBe('remote_replace_error');
      expect(err.cause).toBeDefined();
      expect(err.trackId).toBe('7');
    });

    test('play() throws classified PlaybackError on remote replace failure and updates state', async () => {
      mockPlayer.replace.mockImplementation(() => {
        throw new Error('Remote item failed to load: HTTP 503');
      });

      const track = { id: 300, title: 'Broken Remote Song', stream_url: 'https://puuk.app/api/stream/300' };

      await expect(coordinator.play(mockPlayer, track)).rejects.toThrow(PlaybackError);
      expect(coordinator.getState().networkStatus).toBe('error');
      expect(coordinator.getState().lastErrorType).toBe('remote_replace_error');
      expect(coordinator.getState().networkError).toContain('HTTP 503');
    });

    test('play() throws classified PlaybackError on player.play failure and updates state', async () => {
      mockPlayer.play.mockImplementationOnce(() => {
        throw new Error('AVPlayerItem playback failed');
      });

      const track = { id: 400, title: 'Broken Play Song', stream_url: 'https://puuk.app/api/stream/400' };

      await expect(coordinator.play(mockPlayer, track)).rejects.toThrow(PlaybackError);
      expect(coordinator.getState().networkStatus).toBe('error');
      expect(coordinator.getState().lastErrorType).toBe('play_error');
    });

    test('play() rejects invalid stream URL with remote_replace_error', async () => {
      coordinator.serverUrl = 'ftp://bad-server.fun';
      const track = { id: 500, title: 'Invalid URL Song' };

      let thrownErr;
      try {
        await coordinator.play(mockPlayer, track);
      } catch (err) {
        thrownErr = err;
      }

      expect(thrownErr).toBeInstanceOf(PlaybackError);
      expect(thrownErr.type).toBe('remote_replace_error');
      expect(thrownErr.trackId).toBe('500');
    });
  });

  describe('Diagnostic log gating', () => {
    test('silences console.log and console.warn during normal playback when debug is false', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      coordinator.debug = false;
      const track = { id: 600, title: 'Silent Song', stream_url: 'https://puuk.app/api/stream/600' };
      await coordinator.play(mockPlayer, track);

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    test('prints diagnostic messages when debug is true', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      coordinator.debug = true;
      const track = { id: 700, title: 'Verbose Song', stream_url: 'https://puuk.app/api/stream/700' };
      await coordinator.play(mockPlayer, track);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Coordinator][Stage 1: normalize_url]'),
        expect.any(Object)
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Coordinator][Stage 4: player_play]'),
        expect.any(Object)
      );

      logSpy.mockRestore();
    });
  });

  describe('updateLockScreenMetadata', () => {
    test('does not overwrite lock screen if track is superseded', async () => {
      mockPlayer.setActiveForLockScreen.mockClear();
      coordinator.currentTrack = { id: 2, title: 'Newer Track' };

      // Older track 1 attempts to update lock screen
      await coordinator.updateLockScreenMetadata(mockPlayer, { id: 1, title: 'Older Track' });
      expect(mockPlayer.setActiveForLockScreen).not.toHaveBeenCalled();

      // isCurrent check returning false
      await coordinator.updateLockScreenMetadata(mockPlayer, { id: 2, title: 'Newer Track' }, () => false);
      expect(mockPlayer.setActiveForLockScreen).not.toHaveBeenCalled();

      // Current track updates successfully
      await coordinator.updateLockScreenMetadata(mockPlayer, { id: 2, title: 'Newer Track' }, () => true);
      expect(mockPlayer.setActiveForLockScreen).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ title: 'Newer Track' }),
        expect.any(Object)
      );
    });
  });

  describe('normalizeStreamUrl', () => {
    test('builds standard url when stream_url is missing', () => {
      const url = normalizeStreamUrl({ id: 42 }, 'https://web.puuk.fun');
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('strips trailing slashes from serverUrl to prevent double slashes', () => {
      const url = normalizeStreamUrl({ id: 42 }, 'https://web.puuk.fun/');
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('normalizes relative /api/stream path', () => {
      const url = normalizeStreamUrl({ id: 42, stream_url: '/api/stream/42' }, 'https://web.puuk.fun');
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('replaces host with active serverUrl if stream_url contains different host', () => {
      const url = normalizeStreamUrl({ id: 42, stream_url: 'http://127.0.0.1:8000/api/stream/42' }, 'https://web.puuk.fun');
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('trims quotes and whitespace', () => {
      const url = normalizeStreamUrl({ id: ' 42 ', stream_url: ' "/api/stream/42" ' }, ' https://web.puuk.fun ');
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('cleans double slashes in path', () => {
      const url = normalizeStreamUrl({ id: 42, stream_url: '/api/stream//42' }, 'https://web.puuk.fun//');
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('strictly preserves https:// and http:// protocol double slashes', () => {
      const httpsUrl = normalizeStreamUrl({ id: 123 }, 'https://web.puuk.fun');
      expect(httpsUrl).toBe('https://web.puuk.fun/api/stream/123');
      expect(httpsUrl.startsWith('https://')).toBe(true);
      expect(httpsUrl.includes('https:/w')).toBe(false);

      const httpUrl = normalizeStreamUrl({ id: 123 }, 'http://192.168.1.50:8000');
      expect(httpUrl).toBe('http://192.168.1.50:8000/api/stream/123');
      expect(httpUrl.startsWith('http://')).toBe(true);
      expect(httpUrl.includes('http:/1')).toBe(false);
    });
  });
});
