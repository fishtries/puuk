import {
  PlaybackCoordinator,
  normalizeStreamUrl,
  PlaybackError,
  classifyPlaybackError,
} from '../playbackCoordinator';
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
      getOrFetch: jest.fn((id, url) =>
        Promise.resolve(`file:///mock/${id}.audio`),
      ),
      cancel: jest.fn(),
      setProtectedTrackIds: jest.fn(),
    };

    schedulerListeners = new Set();
    mockScheduler = {
      syncQueue: jest.fn(),
      getStatus: jest.fn(() => TRACK_STATUS.IDLE),
      getError: jest.fn(() => null),
      setPlaybackPressure: jest.fn(),
      cancelAll: jest.fn(),
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
    expect(mockPlayer.replace).toHaveBeenCalledWith({
      uri: 'file:///mock/1.mp3',
    });
    expect(mockPlayer.play).toHaveBeenCalled();
    expect(mockPlayer.setActiveForLockScreen).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ title: 'Cached Song' }),
      expect.any(Object),
    );
  });

  test('play() delays background cache for five seconds after starting the remote stream', async () => {
    const track = {
      id: 2,
      title: 'Remote Song',
      stream_url: 'https://puuk.app/api/stream/2',
    };
    const headers = { Authorization: 'Bearer token123' };

    const res = await coordinator.play(mockPlayer, track, { headers });

    expect(res.isLocal).toBe(false);
    expect(res.uri).toBe('https://puuk.app/api/stream/2');
    expect(mockPlayer.replace).toHaveBeenCalledWith({
      uri: 'https://puuk.app/api/stream/2',
      headers,
    });
    expect(mockPlayer.play).toHaveBeenCalled();
    // Streaming starts immediately; disk caching waits until the delay expires.
    expect(mockCache.getOrFetch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(4999);
    expect(mockCache.getOrFetch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(mockCache.getOrFetch).toHaveBeenCalledWith(
      '2',
      'https://puuk.app/api/stream/2',
      { headers },
    );
  });

  test('play() plays cached track without calling getHeadersAsync, and calls getHeadersAsync only for remote stream', async () => {
    const getHeadersAsyncMock = jest
      .fn()
      .mockResolvedValue({ Authorization: 'Bearer async_token' });

    // 1. Local track
    mockCache.cached.set('10', 'file:///mock/10.mp3');
    const localTrack = { id: 10, title: 'Local Song' };
    const localRes = await coordinator.play(mockPlayer, localTrack, {
      getHeadersAsync: getHeadersAsyncMock,
    });

    expect(localRes.isLocal).toBe(true);
    expect(mockPlayer.replace).toHaveBeenCalledWith({
      uri: 'file:///mock/10.mp3',
    });
    expect(getHeadersAsyncMock).not.toHaveBeenCalled();

    // 2. Remote track
    mockPlayer.replace.mockClear();
    const remoteTrack = {
      id: 20,
      title: 'Remote Song',
      stream_url: 'https://puuk.app/api/stream/20',
    };
    const remoteRes = await coordinator.play(mockPlayer, remoteTrack, {
      getHeadersAsync: getHeadersAsyncMock,
    });

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
    expect(mockPlayer.replace).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'https://puuk.app/api/stream/0' }),
    );
  });

  test('play() accepts track DTO with track_id instead of id', async () => {
    const track = { track_id: 42, title: 'DTO Track ID Song' };
    const res = await coordinator.play(mockPlayer, track);

    expect(coordinator.currentTrackId).toBe('42');
    expect(res.uri).toBe('https://puuk.app/api/stream/42');
    expect(mockPlayer.replace).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'https://puuk.app/api/stream/42' }),
    );
  });

  test('updateQueue() handles next track with id: 0 and track_id', () => {
    mockScheduler.getStatus.mockReturnValue(TRACK_STATUS.DOWNLOADING);

    // Track with id: 0
    coordinator.updateQueue({ id: 1 }, [{ id: 0, title: 'Zero Track' }]);
    expect(mockScheduler.getStatus).toHaveBeenCalledWith('0');
    expect(coordinator.getState().nextTrackStatus).toBe(
      TRACK_STATUS.DOWNLOADING,
    );

    // Track with track_id
    coordinator.updateQueue({ id: 1 }, [{ track_id: 99, title: 'Track 99' }]);
    expect(mockScheduler.getStatus).toHaveBeenCalledWith('99');
  });

  test('updateQueue protects currentTrack and queue IDs including legacy track_id and ID 0', () => {
    coordinator.updateQueue({ track_id: 'legacy-cur' }, [
      { track_id: 'legacy-q1' },
      { id: 0 },
    ]);

    expect(mockCache.setProtectedTrackIds).toHaveBeenCalledWith([
      'legacy-cur',
      'legacy-q1',
      0,
    ]);
  });

  test('scheduler events match next track canonical identity across id and track_id forms', () => {
    coordinator.updateQueue({ id: 1 }, [
      { track_id: 'q-status-1', title: 'Next' },
    ]);

    // Trigger scheduler event with canonical ID
    coordinator._handleSchedulerEvent({
      trackId: 'q-status-1',
      status: TRACK_STATUS.READY,
    });

    expect(coordinator.getState().nextTrackStatus).toBe(TRACK_STATUS.READY);
    expect(coordinator.getState().networkStatus).toBe('good');
  });

  test('updateQueue() syncs scheduler without calling native preload', () => {
    const currentTrack = { id: 1 };
    const upNext = [
      { id: 2, title: 'Next' },
      { id: 3, title: 'NextNext' },
    ];

    coordinator.updateQueue(currentTrack, upNext);

    expect(mockScheduler.syncQueue).toHaveBeenCalledWith(
      currentTrack,
      upNext,
      {},
    );
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

    const track = {
      id: 1,
      title: 'Corrupt Local Song',
      stream_url: 'https://puuk.app/api/stream/1',
    };
    const res = await coordinator.play(mockPlayer, track);

    expect(res.isLocal).toBe(false);
    expect(res.uri).toBe('https://puuk.app/api/stream/1');
    expect(mockPlayer.replace).toHaveBeenCalledTimes(2);
    expect(mockPlayer.play).toHaveBeenCalled();
  });

  test('play() bypasses cache when bypassCache option is true', async () => {
    mockCache.cached.set('1', 'file:///mock/1.mp3');
    coordinator.bypassCache = true;

    const track = {
      id: 1,
      title: 'Bypassed Cache Song',
      stream_url: 'https://puuk.app/api/stream/1',
    };
    const res = await coordinator.play(mockPlayer, track);

    expect(res.isLocal).toBe(false);
    expect(res.uri).toBe('https://puuk.app/api/stream/1');
    expect(mockPlayer.replace).toHaveBeenCalledWith({
      uri: 'https://puuk.app/api/stream/1',
    });
    expect(mockCache.getCachedUri).not.toHaveBeenCalled();
  });

  describe('Idempotent playback', () => {
    test('does not re-run replace or trigger background cache when same track and source are re-played', async () => {
      const track = {
        id: 10,
        title: 'Idempotent Song',
        stream_url: 'https://puuk.app/api/stream/10',
      };
      const firstRes = await coordinator.play(mockPlayer, track);

      expect(firstRes.reused).toBeUndefined();
      expect(mockPlayer.replace).toHaveBeenCalledTimes(1);
      expect(mockCache.getOrFetch).not.toHaveBeenCalled();
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
      const track = {
        id: 10,
        title: 'Forced Song',
        stream_url: 'https://puuk.app/api/stream/10',
      };
      await coordinator.play(mockPlayer, track);

      mockPlayer.replace.mockClear();
      const forcedRes = await coordinator.play(mockPlayer, track, {
        force: true,
      });

      expect(forcedRes.reused).toBeUndefined();
      expect(mockPlayer.replace).toHaveBeenCalledTimes(1);
    });

    test('reloads if source URI changes between play calls', async () => {
      const track = {
        id: 10,
        title: 'Cache Transition Song',
        stream_url: 'https://puuk.app/api/stream/10',
      };
      const remoteRes = await coordinator.play(mockPlayer, track);
      expect(remoteRes.isLocal).toBe(false);

      // Cache finishes in the background
      mockCache.cached.set('10', 'file:///mock/10.mp3');
      mockPlayer.replace.mockClear();

      const localRes = await coordinator.play(mockPlayer, track);
      expect(localRes.reused).toBeUndefined();
      expect(localRes.isLocal).toBe(true);
      expect(localRes.uri).toBe('file:///mock/10.mp3');
      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'file:///mock/10.mp3',
      });
    });

    test('reloads if auth headers change between play calls for remote stream', async () => {
      const track = {
        id: 10,
        title: 'Header Change Song',
        stream_url: 'https://puuk.app/api/stream/10',
      };
      const res1 = await coordinator.play(mockPlayer, track, {
        headers: { Authorization: 'Bearer token_v1' },
      });
      expect(res1.reused).toBeUndefined();
      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'https://puuk.app/api/stream/10',
        headers: { Authorization: 'Bearer token_v1' },
      });

      mockPlayer.replace.mockClear();

      // Play with changed headers: must re-replace source
      const res2 = await coordinator.play(mockPlayer, track, {
        headers: { Authorization: 'Bearer token_v2' },
      });
      expect(res2.reused).toBeUndefined();
      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'https://puuk.app/api/stream/10',
        headers: { Authorization: 'Bearer token_v2' },
      });

      mockPlayer.replace.mockClear();

      // Play again with identical headers: must reuse source
      const res3 = await coordinator.play(mockPlayer, track, {
        headers: { Authorization: 'Bearer token_v2' },
      });
      expect(res3.reused).toBe(true);
      expect(mockPlayer.replace).not.toHaveBeenCalled();
    });

    test('throws classified play_error and updates coordinator state if player.play fails during idempotent resume', async () => {
      const track = {
        id: 10,
        title: 'Resume Fail Song',
        stream_url: 'https://puuk.app/api/stream/10',
      };
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
      expect(coordinator.getState().networkError).toBe(
        'Audio session disrupted',
      );
      expect(coordinator.lastErrorType).toBe('play_error');
    });

    test('records local_cache_error in lastCacheError on cache lookup failure before remote fallback', async () => {
      mockCache.getCachedUri.mockImplementationOnce(() => {
        throw new Error('Corrupt cache entry');
      });

      const track = {
        id: 42,
        title: 'Cache Error Track',
        stream_url: 'https://puuk.app/api/stream/42',
      };
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
      mockPlayer.replace.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      );

      const trackA = {
        id: 100,
        title: 'Track A',
        stream_url: 'https://puuk.app/api/stream/100',
      };
      const trackB = {
        id: 200,
        title: 'Track B',
        stream_url: 'https://puuk.app/api/stream/200',
      };

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
        expect.any(Object),
      );
    });

    test('re-applies current track source if slow track A replace finishes after track B has already played', async () => {
      let resolveA;
      mockPlayer.replace.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      );

      const trackA = {
        id: 100,
        title: 'Slow Track A',
        stream_url: 'https://puuk.app/api/stream/100',
      };
      const trackB = {
        id: 200,
        title: 'Fast Track B',
        stream_url: 'https://puuk.app/api/stream/200',
      };

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
        expect.objectContaining({ uri: 'https://puuk.app/api/stream/200' }),
      );
    });

    test('suppresses error and network state pollution from superseded track A', async () => {
      let rejectA;
      mockPlayer.replace.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectA = reject;
          }),
      );

      const trackA = {
        id: 100,
        title: 'Slow Failing Track A',
        stream_url: 'https://puuk.app/api/stream/100',
      };
      const trackB = {
        id: 200,
        title: 'Healthy Track B',
        stream_url: 'https://puuk.app/api/stream/200',
      };

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
      expect(stateListener).not.toHaveBeenCalledWith(
        expect.objectContaining({ networkStatus: 'error' }),
      );
    });

    test('destroy() invalidates and supersedes in-flight play operation', async () => {
      let resolveA;
      mockPlayer.replace.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      );

      const trackA = {
        id: 100,
        title: 'In Flight Song',
        stream_url: 'https://puuk.app/api/stream/100',
      };
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
      const existing = new PlaybackError('Original', {
        type: 'local_cache_error',
        trackId: '5',
      });
      expect(classifyPlaybackError(existing)).toBe(existing);
    });

    test('classifies structured 401 and 403 status as auth_error', () => {
      const err1 = classifyPlaybackError(
        { status: 401, message: 'Forbidden' },
        '1',
      );
      expect(err1.type).toBe('auth_error');
      expect(err1.code).toBe('auth_error');
      expect(err1.trackId).toBe('1');

      const err2 = classifyPlaybackError(
        { statusCode: 403, message: 'Forbidden' },
        '2',
      );
      expect(err2.type).toBe('auth_error');

      const err3 = classifyPlaybackError({ response: { status: 401 } });
      expect(err3.type).toBe('auth_error');
    });

    test('classifies 408 and timeouts as network_timeout', () => {
      const err1 = classifyPlaybackError({ status: 408 }, '1');
      expect(err1.type).toBe('network_timeout');

      const err2 = classifyPlaybackError(
        new Error('Network connection timed out'),
      );
      expect(err2.type).toBe('network_timeout');

      const err3 = classifyPlaybackError({
        name: 'TimeoutError',
        message: 'The operation timed out',
      });
      expect(err3.type).toBe('network_timeout');
    });

    test('classifies play/playback failures as play_error', () => {
      const err1 = classifyPlaybackError(new Error('Failed to play sound'));
      expect(err1.type).toBe('play_error');

      const err2 = classifyPlaybackError(
        new Error('Audio playback device lost'),
      );
      expect(err2.type).toBe('play_error');
    });

    test('classifies cache/local issues as local_cache_error', () => {
      const err1 = classifyPlaybackError(
        new Error('Local file does not exist'),
      );
      expect(err1.type).toBe('local_cache_error');

      const err2 = classifyPlaybackError(new Error('Cache read failure'));
      expect(err2.type).toBe('local_cache_error');
    });

    test('classifies unhandled errors as remote_replace_error by default', () => {
      const err = classifyPlaybackError(
        new Error('HTTP 500 Internal Server Error'),
        '7',
      );
      expect(err.type).toBe('remote_replace_error');
      expect(err.cause).toBeDefined();
      expect(err.trackId).toBe('7');
    });

    test('play() throws classified PlaybackError on remote replace failure and updates state', async () => {
      mockPlayer.replace.mockImplementation(() => {
        throw new Error('Remote item failed to load: HTTP 503');
      });

      const track = {
        id: 300,
        title: 'Broken Remote Song',
        stream_url: 'https://puuk.app/api/stream/300',
      };

      await expect(coordinator.play(mockPlayer, track)).rejects.toThrow(
        PlaybackError,
      );
      expect(coordinator.getState().networkStatus).toBe('error');
      expect(coordinator.getState().lastErrorType).toBe('remote_replace_error');
      expect(coordinator.getState().networkError).toContain('HTTP 503');
    });

    test('play() throws classified PlaybackError on player.play failure and updates state', async () => {
      mockPlayer.play.mockImplementationOnce(() => {
        throw new Error('AVPlayerItem playback failed');
      });

      const track = {
        id: 400,
        title: 'Broken Play Song',
        stream_url: 'https://puuk.app/api/stream/400',
      };

      await expect(coordinator.play(mockPlayer, track)).rejects.toThrow(
        PlaybackError,
      );
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
      const track = {
        id: 600,
        title: 'Silent Song',
        stream_url: 'https://puuk.app/api/stream/600',
      };
      await coordinator.play(mockPlayer, track);

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    test('debug diagnostics retain safe categories without printing source details', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      coordinator.debug = true;
      await coordinator.play(mockPlayer, {
        id: 700,
        title: 'Private title',
        stream_url: 'https://puuk.app/api/stream/700?secret=value',
      });
      expect(logSpy).not.toHaveBeenCalled();
      const entries = JSON.stringify(coordinator._diagnosticsRing);
      expect(entries).not.toContain('Private title');
      expect(entries).not.toContain('https://');
      expect(entries).not.toContain('secret');
      logSpy.mockRestore();
    });
  });

  describe('updateLockScreenMetadata', () => {
    test('does not overwrite lock screen if track is superseded', async () => {
      mockPlayer.setActiveForLockScreen.mockClear();
      coordinator.currentTrack = { id: 2, title: 'Newer Track' };

      // Older track 1 attempts to update lock screen
      await coordinator.updateLockScreenMetadata(mockPlayer, {
        id: 1,
        title: 'Older Track',
      });
      expect(mockPlayer.setActiveForLockScreen).not.toHaveBeenCalled();

      // isCurrent check returning false
      await coordinator.updateLockScreenMetadata(
        mockPlayer,
        { id: 2, title: 'Newer Track' },
        () => false,
      );
      expect(mockPlayer.setActiveForLockScreen).not.toHaveBeenCalled();

      // Current track updates successfully
      await coordinator.updateLockScreenMetadata(
        mockPlayer,
        { id: 2, title: 'Newer Track' },
        () => true,
      );
      expect(mockPlayer.setActiveForLockScreen).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ title: 'Newer Track' }),
        expect.any(Object),
      );
    });
  });

  describe('Immediate lock screen metadata on track transition', () => {
    test('play() applies lock screen metadata immediately before replace() resolves', async () => {
      let resolveReplace;
      mockPlayer.replace.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReplace = resolve;
          }),
      );

      const track = {
        id: 999,
        title: 'Instant Metadata Song',
        artist: 'Instant Artist',
        album: 'Instant Album',
        coverArt: 'https://puuk.app/api/cover/999',
      };

      const playPromise = coordinator.play(mockPlayer, track);

      // Metadata MUST already be applied even while replace is still pending!
      expect(mockPlayer.setActiveForLockScreen).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          title: 'Instant Metadata Song',
          artist: 'Instant Artist',
          albumTitle: 'Instant Album',
          artworkUrl: expect.stringContaining('/api/cover/999'),
        }),
        expect.any(Object),
      );

      // Now resolve replace and complete playback
      resolveReplace();
      await playPromise;

      expect(mockPlayer.play).toHaveBeenCalled();
    });

    test('updateQueue() prefetches cover art for the upcoming track in queue', () => {
      const CoverImage = require('../../shared/media/CoverImage');
      const prefetchSpy = jest
        .spyOn(CoverImage, 'prefetchCover')
        .mockImplementation(() => {});

      const current = { id: 1, title: 'Current' };
      const upNext = [
        {
          id: 2,
          title: 'Next Track',
          coverArt: 'https://puuk.app/api/cover/2',
        },
      ];

      coordinator.updateQueue(current, upNext);

      expect(prefetchSpy).toHaveBeenCalledWith('https://puuk.app/api/cover/2');
      prefetchSpy.mockRestore();
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
      const url = normalizeStreamUrl(
        { id: 42, stream_url: '/api/stream/42' },
        'https://web.puuk.fun',
      );
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('replaces host with active serverUrl if stream_url contains different host', () => {
      const url = normalizeStreamUrl(
        { id: 42, stream_url: 'http://127.0.0.1:8000/api/stream/42' },
        'https://web.puuk.fun',
      );
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('trims quotes and whitespace', () => {
      const url = normalizeStreamUrl(
        { id: ' 42 ', stream_url: ' "/api/stream/42" ' },
        ' https://web.puuk.fun ',
      );
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('cleans double slashes in path', () => {
      const url = normalizeStreamUrl(
        { id: 42, stream_url: '/api/stream//42' },
        'https://web.puuk.fun//',
      );
      expect(url).toBe('https://web.puuk.fun/api/stream/42');
    });

    test('strictly preserves https:// and http:// protocol double slashes', () => {
      const httpsUrl = normalizeStreamUrl({ id: 123 }, 'https://web.puuk.fun');
      expect(httpsUrl).toBe('https://web.puuk.fun/api/stream/123');
      expect(httpsUrl.startsWith('https://')).toBe(true);
      expect(httpsUrl.includes('https:/w')).toBe(false);

      const httpUrl = normalizeStreamUrl(
        { id: 123 },
        'http://192.168.1.50:8000',
      );
      expect(httpUrl).toBe('http://192.168.1.50:8000/api/stream/123');
      expect(httpUrl.startsWith('http://')).toBe(true);
      expect(httpUrl.includes('http:/1')).toBe(false);
    });
  });

  describe('Track Loudness Normalization in play()', () => {
    test('sets player.volume to attenuated level when track is analyzed with negative gain', async () => {
      const track = {
        id: 10,
        title: 'Loud Track',
        stream_url: 'https://puuk.app/api/stream/10',
        loudness_status: 'analyzed',
        normalization_gain_db: -6.0,
      };

      await coordinator.play(mockPlayer, track, { soundCheck: true });

      expect(mockPlayer.volume).toBeCloseTo(0.501187, 4);
    });

    test('sets player.volume to 1.0 when soundCheck is disabled', async () => {
      const track = {
        id: 11,
        title: 'Loud Track with Sound Check Off',
        stream_url: 'https://puuk.app/api/stream/11',
        loudness_status: 'analyzed',
        normalization_gain_db: -6.0,
      };

      await coordinator.play(mockPlayer, track, { soundCheck: false });

      expect(mockPlayer.volume).toBe(1.0);
    });

    test('sets player.volume to 1.0 when track loudness is pending', async () => {
      const track = {
        id: 12,
        title: 'Pending Loudness Track',
        stream_url: 'https://puuk.app/api/stream/12',
        loudness_status: 'pending',
        normalization_gain_db: null,
      };

      await coordinator.play(mockPlayer, track, { soundCheck: true });

      expect(mockPlayer.volume).toBe(1.0);
    });

    test('re-applies player.volume during idempotent playback resume', async () => {
      const track = {
        id: 13,
        title: 'Idempotent Track',
        stream_url: 'https://puuk.app/api/stream/13',
        loudness_status: 'analyzed',
        normalization_gain_db: -4.0,
      };

      await coordinator.play(mockPlayer, track, { soundCheck: true });
      const firstVol = mockPlayer.volume;
      expect(firstVol).toBeCloseTo(0.630957, 4);

      // Simulate player volume getting reset externally
      mockPlayer.volume = 1.0;

      // Resume idempotent play
      await coordinator.play(mockPlayer, track, { soundCheck: true });
      expect(mockPlayer.volume).toBeCloseTo(0.630957, 4);
    });
  });

  describe('Dynamic URL configuration and server switch (Gate A / J06)', () => {
    let originalServerUrl;

    beforeEach(() => {
      const api = require('../../shared/api/api');
      originalServerUrl = api.SERVER_URL;
    });

    afterEach(() => {
      const api = require('../../shared/api/api');
      api.setServerUrl(originalServerUrl);
    });

    test('explicit serverUrl option stays fixed for dependency injection even if global SERVER_URL changes', async () => {
      const coord = new PlaybackCoordinator({
        serverUrl: 'https://fixed.server.org',
        cache: mockCache,
        scheduler: mockScheduler,
      });

      const api = require('../../shared/api/api');
      api.setServerUrl('https://global-changed.server.org');

      const track = { id: 701 };
      await coord.play(mockPlayer, track);

      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'https://fixed.server.org/api/stream/701',
      });
      expect(coord.serverUrl).toBe('https://fixed.server.org');
    });

    test('getServerUrl option is called dynamically at play() time', async () => {
      let currentBackend = 'https://backend-a.org';
      const coord = new PlaybackCoordinator({
        getServerUrl: () => currentBackend,
        cache: mockCache,
        scheduler: mockScheduler,
      });

      await coord.play(mockPlayer, { id: 702 });
      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'https://backend-a.org/api/stream/702',
      });

      currentBackend = 'https://backend-b.org';
      await coord.play(mockPlayer, { id: 703 });
      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'https://backend-b.org/api/stream/703',
      });
    });

    test('default coordinator instance resolves updated SERVER_URL loaded after singleton import', async () => {
      const coord = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
      });

      const api = require('../../shared/api/api');
      api.setServerUrl('https://settings-loaded.puuk.fun');

      const track = { id: 704 };
      await coord.play(mockPlayer, track);

      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'https://settings-loaded.puuk.fun/api/stream/704',
      });
      expect(coord.serverUrl).toBe('https://settings-loaded.puuk.fun');
    });

    test('server change at play boundary cancels background cache timers and scheduler work', async () => {
      const cancelAllMock = jest.fn();
      const customScheduler = {
        ...mockScheduler,
        cancelAll: cancelAllMock,
      };

      const api = require('../../shared/api/api');
      api.setServerUrl('https://first-origin.puuk.fun');

      const coord = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: customScheduler,
        backgroundCacheDelayMs: 5000,
      });

      await coord.play(mockPlayer, { id: 801 });
      expect(coord._backgroundCacheTimer).not.toBeNull();

      // Change server in settings
      api.setServerUrl('https://second-origin.puuk.fun');

      // Play new track under new server
      await coord.play(mockPlayer, { id: 802 });

      expect(cancelAllMock).toHaveBeenCalled();
      expect(mockPlayer.replace).toHaveBeenCalledWith({
        uri: 'https://second-origin.puuk.fun/api/stream/802',
      });
    });

    test('already-playing healthy source is preserved across rerender without audio replacement, while new selection uses new server', async () => {
      const api = require('../../shared/api/api');
      api.setServerUrl('https://server-initial.puuk.fun');

      const coord = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
      });

      // User selects track 901
      const track1 = { id: 901, title: 'Playing Track' };
      const res1 = await coord.play(mockPlayer, track1, {
        isUserSelection: true,
      });
      expect(res1.uri).toBe('https://server-initial.puuk.fun/api/stream/901');
      expect(mockPlayer.replace).toHaveBeenCalledTimes(1);
      expect(mockPlayer.play).toHaveBeenCalledTimes(1);

      // Server changes in background settings
      api.setServerUrl('https://server-updated.puuk.fun');

      // A component rerender calls play() without force or isUserSelection
      const rerenderRes = await coord.play(mockPlayer, track1);
      expect(rerenderRes.reused).toBe(true);
      expect(rerenderRes.uri).toBe(
        'https://server-initial.puuk.fun/api/stream/901',
      );
      // replace must NOT have been called again!
      expect(mockPlayer.replace).toHaveBeenCalledTimes(1);

      // Explicit retry on track 1 with force: true DOES install from new server
      const retryRes = await coord.play(mockPlayer, track1, { force: true });
      expect(retryRes.reused).toBeFalsy();
      expect(retryRes.uri).toBe(
        'https://server-updated.puuk.fun/api/stream/901',
      );
      expect(mockPlayer.replace).toHaveBeenCalledTimes(2);

      // Genuine selection of another track DOES install from new server
      const track2 = { id: 902, title: 'Next Track' };
      const res2 = await coord.play(mockPlayer, track2, {
        isUserSelection: true,
      });
      expect(res2.uri).toBe('https://server-updated.puuk.fun/api/stream/902');
      expect(mockPlayer.replace).toHaveBeenCalledTimes(3);
    });

    test('deferred replace completing after server switch cannot install or alter new source state', async () => {
      const api = require('../../shared/api/api');
      api.setServerUrl('https://server-slow.puuk.fun');

      const coord = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
      });

      let slowReplaceResolve;
      const slowReplacePromise = new Promise((resolve) => {
        slowReplaceResolve = resolve;
      });

      // Track 1 starts on server-slow with a replace call that is deferred/delayed
      mockPlayer.replace.mockImplementationOnce(() => slowReplacePromise);

      const p1 = coord.play(mockPlayer, { id: 950 }, { isUserSelection: true });
      await Promise.resolve();

      // Before slow replace resolves, server changes in settings and user starts track 2 on server-fast
      api.setServerUrl('https://server-fast.puuk.fun');
      mockPlayer.replace.mockImplementationOnce(() => Promise.resolve());

      const p2 = coord.play(mockPlayer, { id: 951 }, { isUserSelection: true });
      const res2 = await p2;
      expect(res2.uri).toBe('https://server-fast.puuk.fun/api/stream/951');
      expect(coord.currentTrackId).toBe('951');

      // Now the slow replace from server-slow finishes late
      slowReplaceResolve();
      const res1 = await p1;
      expect(res1.superseded).toBe(true);

      // Current source state must NOT have been corrupted or reverted to track 950
      expect(coord.currentTrackId).toBe('951');
      expect(coord.currentPlayUri).toBe(
        'https://server-fast.puuk.fun/api/stream/951',
      );
    });
  });

  describe('J07 — Coordinator: confirmed playback start, recovery and native source identity', () => {
    function createIdentifiedPlayer(overrides = {}) {
      return {
        puukSourceIdentityVersion: 1,
        replaceWithAttempt: jest.fn(() => true),
        playForAttempt: jest.fn(() => true),
        seekForAttempt: jest.fn(() => true),
        replace: jest.fn(() => Promise.resolve()),
        play: jest.fn(() => Promise.resolve()),
        pause: jest.fn(() => Promise.resolve()),
        seekTo: jest.fn(() => Promise.resolve()),
        setActiveForLockScreen: jest.fn(),
        ...overrides,
      };
    }

    test('fails closed on legacy binary missing native identity capability', async () => {
      const legacyPlayer = {
        replace: jest.fn(() => Promise.resolve()),
        play: jest.fn(() => Promise.resolve()),
        pause: jest.fn(() => Promise.resolve()),
        setActiveForLockScreen: jest.fn(),
      };

      const res = await coordinator.play(legacyPlayer, {
        id: 101,
        title: 'Legacy Song',
      });

      expect(coordinator.identityAvailable).toBe(false);
      expect(res.confirmation).toBe('unavailable');
      expect(res.sourceAttemptId).toBeDefined();

      // Native status handler returns accepted: false on legacy player/events
      const statusRes = coordinator.handleNativeStatus(legacyPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        currentTime: 2.5,
      });
      expect(statusRes.accepted).toBe(false);
    });

    test('command return, loaded, and non-advancing progress do not confirm playback', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const track = { id: 201, title: 'Unconfirmed Song' };

      const res = await coordinator.play(identifiedPlayer, track);

      expect(coordinator.identityAvailable).toBe(true);
      expect(res.confirmation).toBe('pending');
      expect(coordinator.getState().current.status).toBe('starting');

      // 1. Loaded event is not confirmation
      const loadedRes = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'loaded',
        isLoaded: true,
        playing: false,
        currentTime: 0,
      });
      expect(loadedRes.accepted).toBe(true);
      expect(loadedRes.didStart).toBe(false);
      expect(coordinator.getState().current.status).toBe('starting');

      // 2. Zero position progress is not confirmation
      const zeroProgRes = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 0,
      });
      expect(zeroProgRes.didStart).toBe(false);
      expect(coordinator.getState().current.status).toBe('starting');

      // 3. Advancing finite progress confirms playback (didStart = true once)
      const firstAdvancing = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 0.5,
      });
      expect(firstAdvancing.didStart).toBe(true);
      expect(coordinator.getState().current.status).toBe('playing');

      // 4. Duplicate position does not re-trigger didStart
      const dupProg = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 0.5,
      });
      expect(dupProg.didStart).toBe(false);
    });

    test('sustainable progress proof ends startup episode and releases background pressure', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      let fakeTime = 1000;
      const coordWithClock = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
        clock: () => fakeTime,
      });

      const res = await coordWithClock.play(identifiedPlayer, { id: 202 });
      expect(mockScheduler.setPlaybackPressure).toHaveBeenCalledWith({
        requestId: res.requestId,
        phase: 'startup',
      });

      // First progress event at t = 1000, pos = 0.5
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 0.5,
      });

      // Second progress event at t = 2200 (delta 1200ms >= 1000ms), pos = 1.0 (advance 0.5 >= 0.25)
      fakeTime = 2200;
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 1.0,
      });

      expect(mockScheduler.setPlaybackPressure).toHaveBeenCalledWith({
        requestId: res.requestId,
        phase: 'stable',
      });
      coordWithClock.destroy();
    });

    test('native asynchronous error after successful play triggers single recovery after 800ms', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const track = { id: 301, title: 'Corrupt Stream' };

      const res = await coordinator.play(identifiedPlayer, track);
      expect(res.confirmation).toBe('pending');

      // Asynchronous error event arrives
      const errorEvent = {
        sourceIdentityVersion: 1,
        intentRevision: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Transport stream corrupted'),
      };
      coordinator.handleNativeStatus(identifiedPlayer, errorEvent);

      expect(coordinator.getState().current.status).toBe('recovering');
      expect(coordinator.getState().current.recoveryCount).toBe(1);

      // Before 800ms: recovery has not replaced source yet
      expect(identifiedPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(799);
      expect(identifiedPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1);

      // At 800ms: recovery runs with fresh attempt ID
      jest.advanceTimersByTime(1);
      expect(identifiedPlayer.replaceWithAttempt).toHaveBeenCalledTimes(2);
      const newAttemptId = identifiedPlayer.replaceWithAttempt.mock.calls[1][1];
      expect(newAttemptId).not.toBe(res.sourceAttemptId);
      expect(identifiedPlayer.playForAttempt).toHaveBeenCalledTimes(2);

      // Second error event on the recovered attempt is terminal in this episode
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        intentRevision: 1,
        sourceAttemptId: newAttemptId,
        nativeEvent: 'error',
        error: new Error('Second failure'),
      });

      expect(coordinator.getState().current.status).toBe('error');
      expect(coordinator.getState().networkStatus).toBe('error');
    });

    test('local cache error invalidates exact used URI and falls back to remote stream', async () => {
      mockCache.cached.set('401', 'file:///mock/bad_track.mp3');
      mockCache.invalidate = jest.fn(() => Promise.resolve(true));

      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordinator.play(identifiedPlayer, { id: 401 });

      expect(res.isLocal).toBe(true);
      expect(res.uri).toBe('file:///mock/bad_track.mp3');

      // Native error on local attempt
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        intentRevision: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Failed to decode local file'),
      });

      expect(mockCache.invalidate).toHaveBeenCalledWith(
        '401',
        'file:///mock/bad_track.mp3',
      );
      expect(coordinator.getState().current.status).toBe('recovering');

      // Advance 800ms recovery delay
      jest.advanceTimersByTime(800);

      // Recovery should fall back to remote stream
      expect(identifiedPlayer.replaceWithAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'https://puuk.app/api/stream/401' }),
        expect.any(String),
        1,
        res.sourceAttemptId,
      );
    });

    test('startup watchdog (15s) and stall watchdog (10s) respect total 30s episode budget', async () => {
      let fakeTime = 0;
      const coordWithClock = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
        clock: () => fakeTime,
        startupTimeoutMs: 15000,
        stallTimeoutMs: 10000,
        episodeTotalMs: 30000,
        recoveryDelayMs: 800,
      });

      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordWithClock.play(identifiedPlayer, { id: 501 });
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'snapshot',
        nativeIntent: 'play',
        intentRevision: 1,
      });

      // Advance 15,000ms without progress: startup watchdog fires
      fakeTime = 15000;
      jest.advanceTimersByTime(15000);

      expect(coordWithClock.getState().current.status).toBe('recovering');

      // Advance 800ms recovery delay
      fakeTime = 15800;
      jest.advanceTimersByTime(800);

      const recoveredAttempt =
        coordWithClock.getState().current.sourceAttemptId;
      expect(recoveredAttempt).not.toBe(res.sourceAttemptId);

      // Advancing progress arrives on recovered attempt
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: recoveredAttempt,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 2.0,
      });
      expect(coordWithClock.getState().current.status).toBe('playing');

      // Stall for 10,000ms
      fakeTime += 10000;
      jest.advanceTimersByTime(10000);

      // Since recoveryCount is already 1, stall watchdog terminates with timeout error
      expect(coordWithClock.getState().current.status).toBe('error');
      expect(coordWithClock.getState().current.error.kind).toBe('timeout');

      coordWithClock.destroy();
    });

    test('A/B/A track switching rejects stale events from prior attempts and old revisions', async () => {
      const identifiedPlayer = createIdentifiedPlayer();

      // Track A (attempt 1)
      const resA1 = await coordinator.play(
        identifiedPlayer,
        { id: 'A' },
        { requestId: 'req_A1' },
      );
      const attemptA1 = resA1.sourceAttemptId;

      // User selects Track B (attempt 2)
      const resB = await coordinator.play(
        identifiedPlayer,
        { id: 'B' },
        { requestId: 'req_B' },
      );
      const attemptB = resB.sourceAttemptId;

      // Delayed error from Track A attempt 1 arrives
      const staleRes = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: attemptA1,
        nativeEvent: 'error',
        error: new Error('Late failure from A1'),
      });
      expect(staleRes.accepted).toBe(false);
      expect(coordinator.getState().current.trackId).toBe('B');
      expect(coordinator.getState().current.status).toBe('starting');

      // User selects Track A again (attempt 3)
      const resA2 = await coordinator.play(
        identifiedPlayer,
        { id: 'A' },
        { requestId: 'req_A2' },
      );
      const attemptA2 = resA2.sourceAttemptId;
      expect(attemptA2).not.toBe(attemptA1);

      // Stale progress from A1 arrives
      const staleProg = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: attemptA1,
        nativeEvent: 'progress',
        currentTime: 5.0,
      });
      expect(staleProg.accepted).toBe(false);

      // Rejection of older intent revisions
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: attemptA2,
        nativeEvent: 'intent',
        nativeIntent: 'pause',
        intentRevision: 5,
      });

      const staleRevision = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: attemptA2,
        nativeEvent: 'progress',
        intentRevision: 4,
        currentTime: 1.0,
      });
      expect(staleRevision.accepted).toBe(false);
    });

    test('concurrent retryCurrent calls share a single promise and start fresh episode', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      await coordinator.play(identifiedPlayer, { id: 601 });

      // Trigger error to set error state
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: coordinator.getState().current.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Test error'),
      });
      jest.advanceTimersByTime(800); // let auto-recovery fire
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: coordinator.getState().current.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Terminal error'),
      });
      expect(coordinator.getState().current.status).toBe('error');

      // Double-tap retry
      const p1 = coordinator.retryCurrent(identifiedPlayer);
      const p2 = coordinator.retryCurrent(identifiedPlayer);

      expect(p1).toBe(p2); // Exactly same promise

      for (let i = 0; i < 30; i++) await Promise.resolve();
      const attempt = coordinator.current.sourceAttemptId;
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: attempt,
        intentRevision: 1,
        nativeEvent: 'loaded',
        nativeIntent: 'play',
        isLoaded: true,
      });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: attempt,
        intentRevision: 1,
        nativeEvent: 'seek',
        nativeIntent: 'play',
        seekOrigin: 'recovery',
        seekCompleted: true,
        currentTime: 0,
      });
      const retryRes = await p1;
      expect(retryRes.reused).toBeFalsy();
      expect(coordinator.getState().current.status).toBe('starting');
      expect(coordinator.getState().current.error).toBeNull();
    });

    test('user pause during loading or recovery cancels recovery and prevents autoplay', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordinator.play(identifiedPlayer, { id: 701 });

      // Trigger error to start recovery timer
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Recoverable error'),
      });
      expect(coordinator.getState().current.status).toBe('recovering');

      // User pauses while recovery is waiting in 800ms backoff
      await coordinator.setIntent(identifiedPlayer, { type: 'pause' });
      expect(coordinator.getState().current.intent).toBe('pause');
      expect(coordinator.getState().current.status).toBe('paused');

      // Advance timers: recovery timer was cancelled, player.playForAttempt is NOT called
      jest.advanceTimersByTime(1000);
      expect(identifiedPlayer.playForAttempt).toHaveBeenCalledTimes(1); // Only initial play call
      expect(coordinator.getState().current.status).toBe('paused');
    });

    test('next-ready scheduler event cannot clear current track error', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      await coordinator.play(identifiedPlayer, { id: 801 });

      // Setup queue with next track 802
      coordinator.updateQueue({ id: 801 }, [{ id: 802 }]);

      // Trigger terminal error on current track 801
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: coordinator.getState().current.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Current track broken'),
      });
      jest.advanceTimersByTime(800);
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: coordinator.getState().current.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Current track permanently broken'),
      });

      expect(coordinator.getState().networkStatus).toBe('error');
      expect(coordinator.getState().current.status).toBe('error');

      // Scheduler reports NEXT track is ready
      for (const listener of schedulerListeners) {
        listener({ trackId: '802', status: TRACK_STATUS.READY });
      }

      // Next status is ready, but current error is preserved!
      expect(coordinator.getState().next.status).toBe(TRACK_STATUS.READY);
      expect(coordinator.getState().current.status).toBe('error');
      expect(coordinator.getState().networkStatus).toBe('error');
      expect(coordinator.getState().current.error).not.toBeNull();
    });

    test('guarded false returned by native replace/play never triggers unguarded fallback', async () => {
      const identifiedPlayer = createIdentifiedPlayer({
        replaceWithAttempt: jest.fn(() => false),
        playForAttempt: jest.fn(() => false),
      });

      const res = await coordinator.play(identifiedPlayer, { id: 901 });

      // Rejected replacement returns superseded: true
      expect(res.superseded).toBe(true);
      // It must NEVER fall back to player.replace or player.play!
      expect(identifiedPlayer.replace).not.toHaveBeenCalled();
      expect(identifiedPlayer.play).not.toHaveBeenCalled();
    });

    test('bounded diagnostics ring buffer contains sanitized entries without tokens or URLs', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordinator.play(identifiedPlayer, {
        id: 999,
        stream_url: 'https://puuk.app/api/stream/999?token=secret123',
      });

      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 1.0,
      });

      const diagnostics = coordinator.getDiagnostics();
      expect(Array.isArray(diagnostics)).toBe(true);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.length).toBeLessThanOrEqual(200);

      // Verify no sensitive fields in any diagnostic entry
      for (const entry of diagnostics) {
        expect(entry).toHaveProperty('time');
        expect(entry).toHaveProperty('phase');
        const str = JSON.stringify(entry);
        expect(str).not.toContain('secret123');
        expect(str).not.toContain('https://');
        expect(str).not.toContain('Authorization');
      }
    });

    test('root repro 1: loaded and snapshot events never mark didStart or transition to playing', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordinator.play(identifiedPlayer, { id: 210 });

      for (const ev of ['loaded', 'snapshot', 'seek']) {
        const r = coordinator.handleNativeStatus(identifiedPlayer, {
          sourceIdentityVersion: 1,
          sourceAttemptId: res.sourceAttemptId,
          intentRevision: 0,
          nativeEvent: ev,
          nativeIntent: 'play',
          isLoaded: true,
          playing: true,
          currentTime: 10,
        });
        expect(r.didStart).toBe(false);
        expect(coordinator.getState().current.status).toBe('starting');
      }
    });

    test('root repro 1b: native system resume requires strictly newer play revision; equal revision does not resume', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordinator.play(identifiedPlayer, { id: 211 });

      // User pauses at intentRevision 3
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        intentRevision: 3,
        nativeEvent: 'intent',
        nativeIntent: 'pause',
      });
      expect(coordinator.getState().current.intent).toBe('pause');
      expect(coordinator.getState().current.status).toBe('paused');

      // Stale play event with equal intentRevision 3 arrives: must NOT resume!
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        intentRevision: 3,
        nativeEvent: 'intent',
        nativeIntent: 'play',
      });
      expect(coordinator.getState().current.intent).toBe('pause');
      expect(coordinator.getState().current.status).toBe('paused');

      // System resume with strictly newer intentRevision 4 arrives: DOES resume to starting!
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        intentRevision: 4,
        nativeEvent: 'intent',
        nativeIntent: 'play',
      });
      expect(coordinator.getState().current.intent).toBe('play');
      expect(coordinator.getState().current.status).toBe('starting');
    });

    test('root repro 2: native pause during deferred headers in recovery cancels recovery with zero replacement and no autoplay', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      let callCount = 0;
      let resolveHeaders;
      const deferredHeaders = new Promise((resolve) => {
        resolveHeaders = resolve;
      });

      const res = await coordinator.play(
        identifiedPlayer,
        { id: 220 },
        {
          getHeadersAsync: () => {
            callCount++;
            if (callCount === 1)
              return Promise.resolve({ Authorization: 'Bearer initial' });
            return deferredHeaders;
          },
        },
      );
      expect(identifiedPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1);

      // Native error triggers recovery
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Transport stream failed'),
      });
      expect(coordinator.getState().current.status).toBe('recovering');

      // Advance 800ms backoff: recovery begins, but getHeadersAsync is deferred
      jest.advanceTimersByTime(800);
      expect(identifiedPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1); // not replaced yet

      // Old installed native attempt receives pause while headers are pending
      const pauseRes = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId, // Old attempt is STILL accepted!
        intentRevision: 2,
        nativeEvent: 'intent',
        nativeIntent: 'pause',
      });
      expect(pauseRes.accepted).toBe(true);
      expect(coordinator.getState().current.intent).toBe('pause');
      expect(coordinator.getState().current.status).toBe('paused');

      // Now headers finish resolving
      resolveHeaders({ Authorization: 'Bearer refreshed_token' });
      await Promise.resolve();
      await Promise.resolve();

      // Zero additional replacement commands and zero autoplay!
      expect(identifiedPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1);
      expect(identifiedPlayer.playForAttempt).toHaveBeenCalledTimes(1); // Only initial play call
      expect(coordinator.getState().current.status).toBe('paused');
    });

    test('root repro 3: recovery seek rejection or completion timeout asserts zero play commands; loaded wait is required', async () => {
      // Scenario A: seekForAttempt returns false
      const playerSeekReject = createIdentifiedPlayer({
        seekForAttempt: jest.fn(() => false),
      });

      const resA = await coordinator.play(playerSeekReject, { id: 231 });
      coordinator.handleNativeStatus(playerSeekReject, {
        sourceIdentityVersion: 1,
        intentRevision: 1,
        sourceAttemptId: resA.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 15.0,
      });

      // Error triggers recovery
      coordinator.handleNativeStatus(playerSeekReject, {
        sourceIdentityVersion: 1,
        intentRevision: 1,
        sourceAttemptId: resA.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Stall in middle of track'),
      });
      jest.advanceTimersByTime(800);

      // Recovery replaces stream; wait for loaded arrives
      expect(playerSeekReject.replaceWithAttempt).toHaveBeenCalledTimes(2);
      const attempt2 = playerSeekReject.replaceWithAttempt.mock.calls[1][1];

      // Native emits loaded event for attempt2
      coordinator.handleNativeStatus(playerSeekReject, {
        sourceIdentityVersion: 1,
        sourceAttemptId: attempt2,
        nativeEvent: 'loaded',
        intentRevision: 1,
        isLoaded: true,
      });
      for (let i = 0; i < 30; i++) await Promise.resolve();

      // seekForAttempt was reached and returned false
      expect(playerSeekReject.seekForAttempt).toHaveBeenCalledTimes(1);
      // Zero play commands on recovered attempt!
      expect(playerSeekReject.playForAttempt).toHaveBeenCalledTimes(1); // only initial call
      expect(coordinator.getState().current.status).toBe('error');

      // Scenario B: seek completion timeout (5s)
      const playerSeekTimeout = createIdentifiedPlayer({
        seekForAttempt: jest.fn(() => true),
      });

      const resB = await coordinator.play(playerSeekTimeout, { id: 232 });
      coordinator.handleNativeStatus(playerSeekTimeout, {
        sourceIdentityVersion: 1,
        intentRevision: 1,
        sourceAttemptId: resB.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 25.0,
      });

      coordinator.handleNativeStatus(playerSeekTimeout, {
        sourceIdentityVersion: 1,
        intentRevision: 1,
        sourceAttemptId: resB.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Stall'),
      });
      jest.advanceTimersByTime(800);

      const attemptB2 = playerSeekTimeout.replaceWithAttempt.mock.calls[1][1];
      coordinator.handleNativeStatus(playerSeekTimeout, {
        sourceIdentityVersion: 1,
        sourceAttemptId: attemptB2,
        nativeEvent: 'loaded',
        intentRevision: 1,
        isLoaded: true,
      });
      for (let i = 0; i < 30; i++) await Promise.resolve();

      expect(playerSeekTimeout.seekForAttempt).toHaveBeenCalledTimes(1);

      // Advance 5000ms seek completion timeout without seekCompleted event
      jest.advanceTimersByTime(5000);
      for (let i = 0; i < 30; i++) await Promise.resolve();

      // playForAttempt was NEVER called on attemptB2
      expect(playerSeekTimeout.playForAttempt).toHaveBeenCalledTimes(1);
      expect(coordinator.getState().current.status).toBe('error');
    });

    test('backward user seek resets progress baseline and suppresses confirmation while pending', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordinator.play(identifiedPlayer, { id: 233 });

      // Play up to 60s
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 60.0,
      });
      expect(coordinator.getState().current.positionSeconds).toBe(60.0);

      // User seeks backwards to 10s
      await coordinator.setIntent(identifiedPlayer, {
        type: 'seek',
        positionSeconds: 10.0,
      });
      expect(coordinator.getState().current.positionSeconds).toBe(10.0);

      // Progress at 10.2s arriving while seek is pending is NOT confirmation
      const pendingProg = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 10.2,
      });
      expect(pendingProg.accepted).toBe(true);
      expect(pendingProg.didStart).toBe(false);

      // Seek completes at 10.0s
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'seek',
        seekCompleted: true,
        currentTime: 10.0,
      });

      // Subsequent progress at 10.5s is accepted as advancing beyond reset baseline
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 10.5,
      });
      expect(coordinator.getState().current.positionSeconds).toBe(10.5);
      expect(coordinator.getState().current.status).toBe('playing');
    });

    test('root repro 4: hard 30s global episode deadline terminates at exact 30000ms', async () => {
      let fakeTime = 0;
      const coordWithClock = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
        clock: () => fakeTime,
      });

      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordWithClock.play(identifiedPlayer, { id: 241 });
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'snapshot',
        nativeIntent: 'play',
        intentRevision: 1,
      });

      // Startup watchdog fires at 15000ms
      fakeTime = 15000;
      jest.advanceTimersByTime(15000);
      expect(coordWithClock.getState().current.status).toBe('recovering');

      // Recovery replacement at 15800ms
      fakeTime = 15800;
      jest.advanceTimersByTime(800);
      expect(coordWithClock.getState().current.status).toBe('recovering');

      // Advance to exact 30,000ms from original selection
      fakeTime = 30000;
      jest.advanceTimersByTime(14200);

      // At exact 30,000ms, hard episode timeout fires
      expect(coordWithClock.getState().current.status).toBe('error');
      expect(coordWithClock.getState().current.error.kind).toBe('timeout');

      coordWithClock.destroy();
    });

    test('single progress blip does not clear 30s startup episode; only sustainable proof does', async () => {
      let fakeTime = 0;
      const coordWithClock = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
        clock: () => fakeTime,
      });

      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordWithClock.play(identifiedPlayer, { id: 242 });

      // A single progress blip at t = 5000ms
      fakeTime = 5000;
      jest.advanceTimersByTime(5000);
      const blip = coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 0.5,
      });
      expect(blip.didStart).toBe(true);

      // No second progress event arrives. At t = 30000ms, startup episode expires!
      fakeTime = 30000;
      jest.advanceTimersByTime(25000);

      expect(coordWithClock.getState().current.status).toBe('error');
      expect(coordWithClock.getState().current.error.kind).toBe('timeout');

      coordWithClock.destroy();
    });

    test('later stall episode deadline is anchored to last accepted progress before stall', async () => {
      let fakeTime = 0;
      const coordWithClock = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
        clock: () => fakeTime,
      });

      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordWithClock.play(identifiedPlayer, { id: 243 });

      // Progress 1 at 1000ms
      fakeTime = 1000;
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 0.5,
      });

      // Progress 2 at 2200ms -> sustainable proof!
      fakeTime = 2200;
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 1.2,
      });

      // Progress 3 at 20000ms -> last progress before stall!
      fakeTime = 20000;
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 10.0,
      });

      // 10s stall watchdog fires at t = 30000ms
      fakeTime = 30000;
      jest.advanceTimersByTime(10000);
      expect(coordWithClock.getState().current.status).toBe('stalled');

      // Stall episode deadline is 20000 + 30000 = 50000ms (NOT 30000 + 30000 = 60000ms!)
      expect(coordWithClock._stallEpisodeDeadline).toBe(50000);

      coordWithClock.destroy();
    });

    test('legacy player has no attributed watchdogs and plays past 30s without false error', async () => {
      let fakeTime = 0;
      const coordWithClock = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
        clock: () => fakeTime,
      });

      const legacyPlayer = {
        replace: jest.fn(() => Promise.resolve()),
        play: jest.fn(() => Promise.resolve()),
        pause: jest.fn(() => Promise.resolve()),
        setActiveForLockScreen: jest.fn(),
      };

      await coordWithClock.play(legacyPlayer, { id: 244 });
      expect(coordWithClock.identityAvailable).toBe(false);

      // Advance to 35,000ms without any native events
      fakeTime = 35000;
      jest.advanceTimersByTime(35000);

      // Must NOT terminate with false error
      expect(coordWithClock.getState().current.status).toBe('starting');
      expect(coordWithClock.getState().networkStatus).toBe('good');
      expect(coordWithClock.getState().current.error).toBeNull();

      coordWithClock.destroy();
    });

    test('hanging headers during recovery times out within remaining episode budget', async () => {
      let fakeTime = 0;
      const coordWithClock = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
        clock: () => fakeTime,
        headerTimeoutMs: 5000,
      });

      const identifiedPlayer = createIdentifiedPlayer();
      let callCount = 0;
      let neverResolveHeaders = new Promise(() => {});

      const res = await coordWithClock.play(
        identifiedPlayer,
        { id: 245 },
        {
          getHeadersAsync: () => {
            callCount++;
            if (callCount === 1)
              return Promise.resolve({ Authorization: 'Bearer initial' });
            return neverResolveHeaders;
          },
        },
      );

      // Error triggers recovery
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        intentRevision: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Stream disconnect'),
      });

      // 800ms backoff
      fakeTime = 800;
      jest.advanceTimersByTime(800);

      // Advance 5000ms: header timeout fires
      fakeTime += 5000;
      jest.advanceTimersByTime(5000);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(coordWithClock.getState().current.status).toBe('error');
      expect(coordWithClock.getState().current.error.kind).toBe('timeout');

      coordWithClock.destroy();
    });

    test('paused retry preserves pause intent, restores seek position and avoids duplicate didStart', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordinator.play(
        identifiedPlayer,
        { id: 310 },
        { requestId: 'logical-req-1' },
      );

      // Confirm first progress
      const firstProg = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 10.0,
      });
      expect(firstProg.didStart).toBe(true);

      // Seek to 42s and pause
      await coordinator.setIntent(identifiedPlayer, {
        type: 'seek',
        positionSeconds: 42.0,
      });
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'seek',
        seekCompleted: true,
        currentTime: 42.0,
      });
      await coordinator.setIntent(identifiedPlayer, { type: 'pause' });
      expect(coordinator.getState().current.intent).toBe('pause');

      const playCountBefore = identifiedPlayer.playForAttempt.mock.calls.length;
      const seekCountBefore = identifiedPlayer.seekForAttempt.mock.calls.length;

      // Retry acknowledges the newly installed source and its technical seek.
      const retry = coordinator.retryCurrent(identifiedPlayer);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      const retryAttempt = coordinator.current.sourceAttemptId;
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: retryAttempt,
        nativeEvent: 'loaded',
        nativeIntent: 'pause',
        intentRevision: 3,
        isLoaded: true,
        currentTime: 0,
      });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: retryAttempt,
        nativeEvent: 'seek',
        nativeIntent: 'pause',
        intentRevision: 3,
        seekOrigin: 'recovery',
        seekCompleted: true,
        currentTime: 42,
      });
      await retry;

      // Pause intent is preserved
      expect(coordinator.getState().current.intent).toBe('pause');
      expect(coordinator.getState().current.status).toBe('paused');
      // No extra play commands issued
      expect(identifiedPlayer.playForAttempt.mock.calls.length).toBe(
        playCountBefore,
      );
      // Position 42.0 is restored
      expect(identifiedPlayer.seekForAttempt.mock.calls.length).toBeGreaterThan(
        seekCountBefore,
      );
      expect(coordinator.getState().current.positionSeconds).toBe(42.0);

      // Subsequent progress on the same logical request does NOT duplicate didStart
      const retryProg = coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: coordinator.getState().current.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 42.5,
      });
      expect(retryProg.didStart).toBe(false);
    });

    test('getHeaders provider alias is invoked and passed to source replacement', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      let providerCalls = 0;

      await coordinator.play(
        identifiedPlayer,
        { id: 320 },
        {
          getHeaders: async () => {
            providerCalls++;
            return { 'X-Custom-Auth': 'token123' };
          },
        },
      );

      expect(providerCalls).toBe(1);
      expect(identifiedPlayer.replaceWithAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Custom-Auth': 'token123' }),
        }),
        expect.any(String),
        null,
        null,
      );
    });

    test('stale intent after cancelCurrent/logout is rejected without issuing unguarded commands', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      await coordinator.play(
        identifiedPlayer,
        { id: 330 },
        { requestId: 'req-to-cancel' },
      );

      // Cancel on logout
      coordinator.cancelCurrent('logout');
      expect(coordinator.getState().current.status).toBe('idle');
      expect(coordinator.getState().current.requestId).toBeNull();

      const legacyPlayBefore = identifiedPlayer.play.mock.calls.length;
      const guardedPlayBefore =
        identifiedPlayer.playForAttempt.mock.calls.length;

      // Caller attempts to setIntent with old request ID
      await coordinator.setIntent(identifiedPlayer, {
        type: 'play',
        requestId: 'req-to-cancel',
      });

      // Zero commands issued!
      expect(identifiedPlayer.play.mock.calls.length).toBe(legacyPlayBefore);
      expect(identifiedPlayer.playForAttempt.mock.calls.length).toBe(
        guardedPlayBefore,
      );
      expect(coordinator.getState().current.status).toBe('idle');
    });

    test('selection request identity: each distinct user selection gets a distinct requestId', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const ids = [];

      for (const trackId of ['A', 'B', 'A']) {
        const res = await coordinator.play(
          identifiedPlayer,
          { id: trackId },
          { isUserSelection: true },
        );
        ids.push(res.requestId);
      }

      expect(new Set(ids).size).toBe(3);
    });

    test('native error classification does not misclassify words containing auth substring like author', () => {
      const classified = classifyPlaybackError(
        new Error('synthetic author codec failure'),
        'track-1',
      );
      expect(classified.type).not.toBe('auth_error');
      expect(classified.type).toBe('remote_replace_error');
    });

    test('native text stays generic without numeric HTTP status', () => {
      for (const text of [
        'author codec failure',
        'unauthorized codec failure',
        '401 synthetic codec failure',
        'not found decoder',
      ]) {
        const e = classifyPlaybackError(new Error(text), 'fixture');
        expect(['auth', 'auth_error', 'not_found']).not.toContain(e.type);
      }
    });

    test('obsolete header failure cannot fail new track', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      let rejectHeaders;
      let n = 0;
      const pendingHeaders = new Promise((_, reject) => {
        rejectHeaders = reject;
      });

      const resA = await coordinator.play(
        identifiedPlayer,
        { id: 'A' },
        {
          getHeaders: () => (++n === 1 ? Promise.resolve({}) : pendingHeaders),
        },
      );
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        intentRevision: 1,
        sourceAttemptId: resA.sourceAttemptId,
        nativeEvent: 'error',
        error: new Error('Transport stream failed'),
      });
      jest.advanceTimersByTime(800);

      // Now user selects track B
      await coordinator.play(
        identifiedPlayer,
        { id: 'B' },
        { getHeaders: async () => ({}) },
      );

      // Old A headers reject late
      rejectHeaders(new Error('Synthetic cancelled header error'));
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // B must remain unaffected and healthy
      expect(coordinator.getState().current.trackId).toBe('B');
      expect(coordinator.getState().current.status).not.toBe('error');
    });

    test('obsolete retry cannot seek new track', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const resA = await coordinator.play(
        identifiedPlayer,
        { id: 'A' },
        { requestId: 'A-selection' },
      );
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: resA.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 42.0,
      });

      await coordinator.setIntent(identifiedPlayer, { type: 'pause' });

      let resolveHeaders;
      const deferredHeaders = new Promise((resolve) => {
        resolveHeaders = resolve;
      });
      const retryPromise = coordinator.retryCurrent(identifiedPlayer, {
        getHeaders: () => deferredHeaders,
      });
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // User selects track B while retry is pending
      await coordinator.play(
        identifiedPlayer,
        { id: 'B' },
        { requestId: 'B-selection', getHeaders: async () => ({}) },
      );

      const seekCountBefore = identifiedPlayer.seekForAttempt.mock.calls.length;

      // Old headers resolve late
      resolveHeaders({});
      await retryPromise;
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Obsolete retry must NOT seek track B!
      expect(identifiedPlayer.seekForAttempt.mock.calls.length).toBe(
        seekCountBefore,
      );
    });

    test('equal revision progress cannot undo pause', async () => {
      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordinator.play(identifiedPlayer, { id: 'rev-test' });
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 1.0,
      });

      await coordinator.setIntent(identifiedPlayer, { type: 'pause' });
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        intentRevision: 1,
        nativeEvent: 'intent',
        nativeIntent: 'pause',
      });

      // Equal revision progress arriving with nativeIntent play must NOT change paused status
      coordinator.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        intentRevision: 1,
        nativeEvent: 'progress',
        nativeIntent: 'play',
        isLoaded: true,
        playing: true,
        currentTime: 2.0,
      });
      expect(coordinator.getState().current.status).toBe('paused');
    });

    test('healthy confirmed resume does not expire at original 30s episode', async () => {
      let fakeTime = 0;
      const coordWithClock = new PlaybackCoordinator({
        cache: mockCache,
        scheduler: mockScheduler,
        clock: () => fakeTime,
      });

      const identifiedPlayer = createIdentifiedPlayer();
      const res = await coordWithClock.play(identifiedPlayer, {
        id: 'resume-healthy',
      });

      // Progress 1 & 2 -> sustainable proof
      fakeTime = 1000;
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 1.0,
      });
      fakeTime = 2200;
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 2.0,
      });

      // Pause and resume
      await coordWithClock.setIntent(identifiedPlayer, { type: 'pause' });
      fakeTime += 1000;
      jest.advanceTimersByTime(1000);
      await coordWithClock.setIntent(identifiedPlayer, { type: 'play' });

      // Progress 3 & 4 post-resume -> sustainable proof post-resume!
      fakeTime += 1000;
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 3.0,
      });
      fakeTime += 1200;
      coordWithClock.handleNativeStatus(identifiedPlayer, {
        sourceIdentityVersion: 1,
        sourceAttemptId: res.sourceAttemptId,
        nativeEvent: 'progress',
        isLoaded: true,
        playing: true,
        nativeIntent: 'play',
        currentTime: 4.0,
      });

      // Advance past 30s with healthy advancing progress every 5s
      for (let i = 0; i < 6; i++) {
        fakeTime += 5000;
        jest.advanceTimersByTime(5000);
        coordWithClock.handleNativeStatus(identifiedPlayer, {
          sourceIdentityVersion: 1,
          sourceAttemptId: res.sourceAttemptId,
          nativeEvent: 'progress',
          isLoaded: true,
          playing: true,
          nativeIntent: 'play',
          currentTime: 9.0 + i * 5,
        });
      }

      expect(coordWithClock.getState().current.status).toBe('playing');
      expect(coordWithClock.getState().networkStatus).toBe('good');

      coordWithClock.destroy();
    });
  });
});

describe('public Retry with native source and revision guards', () => {
  let c, player, installed, revision, intent, position, listeners, results;
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const emit = (nativeEvent, extra = {}) => {
    const event = {
      sourceIdentityVersion: 1,
      sourceAttemptId: installed,
      intentRevision: revision,
      nativeIntent: intent,
      nativeEvent,
      currentTime: position,
      isLoaded: true,
      playing: intent === 'play',
      ...extra,
    };
    for (const listener of listeners) listener(event);
  };
  beforeEach(() => {
    jest.useFakeTimers();
    installed = null;
    revision = 0;
    intent = 'pause';
    position = 0;
    listeners = new Set();
    results = [];
    player = {
      puukSourceIdentityVersion: 1,
      addListener: jest.fn((name, listener) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      }),
      replaceWithAttempt: jest.fn(
        (source, attempt, expectedRevision, expectedAttempt) => {
          if (
            expectedRevision !== null &&
            (revision !== expectedRevision ||
              intent !== 'play' ||
              installed !== expectedAttempt)
          )
            return false;
          installed = attempt;
          position = 0;
          return true;
        },
      ),
      playForAttempt: jest.fn((attempt, expectedRevision) => {
        if (
          attempt !== installed ||
          (expectedRevision !== null &&
            (expectedRevision !== revision || intent !== 'play'))
        )
          return false;
        intent = 'play';
        revision++;
        emit('intent');
        return true;
      }),
      seekForAttempt: jest.fn((attempt, target, expectedRevision) => {
        if (
          attempt !== installed ||
          (expectedRevision !== null && revision !== expectedRevision)
        )
          return false;
        const origin = expectedRevision === null ? 'user' : 'recovery';
        if (origin === 'user') revision++;
        emit('seekIntent', { seekOrigin: origin, seekTargetSeconds: target });
        position = target;
        return true;
      }),
      pause: jest.fn(() => {
        intent = 'pause';
        revision++;
        emit('intent');
      }),
      replace: jest.fn(),
      play: jest.fn(),
      seekTo: jest.fn(),
      setActiveForLockScreen: jest.fn(),
    };
    c = new PlaybackCoordinator({
      cache: { getCachedUri: () => null, isCached: () => false },
      scheduler: {
        addListener: () => () => {},
        setPlaybackPressure: jest.fn(),
        cancelAll: jest.fn(),
        syncQueue: jest.fn(),
      },
      clock: () => performance.now(),
      serverUrl: 'https://fixture.invalid',
      bypassCache: true,
    });
    player.addListener('playbackStatusUpdate', (event) =>
      results.push(c.handleNativeStatus(player, event)),
    );
  });
  afterEach(() => {
    c.destroy();
    jest.useRealTimers();
  });
  async function start(paused = false) {
    await c.play(player, { id: 'A' }, { requestId: 'selection-A' });
    position = 12;
    emit('progress');
    expect(results.filter((x) => x.didStart)).toHaveLength(1);
    if (paused) await c.setIntent(player, { type: 'pause' });
  }
  async function ready() {
    emit('loaded');
    await flush();
  }
  async function seekAck(extra = {}) {
    emit('seek', { seekOrigin: 'recovery', seekCompleted: true, ...extra });
    await flush();
  }

  test.each([false, true])(
    'Retry preserves position/intent and history; paused=%s',
    async (paused) => {
      await start(paused);
      const plays = player.playForAttempt.mock.calls.length;
      const headers = jest.fn(async () => ({ Authorization: 'fresh-token' }));
      const retry = c.retryCurrent(player, { getHeaders: headers });
      expect(c.retryCurrent(player)).toBe(retry);
      await flush();
      expect(headers).toHaveBeenCalledTimes(1);
      expect(c.current.requestId).toBe('selection-A');
      expect(player.playForAttempt).toHaveBeenCalledTimes(plays);
      expect(player.seekForAttempt).not.toHaveBeenCalled();
      await ready();
      expect(player.seekForAttempt).toHaveBeenLastCalledWith(
        installed,
        12,
        revision,
      );
      expect(player.seekForAttempt.mock.results.at(-1).value).toBe(true);
      expect(player.playForAttempt).toHaveBeenCalledTimes(plays);
      await seekAck();
      await retry;
      expect(player.playForAttempt).toHaveBeenCalledTimes(
        plays + (paused ? 0 : 1),
      );
      expect(c.current.positionSeconds).toBe(12);
      expect(c.current.error).toBeNull();
      expect(c.current.status).toBe(paused ? 'paused' : 'starting');
      if (paused) await c.setIntent(player, { type: 'play' });
      position = 13;
      emit('progress');
      expect(results.filter((x) => x.didStart)).toHaveLength(1);
      expect(player.play).not.toHaveBeenCalled();
    },
  );

  test.each(['false', 'failed', 'timeout', 'loaded-timeout'])(
    'Retry %s never resumes and settles finitely',
    async (mode) => {
      await start();
      const plays = player.playForAttempt.mock.calls.length;
      if (mode === 'false') player.seekForAttempt.mockReturnValue(false);
      const retry = c.retryCurrent(player);
      await flush();
      if (mode !== 'loaded-timeout') await ready();
      if (mode === 'failed') await seekAck({ seekCompleted: false });
      if (mode === 'timeout' || mode === 'loaded-timeout')
        await jest.advanceTimersByTimeAsync(5000);
      await retry;
      expect(player.playForAttempt).toHaveBeenCalledTimes(plays);
      expect(c.current.status).toBe('error');
      expect(c.current.error).not.toBeNull();
      expect(player.play).not.toHaveBeenCalled();
    },
  );

  test.each(['pause', 'seek', 'native-seek', 'interruption'])(
    'new %s wins a pending restoration',
    async (action) => {
      await start();
      const retry = c.retryCurrent(player);
      await flush();
      await ready();
      const oldRevision = revision,
        oldAttempt = installed;
      const plays = player.playForAttempt.mock.calls.length;
      if (action === 'pause') await c.setIntent(player, { type: 'pause' });
      if (action === 'seek')
        await c.setIntent(player, { type: 'seek', positionSeconds: 49 });
      if (action === 'native-seek') {
        revision++;
        position = 49;
        emit('seekIntent', { seekOrigin: 'user', seekTargetSeconds: 49 });
      }
      if (action === 'interruption') {
        intent = 'interrupted';
        revision++;
        emit('intent');
      }
      emit('seek', {
        sourceAttemptId: oldAttempt,
        intentRevision: oldRevision,
        seekOrigin: 'recovery',
        seekCompleted: true,
        currentTime: 12,
      });
      await retry;
      await jest.advanceTimersByTimeAsync(5000);
      expect(player.playForAttempt).toHaveBeenCalledTimes(plays);
      expect(c.current.error).toBeNull();
      if (action.includes('seek')) expect(c.current.positionSeconds).toBe(49);
      else expect(c.current.intent).toBe('pause');
    },
  );

  test('loaded before replacement promise settles is retained and seek acknowledgement can be synchronous', async () => {
    await start(true);
    const command = deferred();
    const replace = player.replaceWithAttempt.getMockImplementation();
    player.replaceWithAttempt.mockImplementation((...args) => {
      const ok = replace(...args);
      emit('loaded');
      return command.promise.then(() => ok);
    });
    const seek = player.seekForAttempt.getMockImplementation();
    player.seekForAttempt.mockImplementation((...args) => {
      const ok = seek(...args);
      emit('seek', { seekOrigin: 'recovery', seekCompleted: ok });
      return ok;
    });
    const retry = c.retryCurrent(player);
    await flush();
    expect(player.seekForAttempt).not.toHaveBeenCalled();
    command.resolve();
    await retry;
    expect(player.seekForAttempt).toHaveBeenCalledTimes(1);
    expect(c.current.positionSeconds).toBe(12);
    expect(c.current.status).toBe('paused');
  });

  test.each(['resolve', 'reject', 'timeout'])(
    'obsolete A headers %s cannot affect B or its pending Retry',
    async (settlement) => {
      await start(true);
      const old = deferred();
      const oldRetry = c.retryCurrent(player, {
        getHeaders: () => old.promise,
      });
      await flush();
      const oldAttempt = installed;
      await c.play(
        player,
        { id: 'B' },
        { requestId: 'selection-B', getHeaders: async () => ({}) },
      );
      position = 7;
      emit('progress');
      const fresh = deferred();
      const retryB = c.retryCurrent(player, {
        getHeaders: () => fresh.promise,
      });
      if (settlement === 'resolve') old.resolve({});
      if (settlement === 'reject')
        old.reject(new Error('synthetic stale secret'));
      await oldRetry;
      await flush();
      expect(c.retryCurrent(player)).toBe(retryB);
      emit('error', { sourceAttemptId: oldAttempt, error: 'obsolete' });
      expect(c.current.trackId).toBe('B');
      expect(c.current.error).toBeNull();
      fresh.resolve({});
      await flush();
      await ready();
      await seekAck();
      await retryB;
      await jest.advanceTimersByTimeAsync(5000);
      expect(c.current.trackId).toBe('B');
      expect(c.current.error).toBeNull();
    },
  );

  test.each(['logout', 'auth-change', 'unmount', 'dismiss'])(
    '%s fences late source/seek results',
    async (reason) => {
      await start();
      const retry = c.retryCurrent(player);
      await flush();
      await ready();
      const old = installed,
        oldRevision = revision;
      const plays = player.playForAttempt.mock.calls.length;
      c.cancelCurrent(reason, player);
      emit('seek', {
        sourceAttemptId: old,
        intentRevision: oldRevision,
        seekCompleted: true,
        seekOrigin: 'recovery',
      });
      await retry;
      await jest.advanceTimersByTimeAsync(31000);
      expect(c.current.status).toBe('idle');
      expect(player.playForAttempt).toHaveBeenCalledTimes(plays);
      expect(c.current.requestId).toBeNull();
    },
  );

  test('installed identity stays authoritative during headers and a user seek cancels installation', async () => {
    await start(true);
    const old = installed,
      headers = deferred();
    const replacements = player.replaceWithAttempt.mock.calls.length;
    const retry = c.retryCurrent(player, { getHeaders: () => headers.promise });
    await flush();
    expect(c.current.sourceAttemptId).toBe(old);
    await c.setIntent(player, { type: 'seek', positionSeconds: 88 });
    headers.resolve({});
    await retry;
    expect(player.replaceWithAttempt).toHaveBeenCalledTimes(replacements);
    expect(c.current.positionSeconds).toBe(88);
    expect(installed).toBe(old);
  });

  test('structured native HTTP status is terminal while arbitrary auth/404 text stays generic', async () => {
    await start();
    emit('error', { error: { statusCode: 401, message: 'redacted' } });
    expect(c.current.error.kind).toBe('auth');
    expect(c.current.recoveryCount).toBe(0);
    expect(classifyPlaybackError(new Error('unauthorized 404'), 'A').type).toBe(
      'remote_replace_error',
    );
  });
  test('automatic recovery retains synchronous loaded and seek acknowledgement events', async () => {
    await start();
    const replace = player.replaceWithAttempt.getMockImplementation();
    player.replaceWithAttempt.mockImplementation((...args) => {
      const ok = replace(...args);
      if (ok) emit('loaded');
      return ok;
    });
    const seek = player.seekForAttempt.getMockImplementation();
    player.seekForAttempt.mockImplementation((...args) => {
      const ok = seek(...args);
      emit('seek', { seekOrigin: 'recovery', seekCompleted: ok });
      return ok;
    });
    emit('error', { error: 'synthetic stream failure' });
    await jest.advanceTimersByTimeAsync(800);
    expect(player.replaceWithAttempt).toHaveBeenCalledTimes(2);
    expect(player.seekForAttempt).toHaveBeenCalledWith(
      installed,
      12,
      expect.any(Number),
    );
    expect(player.playForAttempt).toHaveBeenCalledTimes(2);
    expect(c.current.error).toBeNull();
  });

  test('initial loaded before command resolution preserves explicit selection intent', async () => {
    const replace = player.replaceWithAttempt.getMockImplementation();
    const command = deferred();
    player.replaceWithAttempt.mockImplementation((...args) => {
      const ok = replace(...args);
      emit('loaded');
      return command.promise.then(() => ok);
    });
    const selection = c.play(player, { id: 'A' });
    await flush();
    expect(player.playForAttempt).not.toHaveBeenCalled();
    command.resolve();
    await selection;
    expect(player.playForAttempt).toHaveBeenCalledTimes(1);
    expect(c.current.intent).toBe('play');
    position = 1;
    emit('progress');
    expect(results.filter((x) => x.didStart)).toHaveLength(1);
  });

  test('initial error before command resolution cannot play the failed source', async () => {
    const replace = player.replaceWithAttempt.getMockImplementation();
    const command = deferred();
    player.replaceWithAttempt.mockImplementation((...args) => {
      const ok = replace(...args);
      emit('error', { error: 'synthetic failure' });
      return command.promise.then(() => ok);
    });
    const selection = c.play(player, { id: 'A' });
    await flush();
    command.resolve();
    await selection;
    expect(player.playForAttempt).not.toHaveBeenCalled();
    expect(c.current.status).toBe('recovering');
  });

  test('early Retry error never resumes that attempt or loses the automatic replacement cap', async () => {
    await start();
    const replace = player.replaceWithAttempt.getMockImplementation();
    player.replaceWithAttempt.mockImplementation((...args) => {
      const ok = replace(...args);
      emit('error', { error: 'synthetic failure' });
      return ok;
    });
    const plays = player.playForAttempt.mock.calls.length;
    await c.retryCurrent(player);
    await jest.advanceTimersByTimeAsync(30000);
    expect(player.playForAttempt).toHaveBeenCalledTimes(plays);
    expect(player.replaceWithAttempt).toHaveBeenCalledTimes(3); // selection, Retry, one automatic replacement
    expect(c.current.status).toBe('error');
    expect(c.current.recoveryCount).toBe(1);
  });

  test.each(['false', 'throw'])(
    'a %s resume command fails safely without unguarded fallback',
    async (mode) => {
      await start();
      const retry = c.retryCurrent(player);
      await flush();
      await ready();
      player.playForAttempt.mockImplementation(() => {
        if (mode === 'throw')
          throw new Error('synthetic private bridge description');
        return false;
      });
      await seekAck();
      await retry;
      expect(c.current.status).toBe('error');
      expect(c.current.error.message).toBe('Playback error');
      expect(player.play).not.toHaveBeenCalled();
    },
  );

  test('Retry uses latest accepted position after a completed user seek and further progress', async () => {
    await start();
    await c.setIntent(player, { type: 'seek', positionSeconds: 4 });
    position = 4;
    emit('seek', { seekOrigin: 'user', seekCompleted: true });
    position = 9;
    emit('progress');
    const retry = c.retryCurrent(player);
    await flush();
    await ready();
    expect(player.seekForAttempt).toHaveBeenLastCalledWith(
      installed,
      9,
      revision,
    );
    await seekAck();
    await retry;
    expect(c.current.positionSeconds).toBe(9);
  });

  test('mismatched technical seek acknowledgement cannot restore or resume', async () => {
    await start();
    const retry = c.retryCurrent(player);
    await flush();
    await ready();
    const plays = player.playForAttempt.mock.calls.length;
    emit('seek', { seekOrigin: 'user', seekCompleted: true, currentTime: 999 });
    await flush();
    expect(player.playForAttempt).toHaveBeenCalledTimes(plays);
    expect(c.current.positionSeconds).toBe(12);
    await seekAck();
    await retry;
    expect(c.current.positionSeconds).toBe(12);
  });

  test('Retry header acquisition is finite even while paused, with late rejection discarded', async () => {
    await start(true);
    const headers = deferred();
    const replacements = player.replaceWithAttempt.mock.calls.length;
    const retry = c.retryCurrent(player, { getHeaders: () => headers.promise });
    await jest.advanceTimersByTimeAsync(5000);
    await retry;
    expect(c.current.error.kind).toBe('timeout');
    expect(player.replaceWithAttempt).toHaveBeenCalledTimes(replacements);
    headers.reject(new Error('late private header failure'));
    await flush();
    expect(c.current.error.kind).toBe('timeout');
  });

  test('Retry has a fresh hard episode and one blip cannot reset its budget/cap', async () => {
    await start();
    const retry = c.retryCurrent(player);
    await flush();
    await ready();
    await seekAck();
    await retry;
    position = 13;
    emit('progress');
    await jest.advanceTimersByTimeAsync(10000);
    await jest.advanceTimersByTimeAsync(800);
    expect(c.current.recoveryCount).toBe(1);
    await ready();
    await seekAck();
    position = 14;
    emit('progress'); // No second sustainable proof, and cap remains consumed.
    await jest.advanceTimersByTimeAsync(19200);
    expect(c.current.status).toBe('error');
    expect(player.replaceWithAttempt).toHaveBeenCalledTimes(3);
  });

  test('healthy resume survives 30s, then a later stall stays finite', async () => {
    await start();
    await jest.advanceTimersByTimeAsync(1100);
    position = 13;
    emit('progress');
    await c.setIntent(player, { type: 'pause' });
    await jest.advanceTimersByTimeAsync(40000);
    expect(c.current.status).toBe('paused');
    await c.setIntent(player, { type: 'play' });
    position = 14;
    emit('progress');
    await jest.advanceTimersByTimeAsync(1100);
    position = 15;
    emit('progress');
    for (let i = 0; i < 7; i++) {
      await jest.advanceTimersByTimeAsync(5000);
      position += 5;
      emit('progress');
    }
    expect(c.current.status).toBe('playing');
    await jest.advanceTimersByTimeAsync(30000);
    expect(c.current.status).toBe('error');
    expect(c.current.recoveryCount).toBe(1);
  });

  test('legacy Retry stays usable beyond 40s without attributed errors or recovery', async () => {
    delete player.puukSourceIdentityVersion;
    await c.play(player, { id: 'A' });
    await c.setIntent(player, { type: 'pause' });
    await c.retryCurrent(player);
    expect(c.current.status).toBe('paused');
    await c.setIntent(player, { type: 'play' });
    await jest.advanceTimersByTimeAsync(40000);
    expect(c.current.error).toBeNull();
    expect(c.identityAvailable).toBe(false);
    expect(player.replace).toHaveBeenCalledTimes(2);
    expect(player.replaceWithAttempt).not.toHaveBeenCalled();
  });
  test.each(['resolve', 'reject', 'timeout'])(
    'obsolete replacement promise %s cannot reinstall or resume A after B',
    async (settlement) => {
      await start();
      const command = deferred();
      const replace = player.replaceWithAttempt.getMockImplementation();
      player.replaceWithAttempt.mockImplementationOnce((...args) => {
        const ok = replace(...args);
        return command.promise.then(() => ok);
      });
      const retry = c.retryCurrent(player);
      await flush();
      await c.play(player, { id: 'B' }, { requestId: 'selection-B' });
      const replacements = player.replaceWithAttempt.mock.calls.length;
      const plays = player.playForAttempt.mock.calls.length;
      if (settlement === 'resolve') command.resolve();
      if (settlement === 'reject')
        command.reject(new Error('synthetic obsolete bridge error'));
      await retry;
      await jest.advanceTimersByTimeAsync(5000);
      expect(c.current.requestId).toBe('selection-B');
      expect(c.current.error).toBeNull();
      expect(player.replaceWithAttempt).toHaveBeenCalledTimes(replacements);
      expect(player.playForAttempt).toHaveBeenCalledTimes(plays);
    },
  );

  test('paused Retry at zero still requires loaded and a nonnull technical seek acknowledgement', async () => {
    await start(true);
    await c.setIntent(player, { type: 'seek', positionSeconds: 0 });
    emit('seek', { seekOrigin: 'user', seekCompleted: true, currentTime: 0 });
    const plays = player.playForAttempt.mock.calls.length;
    const retry = c.retryCurrent(player);
    await flush();
    await ready();
    expect(player.seekForAttempt).toHaveBeenLastCalledWith(
      installed,
      0,
      revision,
    );
    await seekAck();
    await retry;
    expect(c.current.positionSeconds).toBe(0);
    expect(c.current.status).toBe('paused');
    expect(player.playForAttempt).toHaveBeenCalledTimes(plays);
  });
});
