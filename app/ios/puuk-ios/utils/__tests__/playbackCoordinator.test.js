import { PlaybackCoordinator, normalizeStreamUrl } from '../playbackCoordinator';
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
