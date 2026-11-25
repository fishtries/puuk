import React from 'react';
import { DeviceEventEmitter } from 'react-native';
import { getNetworkStateAsync } from 'expo-network';
import { getNetworkPolicy } from '../../utils/networkPolicy';
import TestRenderer, { act } from 'react-test-renderer';
import usePlayerController, { normalizeTrackDto } from '../usePlayerController';
import defaultPlaybackCoordinator from '../../utils/playbackCoordinator';
import { authFetch } from '../../shared/api/api';
import { updateSetting } from '../../shared/storage/settings';
import { recordPlayStart } from '../../shared/api/artists';
import { setLocalRating } from '../../offline/outbox/runtime';
import { readMediaKey, readPlayableIds } from '../../offline';
import { notifyOfflineIndex } from '../../offline/session';
import { readWaveQueue, saveWaveQueue, selectLocalWaveTracks } from '../../offline/wave';
import { queueKey } from '../../utils/queueIdentity';

const mockSession = { owner: { userId: 1, origin: 'https://puuk.app' }, activationId: 'a', generation: 1 };
const mockOfflineListeners = new Set();
const mockOfflineRatings = new Map();
jest.mock('../../offline/session', () => ({
  getOfflineSession: () => mockSession,
  isOfflineSessionCurrent: (session) => session === mockSession,
  notifyOfflineIndex: (event) => mockOfflineListeners.forEach((callback) => callback(event)),
  subscribeOfflineIndex: (callback) => {
    mockOfflineListeners.add(callback);
    return () => mockOfflineListeners.delete(callback);
  },
}));
jest.mock('../../offline/wave', () => ({
  LOCAL_WAVE_BATCH_SIZE: 12,
  readWaveQueue: jest.fn(async () => null),
  saveWaveQueue: jest.fn(async () => true),
  selectLocalWaveTracks: jest.fn(),
  setWavePlaybackMode: jest.fn(),
  waveTrackDuration: track => track.duration || 0,
}));
jest.mock('../../offline', () => ({
  ...jest.requireActual('../../offline'),
  readMediaKey: jest.fn(async () => null),
  readPlayableIds: jest.fn(async () => new Set()),
}));
const isWaveStart = (url) => url.includes('/api/wave/queue') && !url.includes('current_track_id=');
jest.mock('../../offline/outbox/runtime', () => ({
  startOutboxSync: () => () => {},
  getRatingOverlay: jest.fn(async () => [...mockOfflineRatings.values()]),
  getLocalDislikeIds: async () => new Set([...mockOfflineRatings.values()]
    .filter(entry => entry.rating === 'dislike').map(entry => entry.trackId)),
  overlayDislikeIds: (dislikes, ratings) => {
    const ids = new Set(dislikes);
    for (const { trackId, rating } of ratings)
      if (rating === 'dislike') ids.add(trackId);
      else ids.delete(trackId);
    return ids;
  },
  setLocalRating: jest.fn(),
  recordStarted: jest.fn(),
  recordOutcome: jest.fn(),
}));

const mockCoordinatorListeners = new Set();
const mockAuthListeners = new Set();
let mockAudioStatus;

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(async () => ({ isConnected: true, type: 'WIFI' })),
  addNetworkStateListener: jest.fn(() => ({ remove() {} })),
}));

jest.mock('../playbackStatus', () => ({
  usePlaybackState: () => mockAudioStatus,
  getPlaybackSnapshot: () => mockAudioStatus,
}));

// Mock dependencies
jest.mock('../../utils/playbackCoordinator', () => {
  return {
    __esModule: true,
    default: {
      play: jest
        .fn()
        .mockResolvedValue({ isLocal: false, uri: 'mock://stream' }),
      updateQueue: jest.fn(),
      cancelCurrent: jest.fn((reason, player) => player?.pause()),
      handleNativeStatus: jest.fn(() => ({ accepted: false })),
      retryCurrent: jest.fn().mockResolvedValue({ uri: 'mock://retry' }),
      setIntent: jest.fn((player, { type, positionSeconds }) => {
        if (type === 'pause') player.pause();
        if (type === 'play') player.play();
        if (type === 'seek') player.seekTo(positionSeconds);
        return Promise.resolve();
      }),
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

const mockPlayerInstance = {
  setPlaybackRate: jest.fn(),
  replace: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  setActiveForLockScreen: jest.fn(),
  setFavoriteState: jest.fn(),
  setFavoritePending: jest.fn(),
  addListener: jest.fn(() => ({ remove: jest.fn() })),
};

jest.mock('expo-audio', () => ({
  useAudioPlayer: jest.fn(() => mockPlayerInstance),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  preload: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../shared/api/api', () => ({
  SERVER_URL: 'https://puuk.app',
  getAuthSessionGeneration: () => 0,
  authFetch: jest.fn(),
  getAuthHeaders: jest
    .fn()
    .mockResolvedValue({ Authorization: 'Bearer mock_token' }),
  getCachedAuthHeaders: jest.fn(() => ({ Authorization: 'Bearer mock_token' })),
  getCachedAuthToken: jest.fn(() => 'mock_token'),
  getCachedUser: jest.fn(() => ({ id: 1, username: 'tester' })),
  getSavedUser: jest.fn().mockResolvedValue({ id: 1, username: 'tester' }),
  addAuthListener: jest.fn((cb) => {
    mockAuthListeners.add(cb);
    return () => mockAuthListeners.delete(cb);
  }),
  isRetryableStatus: (status) =>
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status <= 599),
  isNetworkError: (err) => {
    if (!err) return false;
    const msg = (err.message || '').toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('timeout') ||
      msg.includes('failed to fetch')
    );
  },
  ApiError: class ApiError extends Error {
    constructor(
      message,
      { type = 'unknown', status = null, code = null } = {},
    ) {
      super(message);
      this.name = 'ApiError';
      this.type = type;
      this.status = status;
      this.code = code;
    }
  },
}));

jest.mock('../../shared/api/artists', () => ({
  recordPlayStart: jest.fn().mockResolvedValue({ status: 'recorded' }),
}));

jest.mock('../../shared/media/CoverImage', () => ({
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
    mockOfflineRatings.clear();
    getNetworkStateAsync.mockResolvedValue({ isConnected: true, type: 'WIFI' });
    await getNetworkPolicy();
    readWaveQueue.mockResolvedValue(null);
    selectLocalWaveTracks.mockResolvedValue({ tracks: [], reserveIds: new Set() });
    setLocalRating.mockImplementation(async (session, track, rating) => {
      const trackId = String(track.id);
      const revision = (mockOfflineRatings.get(trackId)?.revision || 0) + 1;
      const entry = { trackId, track, rating, state: 'pending', revision, operationId: `${trackId}-${revision}` };
      mockOfflineRatings.set(trackId, entry);
      notifyOfflineIndex({ type: 'rating', session, entry });
      return entry;
    });
    mockAudioStatus = {
      playing: false,
      currentTime: 0,
      duration: 100,
      isBuffering: false,
      didJustFinish: false,
    };
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

  test('audio position updates preserve queue controls until a queue setting changes', async () => {
    const controls = controller.queueControls;
    mockAudioStatus = { ...mockAudioStatus, currentTime: 0.1 };
    await act(async () => { renderer.update(<HookHarness />); });
    expect(controller.currentTime).toBe(0.1);
    expect(controller.queueControls).toBe(controls);
    await act(async () => { controller.queueControls.cycleRepeatMode(); });
    expect(controller.queueControls).not.toBe(controls);
    expect(controller.queueControls.repeatMode).not.toBe(controls.repeatMode);
  });

  test('speed changes live, survives pause and resets for another track', async () => {
    expect(controller.playbackRate).toBe(1);
    expect(mockPlayerInstance.shouldCorrectPitch).toBe(false);
    await act(async () => controller.changePlaybackRate(0.85));
    expect(controller.playbackRate).toBe(0.85);
    expect(mockPlayerInstance.setPlaybackRate).toHaveBeenLastCalledWith(0.85);
    expect(mockPlayerInstance.play).not.toHaveBeenCalled();
    expect(mockPlayerInstance.replace).not.toHaveBeenCalled();
    await act(async () => controller.playTrack({ id: 101, title: 'First' }));
    await act(async () => controller.togglePlayPause());
    expect(controller.playbackRate).toBe(0.85);
    await act(async () => controller.playTrack({ id: 101, title: 'First' }));
    expect(controller.playbackRate).toBe(0.85);
    await act(async () => controller.playTrack({ id: 102, title: 'Next' }));
    expect(controller.playbackRate).toBe(1);
    expect(mockPlayerInstance.setPlaybackRate).toHaveBeenLastCalledWith(1);
    expect(mockPlayerInstance.shouldCorrectPitch).toBe(false);
  });

  test('preview applies 0.005 steps immediately and commits without another native update', async () => {
    const beforePreview = controller;
    await act(async () => controller.changePlaybackRate(0.855, { commit: false }));
    expect(mockPlayerInstance.setPlaybackRate).toHaveBeenLastCalledWith(0.855);
    expect(controller).toBe(beforePreview);
    expect(controller.playbackRate).toBe(1);
    await act(async () => controller.changePlaybackRate(0.85500001, { commit: false }));
    expect(mockPlayerInstance.setPlaybackRate).toHaveBeenCalledTimes(1);
    await act(async () => controller.changePlaybackRate(0.855));
    expect(controller.playbackRate).toBe(0.855);
    expect(mockPlayerInstance.setPlaybackRate).toHaveBeenCalledTimes(1);
  });

  test('speed rejects invalid values and clamps to the supported UI range', async () => {
    await act(async () => controller.changePlaybackRate(NaN));
    expect(mockPlayerInstance.setPlaybackRate).not.toHaveBeenCalled();
    await act(async () => controller.changePlaybackRate(5));
    expect(controller.playbackRate).toBe(1.5);
    await act(async () => controller.changePlaybackRate(0));
    expect(controller.playbackRate).toBe(0.75);
  });

  test('initial state has default queue and network UX values', () => {
    expect(controller.currentTrack).toBeNull();
    expect(controller.upNextQueue).toEqual([]);
    expect(controller.networkStatus).toBe('good');
    expect(controller.nextTrackStatus).toBe('idle');
    expect(controller.networkError).toBeNull();
  });

  const queueIds = () => controller.upNextQueue.map((track) => track.id);
  const startQueue = async () => {
    await act(async () =>
      controller.playTrackList(
        [1, 2, 3, 4].map((id) => ({ id, title: `Track ${id}` })),
      ),
    );
  };

  test('dislike clears a like without advancing a manual queue and can be removed', async () => {
    await act(async () => controller.playTrackList([
      { id: 1, is_liked: true }, { id: 2 },
    ]));
    await act(async () => controller.handleToggleDislike(controller.currentTrack));
    expect(controller.currentTrack.id).toBe(1);
    expect(controller.currentTrack.is_liked).toBe(false);
    expect(controller.dislikeIds.has('1')).toBe(true);
    expect(setLocalRating).toHaveBeenCalledWith(mockSession, expect.objectContaining({ id: 1 }), 'dislike');
    await act(async () => controller.handleToggleDislike(controller.currentTrack));
    expect(controller.dislikeIds.has('1')).toBe(false);
    expect(setLocalRating).toHaveBeenLastCalledWith(mockSession, expect.objectContaining({ id: 1 }), 'neutral');
  });

  test('failed dislike preserves the like and queue', async () => {
    await act(async () => controller.playTrackList([{ id: 1, is_liked: true }, { id: 2 }]));
    setLocalRating.mockRejectedValueOnce(new Error('SQLite unavailable'));
    await act(async () => controller.handleToggleDislike(controller.currentTrack));
    expect(controller.currentTrack.is_liked).toBe(true);
    expect(controller.dislikeIds.has('1')).toBe(false);
    expect(controller.dislikePending).toBe(false);
    expect(queueIds()).toEqual([2]);
  });

  test('advancing the queue resets an uncommitted speed preview', async () => {
    await startQueue();
    await act(async () => controller.changePlaybackRate(0.855, { commit: false }));
    await act(async () => { await controller.fetchNextTrack({ finished: true }); });
    expect(controller.currentTrack.id).toBe(2);
    expect(controller.playbackRate).toBe(1);
    expect(mockPlayerInstance.setPlaybackRate).toHaveBeenLastCalledWith(1);
  });

  test('next and queue selections retain the prepared tail of a large playlist', async () => {
    const tracks = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1 }));
    const last = tracks.at(-1);
    const readRating = jest.fn(() => true);
    Object.defineProperty(last, 'is_liked', { get: readRating, enumerable: true });
    await act(async () => controller.playTrackList(tracks));
    const lastKey = queueKey(controller.upNextQueue.at(-1));
    readRating.mockClear();

    await act(async () => controller.fetchNextTrack());
    expect(controller.currentTrack.id).toBe(2);
    const selected = controller.upNextQueue[1200];
    await act(async () => controller.playTrack(selected, { source: 'queue', queueIndex: 1200 }));
    expect(controller.currentTrack).toBe(selected);
    expect(controller.upNextQueue[0].id).toBe(selected.id + 1);
    expect(controller.upNextQueue.at(-1)).toBe(last);
    expect(queueKey(last)).toBe(lastKey);
    expect(readRating).not.toHaveBeenCalled();
  });

  test('queue edits address occurrences, update preloading and undo without restarting audio', async () => {
    await startQueue();
    await act(async () => controller.queueControls.enqueue({ id: 2 }, 'next'));
    expect(queueIds()).toEqual([2, 2, 3, 4]);
    const added = controller.upNextQueue[0];
    const original = controller.upNextQueue[1];
    expect(queueKey(added)).not.toBe(queueKey(original));
    const playbackCalls = defaultPlaybackCoordinator.play.mock.calls.length;
    await act(async () => controller.queueControls.remove(queueKey(added)));
    expect(queueIds()).toEqual([2, 3, 4]);
    expect(controller.queueControls.undoMessage).toBeTruthy();
    await act(async () => controller.queueControls.undo());
    expect(queueIds()).toEqual([2, 2, 3, 4]);
    await act(async () =>
      controller.queueControls.move(
        queueKey(original),
        queueKey(controller.upNextQueue[3]),
      ),
    );
    expect(queueIds()).toEqual([2, 3, 4, 2]);
    expect(defaultPlaybackCoordinator.play).toHaveBeenCalledTimes(
      playbackCalls,
    );
    expect(
      defaultPlaybackCoordinator.updateQueue.mock.calls
        .at(-1)[1]
        .map((track) => track.id),
    ).toEqual([2, 3, 4, 2]);
  });

  test('clear and undo leave the current song playing, and a new selection invalidates undo', async () => {
    await startQueue();
    await act(async () => controller.queueControls.clear());
    expect(queueIds()).toEqual([]);
    expect(controller.currentTrack.id).toBe(1);
    await act(async () => controller.queueControls.undo());
    expect(queueIds()).toEqual([2, 3, 4]);
    await act(async () => controller.queueControls.clear());
    await act(async () => controller.playTrack({ id: 99 }));
    await act(async () => controller.queueControls.undo());
    expect(controller.currentTrack.id).toBe(99);
    expect(queueIds()).toEqual([]);
  });

  test('shuffle restores unplayed order, including after metadata changes and additions', async () => {
    await startQueue();
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await act(async () => controller.queueControls.toggleShuffle());
      expect(queueIds()).toEqual([3, 4, 2]);
      expect(controller.queueControls.shuffleEnabled).toBe(true);
      await act(async () =>
        controller.handleToggleLike(controller.upNextQueue[0]),
      );
      await act(async () => controller.queueControls.enqueue({ id: 5 }));
      await act(async () => controller.queueControls.toggleShuffle());
      expect(queueIds()).toEqual([2, 3, 4, 5]);
      expect(controller.queueControls.shuffleEnabled).toBe(false);
    } finally {
      random.mockRestore();
    }
  });

  test('repeat all cycles the collection before asking for recommendations', async () => {
    await startQueue();
    await act(async () => controller.queueControls.cycleRepeatMode());
    for (let i = 0; i < 4; i++)
      await act(async () => controller.fetchNextTrack({ finished: true }));
    expect(controller.currentTrack.id).toBe(1);
    expect(queueIds()).toEqual([2, 3, 4]);
    expect(
      authFetch.mock.calls.some(([url]) => url.includes('/api/wave/queue')),
    ).toBe(false);
  });

  test('repeat one replays on finish but manual Next still advances', async () => {
    await startQueue();
    await act(async () => {
      controller.queueControls.cycleRepeatMode();
      controller.queueControls.cycleRepeatMode();
    });
    expect(controller.queueControls.repeatMode).toBe('one');
    await act(async () => controller.fetchNextTrack({ finished: true }));
    expect(controller.currentTrack.id).toBe(1);
    expect(queueIds()).toEqual([2, 3, 4]);
    expect(defaultPlaybackCoordinator.play.mock.calls.at(-1)[1].id).toBe(1);
    await act(async () => controller.fetchNextTrack());
    expect(controller.currentTrack.id).toBe(2);
  });

  test('autoplay off stops at the end without requesting a recommendation', async () => {
    await act(async () => controller.playTrackList([{ id: 1 }]));
    await act(async () => controller.queueControls.toggleAutoplay());
    await act(async () => controller.fetchNextTrack({ finished: true }));
    expect(
      authFetch.mock.calls.some(([url]) => url.includes('/api/wave/queue')),
    ).toBe(false);
    expect(defaultPlaybackCoordinator.setIntent).toHaveBeenLastCalledWith(
      mockPlayerInstance,
      expect.objectContaining({ type: 'pause' }),
    );
  });

  test('editing the queue rejects a recommendation response already in flight', async () => {
    let resolveQueue;
    authFetch.mockImplementation(async (url) => {
      if (url.includes('/api/wave/queue'))
        return new Promise((resolve) => {
          resolveQueue = resolve;
        });
      return { ok: true, json: async () => ({}) };
    });
    await act(async () =>
      controller.playTrack({ id: 1 }, { source: 'search' }),
    );
    await act(async () => controller.queueControls.enqueue({ id: 2 }, 'next'));
    await act(async () =>
      resolveQueue({ ok: true, json: async () => [{ id: 99 }] }),
    );
    expect(queueIds()).toEqual([2]);
    await act(async () => controller.fetchNextTrack());
    expect(controller.currentTrack.id).toBe(2);
  });

  test.each([false, true])('startup indicator uses loaded status only without native identity (identity=%s)', async (identityAvailable) => {
    await act(async () => {
      await controller.playTrack({ id: 91, title: 'Track' });
      for (const listener of mockCoordinatorListeners) {
        listener({
          identityAvailable,
          current: { status: 'starting' },
          networkStatus: 'good',
          isBufferingSlow: false,
        });
      }
    });
    expect(controller.isStartingPlayback).toBe(true);

    mockAudioStatus = { ...mockAudioStatus, isLoaded: true, playing: true };
    await act(async () => renderer.update(<HookHarness />));
    expect(controller.isStartingPlayback).toBe(identityAvailable);

    mockAudioStatus = { ...mockAudioStatus, playing: false };
    await act(async () => renderer.update(<HookHarness />));
    expect(controller.isStartingPlayback).toBe(identityAvailable);

    if (identityAvailable) {
      await act(async () => {
        for (const listener of mockCoordinatorListeners) {
          listener({ identityAvailable, current: { status: 'playing' } });
        }
      });
      expect(controller.isStartingPlayback).toBe(false);
    }
  });

  const remoteFavorite = () => mockPlayerInstance.addListener.mock.calls
    .find(([name]) => name === 'toggleFavorite')[1];
  const selection = () => mockPlayerInstance.setFavoriteState.mock.calls.at(-1)[0];

  test('lock screen toggles the selected track and mirrors app changes', async () => {
    await act(async () => { controller.playTrackList([{ id: 41, is_liked: false }], 0); });
    const token = selection();
    expect(token).toBeTruthy();
    expect(mockPlayerInstance.setFavoriteState).toHaveBeenLastCalledWith(token, false, true);
    authFetch.mockClear();
    await act(async () => { await remoteFavorite()({ favoriteSelectionId: token }); });
    expect(setLocalRating).toHaveBeenCalledWith(mockSession, expect.objectContaining({ id: 41 }), 'like');
    expect(controller.currentTrack.is_liked).toBe(true);
    expect(mockPlayerInstance.setFavoriteState).toHaveBeenLastCalledWith(token, true, true);
    await act(async () => { await controller.handleToggleLike(controller.currentTrack); });
    expect(setLocalRating).toHaveBeenLastCalledWith(mockSession, expect.objectContaining({ id: 41 }), 'neutral');
    expect(mockPlayerInstance.setFavoriteState).toHaveBeenLastCalledWith(token, false, true);
  });

  test('lock screen ignores missing and obsolete selection tokens', async () => {
    await act(async () => { controller.playTrackList([{ id: 41, is_liked: false }, { id: 42, is_liked: false }], 0); });
    const oldToken = selection();
    await act(async () => { await controller.fetchNextTrack(); });
    authFetch.mockClear();
    await act(async () => {
      remoteFavorite()({ favoriteSelectionId: oldToken });
      remoteFavorite()({});
      remoteFavorite()();
    });
    expect(authFetch).not.toHaveBeenCalled();
    expect(controller.currentTrack.id).toBe(42);
    expect(controller.currentTrack.is_liked).toBe(false);
  });

  test('a slow local commit keeps the command enabled and applies only after commit', async () => {
    await act(async () => controller.playTrackList([{ id: 41, is_liked: false }]));
    const token = selection();
    let finish;
    const save = setLocalRating.getMockImplementation();
    setLocalRating.mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => { finish = resolve; });
      return save(...args);
    });
    await act(async () => {
      remoteFavorite()({ favoriteSelectionId: token });
      remoteFavorite()({ favoriteSelectionId: token });
    });
    expect(setLocalRating).toHaveBeenCalledTimes(1);
    expect(controller.currentTrack.is_liked).toBe(false);
    expect(mockPlayerInstance.setFavoriteState).toHaveBeenLastCalledWith(token, false, true);
    expect(mockPlayerInstance.setFavoritePending).toHaveBeenLastCalledWith(token, true);
    await act(async () => { finish(); });
    expect(controller.currentTrack.is_liked).toBe(true);
    expect(mockPlayerInstance.setFavoriteState).toHaveBeenLastCalledWith(token, true, true);
    expect(mockPlayerInstance.setFavoritePending).toHaveBeenLastCalledWith(token, false);
  });

  test('an older binary disables the command while the local commit is pending', async () => {
    const setFavoritePending = mockPlayerInstance.setFavoritePending;
    delete mockPlayerInstance.setFavoritePending;
    try {
      await act(async () => controller.playTrackList([{ id: 41 }]));
      const token = selection();
      let finish;
      const save = setLocalRating.getMockImplementation();
      setLocalRating.mockImplementationOnce(async (...args) => {
        await new Promise((resolve) => { finish = resolve; });
        return save(...args);
      });
      await act(async () => { remoteFavorite()({ favoriteSelectionId: token }); });
      expect(mockPlayerInstance.setFavoriteState).toHaveBeenLastCalledWith(token, false, false);
      await act(async () => { finish(); });
      expect(mockPlayerInstance.setFavoriteState).toHaveBeenLastCalledWith(token, true, true);
    } finally {
      mockPlayerInstance.setFavoritePending = setFavoritePending;
    }
  });

  test('a pending rating overrides stale DTOs when switching tracks', async () => {
    await act(async () => controller.playTrackList([{ id: 41 }, { id: 42, is_liked: true }]));
    await act(async () => controller.handleToggleLike(controller.currentTrack));
    await act(async () => controller.fetchNextTrack());
    await act(async () => controller.playTrack({ id: 41, is_liked: false }));
    expect(controller.currentTrack.is_liked).toBe(true);
  });

  test('reselecting the same track gets a new token and rejects its earlier command', async () => {
    const track = { id: 41, is_liked: false };
    await act(async () => { controller.playTrackList([track], 0); });
    const oldToken = selection();
    await act(async () => { controller.playTrackList([track], 0); });
    expect(selection()).not.toBe(oldToken);
    authFetch.mockClear();
    await act(async () => { remoteFavorite()({ favoriteSelectionId: oldToken }); });
    expect(authFetch).not.toHaveBeenCalled();
  });

  test('failed local removal preserves the favorite and dismissal disables the command', async () => {
    await act(async () => { controller.playTrackList([{ id: 41, is_liked: true }], 0); });
    const token = selection();
    setLocalRating.mockRejectedValueOnce(new Error('SQLite unavailable'));
    await act(async () => { remoteFavorite()({ favoriteSelectionId: token }); });
    expect(controller.currentTrack.is_liked).toBe(true);
    expect(mockPlayerInstance.setFavoriteState).toHaveBeenLastCalledWith(token, true, true);
    await act(async () => { controller.dismissPlayer(); });
    expect(mockPlayerInstance.setFavoriteState).toHaveBeenLastCalledWith('', false, false);
  });

  test('a late local commit after unmount never touches the released player', async () => {
    await act(async () => { controller.playTrackList([{ id: 41, is_liked: false }], 0); });
    let finish;
    const save = setLocalRating.getMockImplementation();
    setLocalRating.mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => { finish = resolve; });
      return save(...args);
    });
    await act(async () => { remoteFavorite()({ favoriteSelectionId: selection() }); });
    await act(async () => { renderer.unmount(); });
    mockPlayerInstance.setFavoriteState.mockClear();
    mockPlayerInstance.setFavoritePending.mockClear();
    setTracksMock.mockClear();
    await act(async () => { finish(); });
    expect(mockPlayerInstance.setFavoriteState).not.toHaveBeenCalled();
    expect(mockPlayerInstance.setFavoritePending).not.toHaveBeenCalled();
    expect(setTracksMock).not.toHaveBeenCalled();
  });

  test('credit event patches active and queued tracks without touching playback', async () => {
    const first = { id: 'credit-1', title: 'First', artist: 'Old', artists: [{ id: 'old', name: 'Old' }] };
    const second = { id: 'credit-2', title: 'Second', artist: 'Old' };
    await act(async () => { controller.playTrackList([first, second], 0); });
    defaultPlaybackCoordinator.play.mockClear();
    mockPlayerInstance.seekTo.mockClear();
    mockPlayerInstance.replace.mockClear();
    await act(async () => {
      DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'album', tracks: [
        { id: 'credit-1', artist: 'A, B', artists: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], artists_revision: 1 },
        { id: 'credit-2', artist: 'A, B', artists: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], artists_revision: 1 },
      ] });
    });
    expect(controller.currentTrack.artist).toBe('A, B');
    expect(controller.upNextQueue[0].artist).toBe('A, B');
    expect(defaultPlaybackCoordinator.play).not.toHaveBeenCalled();
    expect(mockPlayerInstance.seekTo).not.toHaveBeenCalled();
    expect(mockPlayerInstance.replace).not.toHaveBeenCalled();
  });

  test('bulk event fetches affected queue metadata and preserves playback', async () => {
    await act(async () => { controller.playTrackList([{ id: 'bulk-a', title: 'A', artist: 'Old' }, { id: 'bulk-b', title: 'B', artist: 'Old' }], 0); });
    defaultPlaybackCoordinator.play.mockClear();
    mockPlayerInstance.seekTo.mockClear();
    authFetch.mockImplementation(async (url) => url.includes('credits_only=true') ? { ok: true, json: async () => ({ id: url.includes('bulk-a') ? 'bulk-a' : 'bulk-b', artist: 'New', artists: [{ id: 'n', name: 'New' }], artists_revision: 2 }) } : { ok: true, json: async () => [] });
    await act(async () => { DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', affected: { track_ids: ['bulk-a', 'bulk-b', 'unrelated'] } }); });
    expect(controller.currentTrack.artist).toBe('New');
    expect(controller.upNextQueue[0].artist).toBe('New');
    expect(authFetch.mock.calls.filter(([url]) => url.includes('credits_only=true'))).toHaveLength(2);
    expect(defaultPlaybackCoordinator.play).not.toHaveBeenCalled();
    expect(mockPlayerInstance.seekTo).not.toHaveBeenCalled();
  });

  test('review: unrelated credit event must not discard pending bulk refresh', async () => {
    await act(async () => { controller.playTrackList([{ id: 'race-a', title: 'A', artist: 'Old' }], 0); });
    let resolveResponse;
    authFetch.mockImplementation((url) => url.includes('credits_only=true') ? new Promise(resolve => { resolveResponse = resolve; }) : Promise.resolve({ok: true, json: async () => []}));
    await act(async () => { DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', affected: { track_ids: ['race-a'] } }); });
    expect(resolveResponse).toBeDefined();
    await act(async () => { DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'track', track: { id: 'race-b', artist: 'B' } }); });
    await act(async () => { resolveResponse({ok: true, json: async () => ({ id: 'race-a', artist: 'New', artists_revision: 2 })}); });
    expect(controller.currentTrack.artist).toBe('New');
  });

  test('review: bulk response from previous user must not update active metadata', async () => {
    await act(async () => { controller.playTrackList([{ id: 'auth-race', title: 'A', artist: 'Old' }], 0); });
    let resolveResponse;
    authFetch.mockImplementation((url) => url.includes('credits_only=true') ? new Promise(resolve => { resolveResponse = resolve; }) : Promise.resolve({ok: true, json: async () => []}));
    await act(async () => { DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', affected: { track_ids: ['auth-race'] } }); });
    expect(resolveResponse).toBeDefined();
    await act(async () => { for (const listener of mockAuthListeners) listener({id: 2, username: 'other'}); });
    await act(async () => { resolveResponse({ok: true, json: async () => ({ id: 'auth-race', artist: 'Old User', artists_revision: 2 })}); });
    expect(controller.currentTrack.artist).toBe('Old');
  });

  test('review: newer event for same track supersedes bulk response', async () => {
    await act(async () => { controller.playTrackList([{id:'same-a', title:'A', artist:'Old'}], 0); });
    let resolveResponse;
    authFetch.mockImplementation((url) => url.includes('credits_only=true') ? new Promise(resolve => {resolveResponse=resolve;}) : Promise.resolve({ok:true,json:async()=>[]}));
    await act(async () => {DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED',{scope:'bulk',affected:{track_ids:['same-a']}});});
    await act(async () => {DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED',{scope:'track',track:{id:'same-a',artist:'Newest',artists_revision:3}});});
    await act(async () => {resolveResponse({ok:true,json:async()=>({id:'same-a',artist:'Older',artists_revision:2})});});
    expect(controller.currentTrack.artist).toBe('Newest');
  });

  test('disjoint bulks update current and queue independently', async () => {
    await act(async () => { controller.playTrackList([{ id: 'a', artist: 'Old' }, { id: 'b', artist: 'Old' }], 0); });
    const requests = {};
    authFetch.mockImplementation((url) => url.includes('credits_only=true') ? new Promise((resolve) => { requests[url.includes('/a?') ? 'a' : 'b'] = resolve; }) : Promise.resolve({ ok: true, json: async () => [] }));
    await act(async () => { DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', affected: { track_ids: ['a', 'a'] } }); DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', affected: { track_ids: ['b'] } }); });
    await act(async () => { requests.b({ ok: true, json: async () => ({ id: 'b', artist: 'New B' }) }); requests.a({ ok: true, json: async () => ({ id: 'a', artist: 'New A' }) }); });
    expect(controller.currentTrack.artist).toBe('New A');
    expect(controller.upNextQueue[0].artist).toBe('New B');
    expect(authFetch.mock.calls.filter(([url]) => url.includes('credits_only=true'))).toHaveLength(2);
  });

  test('bulk refresh limits concurrent requests and deduplicates IDs', async () => {
    const tracks = Array.from({ length: 8 }, (_, i) => ({ id: `limit-${i}`, artist: 'Old' }));
    await act(async () => { controller.playTrackList(tracks, 0); });
    const pending = [];
    authFetch.mockImplementation((url) => url.includes('credits_only=true') ? new Promise((resolve) => pending.push({ url, resolve })) : Promise.resolve({ ok: true, json: async () => [] }));
    await act(async () => { DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', affected: { track_ids: [...tracks.map((t) => t.id), tracks[0].id] } }); });
    expect(pending).toHaveLength(4);
    await act(async () => { pending[0].resolve({ ok: true, json: async () => ({ id: 'limit-0', artist: 'New' }) }); });
    expect(pending).toHaveLength(5);
    await act(async () => { for (let i = 1; i < pending.length; i += 1) pending[i].resolve({ ok: false }); });
  });

  test('credit requests retain the four-request bound across repeated users and queue replacement', async () => {
    const oldTracks = Array.from({ length: 4 }, (_, i) => ({ id: `old-${i}`, artist: 'Old' }));
    const newTracks = Array.from({ length: 6 }, (_, i) => ({ id: `new-${i}`, artist: 'Old', title: `Title ${i}` }));
    await act(async () => { controller.playTrackList(oldTracks, 0); });
    const requests = [];
    let outstanding = 0;
    let maximum = 0;
    authFetch.mockImplementation((url) => {
      if (!url.includes('credits_only=true')) return Promise.resolve({ ok: true, json: async () => [] });
      outstanding += 1;
      maximum = Math.max(maximum, outstanding);
      const id = decodeURIComponent(url.split('/api/tracks/')[1].split('?')[0]);
      return new Promise((resolve) => requests.push({ finish(artist) {
        outstanding -= 1;
        resolve({ ok: true, json: async () => ({ id, artist, title: 'Do not overwrite' }) });
      } }));
    });
    const emitBulk = (tracks) => DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', affected: { track_ids: tracks.map((track) => track.id) } });
    await act(async () => { emitBulk(oldTracks); });
    await act(async () => { mockAuthListeners.forEach((fn) => fn({ id: 2 })); emitBulk(oldTracks); });
    await act(async () => { mockAuthListeners.forEach((fn) => fn({ id: 3 })); controller.playTrackList(newTracks, 0); });
    mockAudioStatus.currentTime = 27;
    await act(async () => { renderer.update(<HookHarness />); emitBulk(newTracks); });
    expect(requests).toHaveLength(4);
    const operations = [defaultPlaybackCoordinator.play, ...['play', 'pause', 'seekTo', 'replace'].map((key) => mockPlayerInstance[key])];
    const operationCounts = operations.map((operation) => operation.mock.calls.length);
    setTracksMock.mockClear();
    for (let i = 0; i < 4; i += 1) {
      await act(async () => { requests[i].finish('Stale'); });
      expect(outstanding).toBe(4);
      expect(controller.currentTrack.artist).toBe('Old');
      expect(controller.upNextQueue.every((track) => track.artist === 'Old')).toBe(true);
      expect(setTracksMock).not.toHaveBeenCalled();
    }
    // Drain the new context without emitting more events, including queued IDs.
    for (let i = 4; i < requests.length; i += 1) await act(async () => { requests[i].finish('Newest'); });
    expect(requests).toHaveLength(10);
    expect(maximum).toBe(4);
    expect(outstanding).toBe(0);
    expect(controller.currentTrack).toEqual(expect.objectContaining({ id: 'new-0', artist: 'Newest', title: 'Title 0' }));
    expect(controller.upNextQueue.map((track) => track.artist)).toEqual(Array(5).fill('Newest'));
    expect(controller.history.some((track) => track.artist === 'Stale')).toBe(false);
    expect(controller.currentTime).toBe(27);
    expect(operations.map((operation) => operation.mock.calls.length)).toEqual(operationCounts);
  });

  test('pending bulk is discarded after server or playback context changes', async () => {
    const api = require('../../shared/api/api');
    await act(async () => { controller.playTrack({ id: 'a', artist: 'Old' }); });
    let resolve;
    authFetch.mockImplementation((url) => url.includes('credits_only=true') ? new Promise((done) => { resolve = done; }) : Promise.resolve({ ok: true, json: async () => [] }));
    await act(async () => { DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', affected: { track_ids: ['a'] } }); });
    api.SERVER_URL = 'https://other';
    await act(async () => { resolve({ ok: true, json: async () => ({ id: 'a', artist: 'Stale' }) }); });
    expect(controller.currentTrack.artist).toBe('Old');
    api.SERVER_URL = 'https://puuk.app';
    await act(async () => { DeviceEventEmitter.emit('PUUK_ARTIST_CREDITS_UPDATED', { scope: 'bulk', affected: { track_ids: ['a'] } }); });
    await act(async () => { controller.playTrack({ id: 'b', artist: 'B' }); });
    await act(async () => { resolve({ ok: true, json: async () => ({ id: 'a', artist: 'Stale' }) }); });
    expect(controller.currentTrack.artist).toBe('B');
    expect(controller.history.find((track) => track.id === 'a')?.artist).not.toBe('Stale');
  });

  describe('play start confirmation telemetry', () => {
    test('does not attribute the previous playing status to a pending or failed track', async () => {
      mockAudioStatus.playing = true;
      await act(async () => {
        controller.playTrack({ id: 710 });
      });
      recordPlayStart.mockClear();

      let rejectLoad;
      defaultPlaybackCoordinator.play.mockImplementationOnce(() => new Promise((resolve, reject) => {
        rejectLoad = reject;
      }));
      await act(async () => {
        controller.playTrack({ id: 711 });
      });
      expect(recordPlayStart).not.toHaveBeenCalled();
      const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
      await act(async () => {
        rejectLoad(new Error('load failed'));
      });
      errorLog.mockRestore();
      expect(recordPlayStart).not.toHaveBeenCalled();
    });

    test('only confirms the latest successful load when requests complete out of order', async () => {
      mockAudioStatus.playing = true;
      let finishOld;
      let finishNew;
      defaultPlaybackCoordinator.play
        .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
        .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
      await act(async () => { controller.playTrack({ id: 712 }); });
      await act(async () => { controller.playTrack({ id: 713 }); });
      expect(recordPlayStart).not.toHaveBeenCalled();
      await act(async () => { finishOld({ uri: 'mock://old' }); });
      expect(recordPlayStart).not.toHaveBeenCalled();
      await act(async () => { finishNew({ uri: 'mock://new' }); });
      expect(recordPlayStart).toHaveBeenCalledTimes(1);
      expect(recordPlayStart).toHaveBeenCalledWith(713, { retry: 1 });
    });

    test('does not confirm a superseded playback result', async () => {
      mockAudioStatus.playing = true;
      defaultPlaybackCoordinator.play.mockResolvedValueOnce({ uri: null, superseded: true });
      await act(async () => { controller.playTrack({ id: 714 }); });
      expect(recordPlayStart).not.toHaveBeenCalled();
    });

    test('records one play start per confirmation key', async () => {
      const track = { id: 701, title: 'Confirmed Track' };
      mockAudioStatus.playing = true;

      await act(async () => {
        controller.playTrackList([track], 0);
      });

      expect(recordPlayStart).toHaveBeenCalledTimes(1);
      expect(recordPlayStart).toHaveBeenCalledWith(701, { retry: 1 });

      // Re-rendering the same confirmed track must not record it again.
      await act(async () => {
        controller.setCurrentTrack({ ...track, title: 'Updated title' });
      });
      expect(recordPlayStart).toHaveBeenCalledTimes(1);

      // A new playback session gets a new confirmation key.
      await act(async () => {
        controller.playTrackList([track], 0);
      });
      expect(recordPlayStart).toHaveBeenCalledTimes(2);
    });

    test('does not record when playing is false', async () => {
      const track = { id: 703, title: 'Paused Track' };
      mockAudioStatus.playing = false;

      await act(async () => {
        controller.playTrack(track);
      });

      expect(recordPlayStart).not.toHaveBeenCalled();
    });

    test('records when playing transitions from false to true and does not record on pause/resume', async () => {
      const track = { id: 704, title: 'Transition Track' };
      mockAudioStatus.playing = false;

      await act(async () => {
        controller.playTrack(track);
      });
      expect(recordPlayStart).not.toHaveBeenCalled();

      // Audio engine reports playing = true
      mockAudioStatus.playing = true;
      await act(async () => {
        controller.setCurrentTrack({ ...track });
      });
      expect(recordPlayStart).toHaveBeenCalledTimes(1);
      expect(recordPlayStart).toHaveBeenCalledWith(704, { retry: 1 });

      // Pause (playing = false)
      mockAudioStatus.playing = false;
      await act(async () => {
        controller.setCurrentTrack({ ...track });
      });
      expect(recordPlayStart).toHaveBeenCalledTimes(1);

      // Resume (playing = true again in same session)
      mockAudioStatus.playing = true;
      await act(async () => {
        controller.setCurrentTrack({ ...track });
      });
      expect(recordPlayStart).toHaveBeenCalledTimes(1);
    });

    test('EV-16: calling playTrackList explicitly starts a new session and emits play start for the same track', async () => {
      const track = { id: 705, title: 'Repeat Single Track' };
      mockAudioStatus.playing = true;

      await act(async () => {
        controller.playTrackList([track], 0);
      });
      expect(recordPlayStart).toHaveBeenCalledTimes(1);
      expect(recordPlayStart).toHaveBeenCalledWith(705, { retry: 1 });

      // Explicitly playing the same track again via playTrackList creates a new playback session
      await act(async () => {
        controller.playTrackList([track], 0);
      });
      expect(recordPlayStart).toHaveBeenCalledTimes(2);
      expect(recordPlayStart).toHaveBeenLastCalledWith(705, { retry: 1 });
    });

    test('ignores tracks without valid identifier', async () => {
      mockAudioStatus.playing = true;

      await act(async () => {
        controller.setCurrentTrack({ title: 'No ID Track' });
      });
      expect(recordPlayStart).not.toHaveBeenCalled();
    });

    test('does not retry after a rejected play start call', async () => {
      const track = { id: 702, title: 'Rejected Confirmation' };
      recordPlayStart.mockRejectedValueOnce(new Error('recording failed'));
      mockAudioStatus.playing = true;

      await act(async () => {
        controller.playTrackList([track], 0);
        await Promise.resolve();
      });

      // The key is consumed before the promise settles, so a later render
      // cannot issue a second request for the rejected call.
      await act(async () => {
        controller.setCurrentTrack({ ...track, title: 'Updated title' });
        await Promise.resolve();
      });

      expect(recordPlayStart).toHaveBeenCalledTimes(1);
    });
  });

  test('selection from a playlist appears while audio is pending and a late completion cannot replace a newer tap', async () => {
    const first = { id: 1, title: 'First', coverArt: 'first.jpg' };
    const next = { id: 2, title: 'Second', coverArt: 'second.jpg' };
    let finish;
    defaultPlaybackCoordinator.play.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const select = controller.playTrack;
    await act(async () => { controller.playTrackList([first, next, first]); });
    expect(controller.currentTrack).toMatchObject(first);
    expect(controller.upNextQueue[0]).toBe(next);
    expect(queueKey(controller.currentTrack)).not.toBe(queueKey(controller.upNextQueue[1]));
    expect(controller.playTrack).toBe(select);
    await act(async () => { select(next); });
    await act(async () => { finish({ isLocal: false, uri: 'mock://first' }); });
    expect(controller.currentTrack).toMatchObject(next);
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

  test('collection starts in the middle, stays ordered, and requests similar tracks only at the end', async () => {
    const list = [1, 2, 3].map((id) => ({ id, title: `Track ${id}` }));
    authFetch.mockImplementation(async (url) => ({
      ok: true, status: 200,
      json: async () => url.includes('/api/wave/queue') ? [{ id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }] : {},
    }));
    const queueCalls = () => authFetch.mock.calls.filter(([url]) => url.includes('/api/wave/queue'));
    await act(async () => { controller.playTrackList(list, 1); });
    expect(controller.currentTrack.id).toBe(2);
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([3]);
    expect(controller.previousTrack.id).toBe(1);
    await act(async () => { await controller.fetchNextTrack(); });
    expect(controller.currentTrack.id).toBe(3);
    expect(queueCalls()).toHaveLength(0);
    await act(async () => {
      mockAudioStatus = { ...mockAudioStatus, didJustFinish: true, currentTime: 100 };
      renderer.update(<HookHarness />);
    });
    expect(controller.currentTrack.id).toBe(4);
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([5, 6, 7]);
    expect(queueCalls()).toHaveLength(1);
    const query = new URL(queueCalls()[0][0], 'https://puuk.app').searchParams;
    expect(query.get('current_track_id')).toBe('3');
    expect(query.getAll('exclude_track_ids')).toEqual(expect.arrayContaining(['1', '2', '3']));
  });

  test('single track does not start recommendations; search does', async () => {
    authFetch.mockImplementation(async (url) => ({
      ok: true, status: 200, json: async () => url.includes('/api/wave/queue') ? [{ id: 2 }] : {},
    }));
    await act(async () => { controller.playTrack({ id: 1 }); });
    expect(authFetch.mock.calls.some(([url]) => url.includes('/api/wave/queue'))).toBe(false);
    await act(async () => { controller.playTrack({ id: 1 }, { source: 'search' }); });
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([2]);
  });

  test('selecting a queued collection track preserves the remaining order', async () => {
    const list = [1, 2, 3, 4].map((id) => ({ id }));
    await act(async () => { controller.playTrackList(list); });
    await act(async () => { controller.playTrack(list[2], { source: 'queue', queueIndex: 1 }); });
    expect(controller.currentTrack.id).toBe(3);
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([4]);
    expect(authFetch.mock.calls.some(([url]) => url.includes('/api/wave/queue'))).toBe(false);
  });

  test.each(['new collection', 'dismiss'])('late end-of-queue response cannot override %s', async (action) => {
    let resolveQueue;
    authFetch.mockImplementation(async (url) => {
      if (url.includes('/api/wave/queue')) return new Promise((resolve) => { resolveQueue = resolve; });
      return { ok: true, status: 200, json: async () => ({}) };
    });
    await act(async () => { controller.playTrackList([{ id: 1 }]); });
    let advance;
    await act(async () => { advance = controller.fetchNextTrack(); });
    await act(async () => {
      if (action === 'dismiss') await controller.dismissPlayer();
      else controller.playTrackList([{ id: 10 }, { id: 11 }]);
    });
    if (action !== 'dismiss') await act(async () => { await controller.fetchNextTrack(); });
    await act(async () => {
      resolveQueue({ ok: true, json: async () => [{ id: 99 }] });
      await advance;
    });
    expect(controller.currentTrack?.id ?? null).toBe(action === 'dismiss' ? null : 11);
    expect(controller.upNextQueue).toEqual([]);
  });

  test('empty recommendations leave the final track selected and pause playback', async () => {
    await act(async () => { controller.playTrackList([{ id: 1 }]); });
    await act(async () => { await controller.fetchNextTrack(); });
    expect(controller.currentTrack.id).toBe(1);
    expect(controller.upNextQueue).toEqual([]);
    expect(mockPlayerInstance.pause).toHaveBeenCalled();
  });

  test('each Wave launch requests a new online queue and avoids restarting the last track', async () => {
    const current = { id: 'saved-current' };
    const old = { id: 'saved-future' };
    const a = { id: 'a', duration: 3600 };
    const b = { id: 'b', duration: 3600 };
    const c = { id: 'c', duration: 3600 };
    readWaveQueue.mockResolvedValue({ current, future: [old], history: [] });
    const batches = [[current, a, b], [a, c, b]];
    authFetch.mockImplementation(async (url) => ({
      ok: true,
      json: async () => isWaveStart(url) ? batches.shift() : [],
    }));
    await act(async () => controller.startWave());
    expect(controller.currentTrack.id).toBe(a.id);
    expect(queueIds()).toEqual([b.id, current.id]);

    await act(async () => controller.startWave());
    expect(controller.currentTrack.id).toBe(c.id);
    expect(queueIds()).toEqual([b.id, a.id]);
    const requests = authFetch.mock.calls.map(([url]) => url).filter(isWaveStart);
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0], 'https://puuk.app').searchParams.getAll('exclude_track_ids')).toEqual([current.id]);
    expect(new URL(requests[1], 'https://puuk.app').searchParams.getAll('exclude_track_ids')).toEqual([current.id, a.id]);
  });

  test('offline launch uses recent plays for a fresh queue while Play resumes the saved session', async () => {
    const current = { id: 'saved' };
    const old = { id: 'old' };
    const a = { id: 'a' };
    const b = { id: 'b' };
    const snapshot = { current, future: [old], history: [], localFuture: true };
    readWaveQueue.mockResolvedValue(snapshot);
    await act(async () => { await controller.restoreSavedWave(mockSession, current); });
    expect(saveWaveQueue).toHaveBeenLastCalledWith(mockSession, expect.any(Object), { updateReserve: false });
    getNetworkStateAsync.mockResolvedValue({ isConnected: false, type: 'NONE' });
    await act(async () => getNetworkPolicy());
    readMediaKey.mockResolvedValueOnce({ trackId: current.id });
    await act(async () => controller.togglePlayPause());
    expect(defaultPlaybackCoordinator.play.mock.lastCall[1].id).toBe(current.id);
    expect(queueIds()).toEqual([old.id]);
    expect(selectLocalWaveTracks).not.toHaveBeenCalled();

    selectLocalWaveTracks
      .mockResolvedValueOnce({ tracks: [a, b], reserveIds: new Set([a.id]) })
      .mockResolvedValueOnce({ tracks: [b, current], reserveIds: new Set() });
    await act(async () => controller.startWave());
    expect(controller.currentTrack.id).toBe(a.id);
    expect(queueIds()).toEqual([b.id]);
    await act(async () => controller.startWave());
    expect(controller.currentTrack.id).toBe(b.id);
    expect(queueIds()).toEqual([current.id]);
    expect(authFetch.mock.calls.some(([url]) => url.includes('/wave/queue'))).toBe(false);
    expect(selectLocalWaveTracks).toHaveBeenLastCalledWith(mockSession, expect.objectContaining({
      current: null,
      future: [],
      history: [expect.objectContaining({ id: current.id }), expect.objectContaining({ id: a.id })],
    }));
    expect(saveWaveQueue).toHaveBeenLastCalledWith(mockSession, expect.objectContaining({
      current: expect.objectContaining({ id: b.id }),
    }), { updateReserve: false });
  });

  test('pausing the selected track during Wave startup keeps its new queue', async () => {
    authFetch.mockResolvedValue({ ok: true, json: async () => [{ id: 'first' }, { id: 'next', duration: 3600 }] });
    let ready;
    defaultPlaybackCoordinator.play.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    let start;
    await act(async () => { start = controller.startWave(); });
    await act(async () => controller.togglePlayPause());
    expect(defaultPlaybackCoordinator.setIntent.mock.lastCall[1].type).toBe('pause');
    await act(async () => {
      ready({ uri: 'mock://stream' });
      await start;
    });
    expect(controller.currentTrack.id).toBe('first');
    expect(queueIds()).toEqual(['next']);
  });

  describe('starting Wave with a downloaded reserve', () => {
    let reply;
    beforeEach(() => {
      jest.useFakeTimers();
      readWaveQueue.mockResolvedValue({
        current: { id: 'recent' }, history: [],
        reserve: ['recent', 'missing', 'ready', 'also-ready'].map(id => ({ id })),
      });
      readPlayableIds.mockResolvedValue(new Set(['ready', 'also-ready']));
      authFetch.mockImplementation(url => isWaveStart(url)
        ? new Promise(resolve => {
          reply = () => resolve({ ok: true, json: async () => [{ id: 'ready' }, { id: 'fresh', duration: 3600 }] });
        })
        : Promise.resolve({ ok: true, json: async () => [] }));
    });
    afterEach(() => jest.useRealTimers());

    test.each(['play', 'switch'])('slow recommendations arrive after local playback (%s)', async action => {
      let start;
      await act(async () => { start = controller.startWave(); });
      await act(async () => jest.advanceTimersByTimeAsync(399));
      expect(defaultPlaybackCoordinator.play).not.toHaveBeenCalled();
      await act(async () => jest.advanceTimersByTimeAsync(1));
      await start;
      expect(readPlayableIds).toHaveBeenCalledWith(mockSession, ['missing', 'ready', 'also-ready']);
      expect(controller.currentTrack.id).toBe('ready');
      expect(defaultPlaybackCoordinator.play.mock.lastCall[2].offlineOnly).toBe(true);
      expect(queueIds()).toEqual(['also-ready']);
      if (action === 'switch') await act(async () => controller.playTrackList([{ id: 'manual' }, { id: 'next' }]));
      const plays = defaultPlaybackCoordinator.play.mock.calls.length;
      await act(async () => { reply(); });
      expect(defaultPlaybackCoordinator.play).toHaveBeenCalledTimes(plays);
      expect(controller.currentTrack.id).toBe(action === 'switch' ? 'manual' : 'ready');
      expect(queueIds()).toEqual(action === 'switch' ? ['next'] : ['fresh']);
      expect(authFetch.mock.calls.filter(([url]) => url.includes('/wave/queue'))).toHaveLength(1);
      if (action === 'play') {
        await act(async () => controller.queueControls.cycleRepeatMode());
        await act(async () => controller.fetchNextTrack());
        await act(async () => controller.fetchNextTrack());
        expect(controller.currentTrack.id).toBe('ready');
        expect(queueIds()).toEqual(['fresh']);
      }
    });

    test.each(['fast network', 'empty reserve', 'local playback failed'])('%s keeps the original recommendations request', async scenario => {
      readPlayableIds.mockResolvedValue(new Set(scenario === 'empty reserve' ? [] : ['also-ready']));
      if (scenario === 'local playback failed')
        defaultPlaybackCoordinator.play.mockResolvedValueOnce({ error: new Error('File gone') });
      let start;
      await act(async () => { start = controller.startWave(); });
      if (scenario !== 'fast network') await act(async () => jest.advanceTimersByTimeAsync(450));
      await act(async () => { reply(); await start; });
      if (scenario === 'fast network') expect(readPlayableIds).not.toHaveBeenCalled();
      expect(controller.currentTrack.id).toBe('ready');
      expect(queueIds()).toEqual(['fresh']);
      expect(defaultPlaybackCoordinator.play.mock.lastCall[2].offlineOnly).toBeUndefined();
      expect(authFetch.mock.calls.filter(([url]) => url.includes('/wave/queue'))).toHaveLength(1);
    });
  });

  test('dislike advances the wave and does not affect a track selected during the request', async () => {
    authFetch.mockImplementation(async (url) => ({
      ok: true,
      json: async () => isWaveStart(url) ? [{ id: 999 }, { id: 1001 }, { id: 1002 }] : [],
    }));
    await act(async () => controller.startWave());
    await act(async () => controller.handleToggleDislike(controller.currentTrack));
    expect(controller.currentTrack.id).toBe(1001);
    expect(controller.dislikeIds.has('999')).toBe(true);
    let resolve;
    const response = new Promise((done) => { resolve = done; });
    const save = setLocalRating.getMockImplementation();
    setLocalRating.mockImplementationOnce(async (...args) => { await response; return save(...args); });
    let pending;
    await act(async () => { pending = controller.handleToggleDislike(controller.currentTrack); });
    expect(controller.dislikePending).toBe(true);
    await act(async () => controller.playTrackList([{ id: 7, is_liked: true }, { id: 8 }]));
    await act(async () => { resolve({ ok: true }); await pending; });
    expect(controller.currentTrack.id).toBe(7);
    expect(controller.currentTrack.is_liked).toBe(true);
    expect(queueIds()).toEqual([8]);
  });

  test('drain replaces only recommendations and never restarts the current audio', async () => {
    let candidates = [{ id: 'old' }];
    authFetch.mockImplementation(async (url) => ({
      ok: true,
      json: async () => isWaveStart(url) ? [{ id: 'now' }, ...candidates] : candidates,
    }));
    await act(async () => controller.startWave());
    await act(async () => controller.queueControls.enqueue({ id: 'manual' }));
    expect(queueIds()).toEqual(['old', 'manual']);
    await act(async () => controller.handleToggleDislike({ id: 'unavailable' }));
    candidates = [{ id: 'unavailable' }, { id: 'fresh' }];
    const plays = defaultPlaybackCoordinator.play.mock.calls.length;
    const token = selection();
    await act(async () => notifyOfflineIndex({ type: 'interactions-drained', session: mockSession }));
    expect(queueIds()).toEqual(['manual', 'fresh']);
    expect(controller.currentTrack.id).toBe('now');
    expect(defaultPlaybackCoordinator.play).toHaveBeenCalledTimes(plays);
    expect(selection()).toBe(token);
  });

  test('brain failure plays the verified reserve then a downloaded collection and reconnect refreshes at the boundary', async () => {
    readWaveQueue.mockResolvedValue({
      current: { id: 'wave-current' },
      future: [{ id: 'wave-missing' }, { id: 'wave-ready' }],
      history: [],
    });
    authFetch.mockImplementation(async (url) => ({
      ok: !url.includes('/wave/queue'),
      status: url.includes('/wave/queue') ? 503 : 200,
      json: async () => [],
    }));
    selectLocalWaveTracks
      .mockResolvedValueOnce({ tracks: [{ id: 'wave-ready' }, { id: 'downloaded' }], reserveIds: new Set(['wave-ready']) })
      .mockResolvedValueOnce({ tracks: [{ id: 'downloaded' }], reserveIds: new Set() });
    await act(async () => controller.startWave());
    expect(controller.currentTrack.id).toBe('wave-ready');
    expect(defaultPlaybackCoordinator.play.mock.lastCall[2]).toMatchObject({ offlineOnly: true });
    await act(async () => controller.fetchNextTrack({ finished: true }));
    expect(controller.currentTrack.id).toBe('downloaded');
    expect(defaultPlaybackCoordinator.play.mock.lastCall[2]).toMatchObject({ offlineOnly: true });

    authFetch.mockImplementation(async () => ({
      ok: true, json: async () => [{ id: 'new-after-drain', duration: 3600 }],
    }));
    const before = defaultPlaybackCoordinator.play.mock.calls.length;
    await act(async () => notifyOfflineIndex({ type: 'interactions-drained', session: mockSession }));
    expect(controller.currentTrack.id).toBe('downloaded');
    expect(defaultPlaybackCoordinator.play).toHaveBeenCalledTimes(before);
    expect(controller.upNextQueue[0].id).toBe('new-after-drain');
    await act(async () => controller.fetchNextTrack({ finished: true }));
    expect(controller.currentTrack.id).toBe('new-after-drain');
    expect(defaultPlaybackCoordinator.play.mock.lastCall[2]).not.toHaveProperty('offlineOnly');
  });

  test('network reachability cannot refresh Wave before S4 drain and never replaces the current source', async () => {
    const current = { id: 'offline-now' };
    const ready = { id: 'offline-next', duration: 3600 };
    const fresh = { id: 'recommended-after-drain', duration: 3600 };
    let reconciled = false;
    authFetch.mockImplementation(async (path) => ({
      ok: true,
      json: async () => isWaveStart(path) ? [current, ready] : reconciled ? [fresh] : [],
    }));
    await act(async () => controller.startWave());
    const plays = defaultPlaybackCoordinator.play.mock.calls.length;
    authFetch.mockClear();

    getNetworkStateAsync.mockResolvedValue({ isConnected: false, type: 'NONE' });
    await act(async () => getNetworkPolicy());
    getNetworkStateAsync.mockResolvedValue({ isConnected: true, type: 'WIFI' });
    await act(async () => getNetworkPolicy());
    expect(authFetch.mock.calls.some(([path]) => path.includes('/wave/queue'))).toBe(false);
    expect(defaultPlaybackCoordinator.play).toHaveBeenCalledTimes(plays);

    selectLocalWaveTracks.mockResolvedValueOnce({ tracks: [ready], reserveIds: new Set([ready.id]) });
    await act(async () => controller.fetchNextTrack({ finished: true }));
    expect(controller.currentTrack.id).toBe(ready.id);
    expect(defaultPlaybackCoordinator.play.mock.lastCall[2]).toMatchObject({ offlineOnly: true });
    expect(authFetch.mock.calls.some(([path]) => path.includes('/wave/queue'))).toBe(false);

    reconciled = true;
    await act(async () => notifyOfflineIndex({ type: 'interactions-drained', session: mockSession }));
    expect(authFetch.mock.calls.some(([path]) => path.includes('/wave/queue'))).toBe(true);
    expect(controller.currentTrack.id).toBe(ready.id);
    expect(defaultPlaybackCoordinator.play).toHaveBeenCalledTimes(plays + 1);
    await act(async () => controller.fetchNextTrack({ finished: true }));
    expect(controller.currentTrack.id).toBe(fresh.id);
    expect(defaultPlaybackCoordinator.play).toHaveBeenCalledTimes(plays + 2);
  });

  test('late initial wave response cannot replace a collection', async () => {
    let resolveWave;
    authFetch.mockImplementation(async (url) => {
      if (isWaveStart(url)) return new Promise((resolve) => { resolveWave = resolve; });
      return { ok: true, status: 200, json: async () => ({}) };
    });
    let start;
    await act(async () => { start = controller.startWave(); });
    await act(async () => { controller.playTrackList([{ id: 10 }, { id: 11 }]); });
    await act(async () => {
      resolveWave({ ok: true, json: async () => [{ id: 99 }] });
      await start;
    });
    expect(controller.currentTrack.id).toBe(10);
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([11]);
  });

  test('race condition: late wave queue response does not pollute manual playlist', async () => {
    let waveQueueResolve;
    const waveQueuePromise = new Promise((resolve) => {
      waveQueueResolve = resolve;
    });

    authFetch.mockImplementation(async (url) => {
      if (isWaveStart(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 50, title: 'Wave 50' }, { id: 49 }],
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
      await controller.startWave();
    });
    expect(authFetch.mock.calls.some(([url]) => url.includes('current_track_id=50'))).toBe(true);

    // 2. User quickly switches to a manual album playlist before wave response arrives
    const albumList = [
      { id: 201, title: 'Album 1' },
      { id: 202, title: 'Album 2' },
    ];
    await act(async () => {
      controller.playTrackList(albumList, 0);
    });

    expect(controller.currentTrack.id).toBe(201);
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([202]);

    // 3. Late wave response finally arrives
    await act(async () => {
      waveQueueResolve();
    });

    // The manual queue must NOT be polluted with Stale Wave Rec!
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([202]);
  });

  test('leaving an unplayed selection creates no history or feedback', async () => {
    await act(async () => controller.playTrackList([{ id: 10 }, { id: 20 }]));
    await act(async () => controller.fetchNextTrack());
    expect(controller.currentTrack.id).toBe(20);
    expect(authFetch.mock.calls.some(([url]) => /history|feedback/.test(url))).toBe(false);
  });

  test('each manual Next advances the queue, including during playback startup', async () => {
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

    expect(controller.currentTrack.id).toBe(3);
    expect(controller.upNextQueue).toEqual([]);
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

    test('preserves loudness normalization metrics and status', () => {
      const dto = normalizeTrackDto({
        id: 7,
        title: 'Loud Track',
        normalization_gain_db: -4.5,
        loudness_status: 'analyzed',
        loudness_lufs: -9.5,
        true_peak_db: -0.5,
      });

      expect(dto.normalization_gain_db).toBe(-4.5);
      expect(dto.loudness_status).toBe('analyzed');
      expect(dto.loudness_lufs).toBe(-9.5);
      expect(dto.true_peak_db).toBe(-0.5);
    });

    test('preserves extra metadata and aliases legacy IDs without stripping', () => {
      const raw = {
        track_id: 'legacy-wave-77',
        title: 'Legacy Wave',
        artist: 'Wave Artist',
        album: 'Space Age',
        year: 1978,
        genre: 'Disco',
        custom_meta: { source: 'vinyl' },
      };
      const dto = normalizeTrackDto(raw);
      expect(dto.id).toBe('legacy-wave-77');
      expect(dto.track_id).toBe('legacy-wave-77');
      expect(dto.title).toBe('Legacy Wave');
      expect(dto.artist).toBe('Wave Artist');
      expect(dto.album).toBe('Space Age');
      expect(dto.year).toBe(1978);
      expect(dto.genre).toBe('Disco');
      expect(dto.custom_meta).toEqual({ source: 'vinyl' });
      expect(dto.coverArt).toBe('https://puuk.app/api/cover/legacy-wave-77');
    });

    test('keeps player-specific artist default when source metadata is missing', () => {
      const dto = normalizeTrackDto({ id: 'missing-artist' });
      expect(dto.title).toBe('Unknown Track');
      expect(dto.artist).toBe('My Wave');
    });
  });

  describe('Playback initiation', () => {
    test('handles asynchronous playback rejection without an unhandled promise', async () => {
      const originalError = console.error;
      console.error = jest.fn();
      defaultPlaybackCoordinator.play.mockRejectedValueOnce(
        Object.assign(new Error('Remote replace failed'), {
          type: 'remote_replace_error',
        }),
      );

      await act(async () => {
        controller.playTrack({ id: 404, title: 'Rejected Track' });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(console.error).toHaveBeenCalledWith(
        '[usePlayerController] Playback command failed',
      );
      console.error = originalError;
    });

    test('starts playback before requesting future recommendations', async () => {
      const events = [];
      defaultPlaybackCoordinator.play.mockImplementationOnce(async () => {
        events.push('play');
        return { uri: 'mock://stream' };
      });
      authFetch.mockImplementation(async (path) => {
        if (path.includes('/wave/queue')) events.push('queue');
        return { ok: true, json: async () => [] };
      });
      await act(async () => controller.playTrack({ id: 77 }, { source: 'search' }));
      expect(events).toEqual(['play', 'queue']);
      expect(authFetch.mock.calls.some(([url]) => /history|feedback/.test(url))).toBe(false);
    });
  });


  describe('dismissPlayer', () => {
    it('stops audio playback, clears queue, resets currentTrack, and deactivates lock screen', async () => {
      const list = [
        { id: 101, title: 'Track 101' },
        { id: 102, title: 'Track 102' },
      ];

      await act(async () => {
        controller.playTrackList(list, 0);
      });

      expect(controller.currentTrack).toEqual(
        expect.objectContaining({ id: 101 }),
      );
      expect(controller.upNextQueue).toHaveLength(1);

      await act(async () => {
        await controller.dismissPlayer();
      });

      expect(controller.player.pause).toHaveBeenCalled();
      expect(controller.player.setActiveForLockScreen).toHaveBeenCalledWith(
        false,
      );
      expect(controller.currentTrack).toBeNull();
      expect(controller.upNextQueue).toEqual([]);
      expect(controller.isPlayerVisible).toBe(false);
      expect(defaultPlaybackCoordinator.updateQueue).toHaveBeenCalledWith(
        null,
        [],
      );
    });

    it('keeps player in compact mode (isPlayerVisible remains false) when playing tracks', async () => {
      const list = [
        { id: 201, title: 'Compact Track 1' },
        { id: 202, title: 'Compact Track 2' },
      ];

      expect(controller.isPlayerVisible).toBe(false);

      await act(async () => {
        controller.playTrackList(list, 0);
      });

      expect(controller.currentTrack).toEqual(
        expect.objectContaining({ id: 201 }),
      );
      expect(controller.isPlayerVisible).toBe(false);

      await act(async () => {
        controller.playTrack(list[1]);
      });

      expect(controller.currentTrack).toEqual(
        expect.objectContaining({ id: 202 }),
      );
      expect(controller.isPlayerVisible).toBe(false);
    });

    it('exposes previousTrack and nextTrack for prepared horizontal swipe', async () => {
      const list = [
        { id: 301, title: 'Track 1' },
        { id: 302, title: 'Track 2' },
        { id: 303, title: 'Track 3' },
      ];

      await act(async () => {
        controller.playTrackList(list, 0);
      });

      expect(controller.previousTrack).toBeNull();
      expect(controller.nextTrack).toEqual(
        expect.objectContaining({ id: 302 }),
      );

      await act(async () => {
        await controller.fetchNextTrack();
      });

      expect(controller.currentTrack.id).toBe(302);
      expect(controller.previousTrack).toEqual(
        expect.objectContaining({ id: 301 }),
      );
      expect(controller.nextTrack).toEqual(
        expect.objectContaining({ id: 303 }),
      );

      // Force playPreviousTrack even if seeking or forced
      await act(async () => {
        controller.playPreviousTrack({ force: true });
      });

      expect(controller.currentTrack.id).toBe(301);
      expect(controller.nextTrack).toEqual(
        expect.objectContaining({ id: 302 }),
      );
    });
  });

  describe('Track loudness normalization & Sound Check reactivity', () => {
    test('loadAndPlay passes soundCheck flag to defaultPlaybackCoordinator.play', async () => {
      const track = {
        id: 501,
        title: 'Analyzed Track',
        loudness_status: 'analyzed',
        normalization_gain_db: -5.0,
      };

      await act(async () => {
        controller.playTrack(track);
      });

      expect(defaultPlaybackCoordinator.play).toHaveBeenCalledWith(
        mockPlayerInstance,
        track,
        expect.objectContaining({ soundCheck: true }),
      );
    });

    test('updating soundCheck setting immediately updates player volume for active track', async () => {
      const track = {
        id: 502,
        title: 'Loud Track',
        loudness_status: 'analyzed',
        normalization_gain_db: -6.0,
      };

      await act(async () => {
        controller.playTrack(track);
      });

      // Toggling soundCheck to false sets volume to 1.0
      await act(async () => {
        await updateSetting('soundCheck', false);
      });

      expect(mockPlayerInstance.volume).toBe(1.0);

      // Toggling soundCheck back to true applies attenuation (~0.501)
      await act(async () => {
        await updateSetting('soundCheck', true);
      });

      expect(mockPlayerInstance.volume).toBeCloseTo(0.501187, 4);
    });

    test('refreshes track loudness asynchronously when track is pending', async () => {
      const pendingTrack = {
        id: 503,
        title: 'Pending Track',
        loudness_status: 'pending',
        normalization_gain_db: null,
      };

      authFetch.mockImplementation(async (url) => {
        if (url.includes('/api/tracks/503')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 503,
              loudness_status: 'analyzed',
              normalization_gain_db: -6.0,
              loudness_lufs: -8.0,
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      });

      await act(async () => {
        controller.playTrack(pendingTrack);
      });

      expect(mockPlayerInstance.volume).toBeCloseTo(0.501187, 4);
      expect(controller.currentTrack.loudness_status).toBe('analyzed');
      expect(controller.currentTrack.normalization_gain_db).toBe(-6.0);
    });

    test('loudness refresh with numeric ID 0 correctly updates currentTrack and queue', async () => {
      const zeroTrack = {
        id: 0,
        title: 'Zero Pending Track',
        loudness_status: 'pending',
        normalization_gain_db: null,
      };

      authFetch.mockImplementation(async (url) => {
        if (url.includes('/api/tracks/0')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 0,
              loudness_status: 'analyzed',
              normalization_gain_db: -4.0,
              loudness_lufs: -10.0,
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      });

      await act(async () => {
        controller.playTrack(zeroTrack);
      });

      expect(controller.currentTrack.id).toBe(0);
      expect(controller.currentTrack.loudness_status).toBe('analyzed');
      expect(controller.currentTrack.normalization_gain_db).toBe(-4.0);
    });

    test('queue fetching deduplicates across id and track_id forms including 0 and ignores invalid items', async () => {
      authFetch.mockImplementation(async (url) => {
        if (url.includes('/api/wave/queue')) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { track_id: 'q-existing', title: 'Updated Existing' },
              { id: 0, title: 'Zero Track Q' },
              null,
              {},
              { id: '' },
              { track_id: 'q-new', title: 'New Track Q' },
            ],
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      });

      await act(async () => {
        controller.playTrack({ id: 'current-playing', title: 'Playing' });
      });

      // Initially set up existing queue with 'q-existing' using id
      await act(async () => {
        controller.playTrackList(
          [
            { id: 'track-start' },
            { id: 'q-existing', title: 'Initial Existing' },
          ],
          0,
        );
      });

      // Now trigger wave queue fetch for recommendations
      await act(async () => {
        controller.playTrack({ id: 'wave-start', title: 'Wave Start' }, { source: 'search' });
      });

      // Wait for fetchQueue promise resolution
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const queueIds = controller.upNextQueue.map((t) => t.id);
      expect(queueIds).toContain('q-existing');
      expect(queueIds).toContain(0);
      expect(queueIds).toContain('q-new');
      expect(queueIds).not.toContain(null);
      expect(queueIds).not.toContain(undefined);
      expect(queueIds).not.toContain('');
    });
  });
});
