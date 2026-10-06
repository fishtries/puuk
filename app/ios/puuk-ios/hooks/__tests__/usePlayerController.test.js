import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import usePlayerController, { normalizeTrackDto } from '../usePlayerController';
import defaultPlaybackCoordinator from '../../utils/playbackCoordinator';
import { authFetch } from '../../utils/api';

const mockCoordinatorListeners = new Set();
const mockAuthListeners = new Set();

// Mock dependencies
jest.mock('../../utils/playbackCoordinator', () => {
  return {
    __esModule: true,
    default: {
      play: jest.fn().mockResolvedValue({ isLocal: false, uri: 'mock://stream' }),
      updateQueue: jest.fn(),
      handleBufferingStatus: jest.fn(),
      subscribe: jest.fn((listener) => {
        mockCoordinatorListeners.add(listener);
        listener({
          networkStatus: 'good',
          nextTrackStatus: 'idle',
          networkError: null,
          isBufferingSlow: false,
        });
        return () => mockCoordinatorListeners.delete(listener);
      }),
      getState: jest.fn(() => ({
        networkStatus: 'good',
        nextTrackStatus: 'idle',
        networkError: null,
        isBufferingSlow: false,
      })),
    },
  };
});

jest.mock('expo-audio', () => ({
  useAudioPlayer: jest.fn(() => ({
    replace: jest.fn(),
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    setActiveForLockScreen: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  })),
  useAudioPlayerStatus: jest.fn(() => ({
    playing: false,
    currentTime: 0,
    duration: 100,
    isBuffering: false,
    didJustFinish: false,
  })),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  preload: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/api', () => ({
  SERVER_URL: 'https://puuk.app',
  authFetch: jest.fn(),
  getAuthHeaders: jest.fn().mockResolvedValue({ Authorization: 'Bearer mock_token' }),
  getCachedAuthHeaders: jest.fn(() => ({ Authorization: 'Bearer mock_token' })),
  getCachedAuthToken: jest.fn(() => 'mock_token'),
  getCachedUser: jest.fn(() => ({ id: 1, username: 'tester' })),
  getSavedUser: jest.fn().mockResolvedValue({ id: 1, username: 'tester' }),
  addAuthListener: jest.fn((cb) => {
    mockAuthListeners.add(cb);
    return () => mockAuthListeners.delete(cb);
  }),
  isRetryableStatus: (status) => status === 408 || status === 429 || (typeof status === 'number' && status >= 500 && status <= 599),
  isNetworkError: (err) => {
    if (!err) return false;
    const msg = (err.message || '').toLowerCase();
    return msg.includes('network') || msg.includes('timeout') || msg.includes('failed to fetch');
  },
  ApiError: class ApiError extends Error {
    constructor(message, { type = 'unknown', status = null, code = null } = {}) {
      super(message);
      this.name = 'ApiError';
      this.type = type;
      this.status = status;
      this.code = code;
    }
  },
}));

jest.mock('../../components/CoverImage', () => ({
  resolveCoverUri: jest.fn((uri) => uri),
}));

describe('usePlayerController', () => {
  let controller;
  let setTracksMock;

  function HookHarness() {
    setTracksMock = jest.fn();
    controller = usePlayerController({ setTracks: setTracksMock });
    return null;
  }

  let renderer;

  beforeEach(async () => {
    jest.clearAllMocks();
    authFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    await act(async () => {
      renderer = TestRenderer.create(<HookHarness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
  });

  test('initial state has default queue and network UX values', () => {
    expect(controller.currentTrack).toBeNull();
    expect(controller.upNextQueue).toEqual([]);
    expect(controller.networkStatus).toBe('good');
    expect(controller.nextTrackStatus).toBe('idle');
    expect(controller.networkError).toBeNull();
  });

  test('playTrackList sets manual queue and plays first track', async () => {
    const list = [
      { id: 1, title: 'Track 1' },
      { id: 2, title: 'Track 2' },
      { id: 3, title: 'Track 3' },
    ];

    await act(async () => {
      controller.playTrackList(list, 0);
    });

    expect(controller.currentTrack).toEqual(list[0]);
    expect(controller.upNextQueue).toEqual([list[1], list[2]]);
  });

  test('startWave fetches wave track and starts wave recommendation session', async () => {
    authFetch.mockImplementation(async (url) => {
      if (url.includes('/api/wave/next')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 999, title: 'Wave Song', artist: 'Wave Artist' }),
        };
      }
      if (url.includes('/api/wave/queue')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: 1001, title: 'Rec 1' },
            { id: 1002, title: 'Rec 2' },
          ],
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await act(async () => {
      await controller.startWave();
    });

    expect(controller.currentTrack.id).toBe(999);
    // upNextQueue should receive the wave recommendations
    expect(controller.upNextQueue.length).toBe(2);
    expect(controller.upNextQueue[0].id).toBe(1001);
  });

  test('race condition: late wave queue response does not pollute manual playlist', async () => {
    let waveQueueResolve;
    const waveQueuePromise = new Promise(resolve => {
      waveQueueResolve = resolve;
    });

    authFetch.mockImplementation(async (url) => {
      if (url.includes('/api/wave/next')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 50, title: 'Wave 50' }),
        };
      }
      if (url.includes('/api/wave/queue')) {
        await waveQueuePromise;
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 51, title: 'Stale Wave Rec' }],
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    // 1. User starts wave
    await act(async () => {
      controller.startWave();
    });

    // 2. User quickly switches to a manual album playlist before wave response arrives
    const albumList = [
      { id: 201, title: 'Album 1' },
      { id: 202, title: 'Album 2' },
    ];
    await act(async () => {
      controller.playTrackList(albumList, 0);
    });

    expect(controller.currentTrack.id).toBe(201);
    expect(controller.upNextQueue.map(t => t.id)).toEqual([202]);

    // 3. Late wave response finally arrives
    await act(async () => {
      waveQueueResolve();
    });

    // The manual queue must NOT be polluted with Stale Wave Rec!
    expect(controller.upNextQueue.map(t => t.id)).toEqual([202]);
  });

  test('fetchNextTrack sends wave feedback with skip when track not finished', async () => {
    const list = [
      { id: 10, title: 'Track 10' },
      { id: 20, title: 'Track 20' },
    ];

    await act(async () => {
      controller.playTrackList(list, 0);
    });

    await act(async () => {
      await controller.fetchNextTrack();
    });

    expect(controller.currentTrack.id).toBe(20);
    expect(authFetch).toHaveBeenCalledWith(
      '/api/wave/feedback',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          track_id: 10,
          event_type: 'skip',
        }),
      })
    );
  });

  test('rapid consecutive fetchNextTrack calls advance only once (debounced by lock)', async () => {
    const list = [
      { id: 1, title: 'T1' },
      { id: 2, title: 'T2' },
      { id: 3, title: 'T3' },
    ];

    await act(async () => {
      controller.playTrackList(list, 0);
    });

    // Trigger two rapid Next clicks concurrently
    await act(async () => {
      const p1 = controller.fetchNextTrack();
      const p2 = controller.fetchNextTrack();
      await Promise.all([p1, p2]);
    });

    // Only one transition happened: currentTrack is T2, T3 remains in queue
    expect(controller.currentTrack.id).toBe(2);
    expect(controller.upNextQueue.map(t => t.id)).toEqual([3]);
  });

  describe('normalizeTrackDto', () => {
    test('preserves id: 0 correctly and generates /api/cover/0', () => {
      const dto = normalizeTrackDto({ id: 0, title: 'Zero Track' });
      expect(dto.id).toBe(0);
      expect(dto.coverArt).toBe('https://puuk.app/api/cover/0');
    });

    test('maps track_id to id when id is missing', () => {
      const dto = normalizeTrackDto({ track_id: 42, title: 'Track 42' });
      expect(dto.id).toBe(42);
      expect(dto.coverArt).toBe('https://puuk.app/api/cover/42');
    });
  });

  describe('Playback initiation order and history deduplication', () => {
    test('handles asynchronous playback rejection without an unhandled promise', async () => {
      const originalError = console.error;
      console.error = jest.fn();
      defaultPlaybackCoordinator.play.mockRejectedValueOnce(
        Object.assign(new Error('Remote replace failed'), { type: 'remote_replace_error' })
      );

      await act(async () => {
        controller.playTrack({ id: 404, title: 'Rejected Track' });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(console.error).toHaveBeenCalledWith(
        '[usePlayerController] loadAndPlay error:',
        expect.objectContaining({ type: 'remote_replace_error', trackId: 404 })
      );
      console.error = originalError;
    });

    test('playTrack invokes playback immediately and deduplicates history POSTs within cooldown', async () => {
      const track = { id: 88, title: 'Rapid Track' };

      await act(async () => {
        controller.playTrack(track);
      });

      // Playback initiated immediately via coordinator
      expect(defaultPlaybackCoordinator.play).toHaveBeenCalledWith(
        expect.anything(),
        track,
        expect.objectContaining({ headers: expect.any(Object) })
      );

      // History was sent once
      const historyCallsFirst = authFetch.mock.calls.filter(
        c => c[0].includes('/api/tracks/88/history')
      );
      expect(historyCallsFirst.length).toBe(1);

      // Re-triggering playTrack with same track within 30 seconds should NOT send history again
      await act(async () => {
        controller.playTrack(track);
      });

      const historyCallsSecond = authFetch.mock.calls.filter(
        c => c[0].includes('/api/tracks/88/history')
      );
      expect(historyCallsSecond.length).toBe(1);
    });

    test('execution order contract: coordinator.play is called strictly before fetchQueue and history/telemetry', async () => {
      const events = [];
      defaultPlaybackCoordinator.play.mockImplementation(async (player, track) => {
        events.push(`coordinator.play:${track?.id}`);
        return { isLocal: false, uri: 'mock://stream' };
      });
      authFetch.mockImplementation(async (url) => {
        const path = url.split('?')[0];
        events.push(`authFetch:${path}`);
        if (path.includes('/api/wave/queue')) {
          return { ok: true, status: 200, json: async () => [{ id: 99, title: 'Next In Wave' }] };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });

      const track = { id: 77, title: 'Ordered Track' };
      await act(async () => {
        controller.playTrack(track);
      });

      // coordinator.play was executed first before network calls
      expect(events[0]).toBe('coordinator.play:77');
      expect(events).toContain('authFetch:/api/wave/queue');
      expect(events).toContain('authFetch:/api/tracks/77/history');
      expect(events.indexOf('coordinator.play:77')).toBeLessThan(events.indexOf('authFetch:/api/wave/queue'));
      expect(events.indexOf('coordinator.play:77')).toBeLessThan(events.indexOf('authFetch:/api/tracks/77/history'));

      // Also verify order in fetchNextTrack: coordinator.play must precede feedback and history
      events.length = 0;
      await act(async () => {
        await controller.fetchNextTrack();
      });

      expect(events[0]).toBe('coordinator.play:99');
      expect(events).toContain('authFetch:/api/wave/feedback');
      expect(events).toContain('authFetch:/api/tracks/99/history');
      expect(events.indexOf('coordinator.play:99')).toBeLessThan(events.indexOf('authFetch:/api/wave/feedback'));
      expect(events.indexOf('coordinator.play:99')).toBeLessThan(events.indexOf('authFetch:/api/tracks/99/history'));
    });

    test('history dedup incorporates user and resets when user changes via addAuthListener', async () => {
      const track = { id: 101, title: 'User Track' };

      await act(async () => {
        controller.playTrack(track);
      });

      const callsUser1 = authFetch.mock.calls.filter(c => c[0].includes('/api/tracks/101/history'));
      expect(callsUser1.length).toBe(1);

      // Replay in same user session is deduplicated
      await act(async () => {
        controller.playTrack(track);
      });
      expect(authFetch.mock.calls.filter(c => c[0].includes('/api/tracks/101/history')).length).toBe(1);

      // Switch user via auth listener callback
      await act(async () => {
        for (const cb of mockAuthListeners) {
          cb({ id: 2, username: 'another_user' });
        }
      });

      // Under new user, history is sent again
      await act(async () => {
        controller.playTrack(track);
      });
      expect(authFetch.mock.calls.filter(c => c[0].includes('/api/tracks/101/history')).length).toBe(2);
    });

    test('loadAndPlay passes getHeadersAsync and invokes coordinator.play synchronously without blocking', async () => {
      const track = { id: 55, title: 'Sync Start Track' };
      await act(async () => {
        controller.playTrack(track);
      });

      expect(defaultPlaybackCoordinator.play).toHaveBeenCalledWith(
        expect.anything(),
        track,
        expect.objectContaining({
          headers: expect.any(Object),
          getHeadersAsync: expect.any(Function),
        })
      );
    });

    test('buffers failed background telemetry and retries when network becomes good', async () => {
      const originalWarn = console.warn;
      console.warn = jest.fn();

      authFetch.mockImplementation(async (url) => {
        if (url.includes('/api/wave/feedback')) {
          throw new Error('Network failure');
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });

      const list = [
        { id: 10, title: 'T10' },
        { id: 20, title: 'T20' },
      ];

      await act(async () => {
        controller.playTrackList(list, 0);
      });

      // Trigger next track which attempts wave feedback
      await act(async () => {
        await controller.fetchNextTrack();
      });

      // The background event failed and was logged
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[usePlayerController] Background event failed (/api/wave/feedback):'),
        expect.any(String)
      );

      // Now network recovers: mock authFetch succeeds
      authFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));

      // Notify good network status to coordinator listeners
      await act(async () => {
        for (const listener of mockCoordinatorListeners) {
          listener({ networkStatus: 'good' });
        }
      });

      // Flushed retry succeeded
      const retriedFeedbackCalls = authFetch.mock.calls.filter(
        c => c[0].includes('/api/wave/feedback')
      );
      expect(retriedFeedbackCalls.length).toBeGreaterThanOrEqual(2);

      console.warn = originalWarn;
    });

    test('retry buffer flushes via timer even if coordinator networkStatus does not change', async () => {
      jest.useFakeTimers();
      const originalWarn = console.warn;
      console.warn = jest.fn();

      let attempts = 0;
      authFetch.mockImplementation(async (url) => {
        if (url.includes('/api/wave/feedback')) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('Network timeout');
          }
          return { ok: true, status: 200, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });

      const list = [
        { id: 10, title: 'T10' },
        { id: 20, title: 'T20' },
      ];

      await act(async () => {
        controller.playTrackList(list, 0);
      });

      await act(async () => {
        await controller.fetchNextTrack();
      });

      expect(attempts).toBe(1);

      // Advance timer by 5000ms: timer should trigger flushPendingBackgroundEvents
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });

      expect(attempts).toBe(2);

      console.warn = originalWarn;
      jest.useRealTimers();
    });

    test('does not requeue an in-flight retry after auth user changes', async () => {
      const originalWarn = console.warn;
      console.warn = jest.fn();
      let feedbackAttempts = 0;
      let resolveRetry;
      authFetch.mockImplementation(async (url) => {
        if (url.includes('/api/wave/feedback')) {
          feedbackAttempts += 1;
          if (feedbackAttempts === 1) throw new Error('Network timeout');
          return new Promise((resolve) => { resolveRetry = resolve; });
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });

      await act(async () => {
        controller.playTrackList([{ id: 10 }, { id: 20 }], 0);
      });
      await act(async () => {
        await controller.fetchNextTrack();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(feedbackAttempts).toBe(1);

      let flushPromise;
      await act(async () => {
        for (const listener of mockCoordinatorListeners) {
          listener({ networkStatus: 'good' });
        }
        await Promise.resolve();
        flushPromise = Promise.resolve();
      });
      expect(feedbackAttempts).toBe(2);

      await act(async () => {
        for (const listener of mockAuthListeners) {
          listener({ id: 2, username: 'new_user' });
        }
        resolveRetry({ ok: true, status: 200, json: async () => ({}) });
        await flushPromise;
        await Promise.resolve();
      });

      expect(feedbackAttempts).toBe(2);
      console.warn = originalWarn;
    });

    test('retry buffer discards permanent HTTP errors (400, 401, 404) without buffering', async () => {
      const originalWarn = console.warn;
      console.warn = jest.fn();

      let attempts = 0;
      authFetch.mockImplementation(async (url) => {
        if (url.includes('/api/wave/feedback')) {
          attempts += 1;
          return { ok: false, status: 400, json: async () => ({ error: 'Bad Request' }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      });

      const list = [
        { id: 10, title: 'T10' },
        { id: 20, title: 'T20' },
      ];

      await act(async () => {
        controller.playTrackList(list, 0);
      });

      await act(async () => {
        await controller.fetchNextTrack();
      });

      expect(attempts).toBe(1);

      // Coordinator emits 'good' network status
      await act(async () => {
        for (const listener of mockCoordinatorListeners) {
          listener({ networkStatus: 'good' });
        }
      });

      // Because 400 is not retryable, it was discarded and NOT retried
      expect(attempts).toBe(1);

      console.warn = originalWarn;
    });
  });
});
