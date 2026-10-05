import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import usePlayerController from '../usePlayerController';
import defaultPlaybackCoordinator from '../../utils/playbackCoordinator';
import { authFetch } from '../../utils/api';

// Mock dependencies
jest.mock('../../utils/playbackCoordinator', () => {
  return {
    __esModule: true,
    default: {
      play: jest.fn().mockResolvedValue({ isLocal: false, uri: 'mock://stream' }),
      updateQueue: jest.fn(),
      handleBufferingStatus: jest.fn(),
      subscribe: jest.fn((listener) => {
        listener({
          networkStatus: 'good',
          nextTrackStatus: 'idle',
          networkError: null,
          isBufferingSlow: false,
        });
        return jest.fn();
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
  getCachedAuthToken: jest.fn(() => 'mock_token'),
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
});
