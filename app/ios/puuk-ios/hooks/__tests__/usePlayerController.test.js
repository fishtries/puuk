import React from 'react';
import { DeviceEventEmitter } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import usePlayerController, { normalizeTrackDto } from '../usePlayerController';
import defaultPlaybackCoordinator from '../../utils/playbackCoordinator';
import { authFetch } from '../../shared/api/api';
import { updateSetting } from '../../shared/storage/settings';
import { recordPlayStart } from '../../shared/api/artists';

const mockCoordinatorListeners = new Set();
const mockAuthListeners = new Set();
let mockAudioStatus;

// Mock dependencies
jest.mock('../../utils/playbackCoordinator', () => {
  return {
    __esModule: true,
    default: {
      play: jest
        .fn()
        .mockResolvedValue({ isLocal: false, uri: 'mock://stream' }),
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

const mockPlayerInstance = {
  replace: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  seekTo: jest.fn(),
  setActiveForLockScreen: jest.fn(),
  addListener: jest.fn(() => ({ remove: jest.fn() })),
};

jest.mock('expo-audio', () => ({
  useAudioPlayer: jest.fn(() => mockPlayerInstance),
  useAudioPlayerStatus: jest.fn(() => mockAudioStatus),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  preload: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../shared/api/api', () => ({
  SERVER_URL: 'https://puuk.app',
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

  test('initial state has default queue and network UX values', () => {
    expect(controller.currentTrack).toBeNull();
    expect(controller.upNextQueue).toEqual([]);
    expect(controller.networkStatus).toBe('good');
    expect(controller.nextTrackStatus).toBe('idle');
    expect(controller.networkError).toBeNull();
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
          json: async () => ({
            id: 999,
            title: 'Wave Song',
            artist: 'Wave Artist',
          }),
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
    const waveQueuePromise = new Promise((resolve) => {
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
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([202]);

    // 3. Late wave response finally arrives
    await act(async () => {
      waveQueueResolve();
    });

    // The manual queue must NOT be polluted with Stale Wave Rec!
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([202]);
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
      }),
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
    expect(controller.upNextQueue.map((t) => t.id)).toEqual([3]);
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

  describe('Playback initiation order and history deduplication', () => {
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
        '[usePlayerController] loadAndPlay error:',
        expect.objectContaining({ type: 'remote_replace_error', trackId: 404 }),
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
        expect.objectContaining({ headers: expect.any(Object) }),
      );

      // History was sent once
      const historyCallsFirst = authFetch.mock.calls.filter((c) =>
        c[0].includes('/api/tracks/88/history'),
      );
      expect(historyCallsFirst.length).toBe(1);

      // Re-triggering playTrack with same track within 30 seconds should NOT send history again
      await act(async () => {
        controller.playTrack(track);
      });

      const historyCallsSecond = authFetch.mock.calls.filter((c) =>
        c[0].includes('/api/tracks/88/history'),
      );
      expect(historyCallsSecond.length).toBe(1);
    });

    test('execution order contract: coordinator.play is called strictly before fetchQueue and history/telemetry', async () => {
      const events = [];
      defaultPlaybackCoordinator.play.mockImplementation(
        async (player, track) => {
          events.push(`coordinator.play:${track?.id}`);
          return { isLocal: false, uri: 'mock://stream' };
        },
      );
      authFetch.mockImplementation(async (url) => {
        const path = url.split('?')[0];
        events.push(`authFetch:${path}`);
        if (path.includes('/api/wave/queue')) {
          return {
            ok: true,
            status: 200,
            json: async () => [{ id: 99, title: 'Next In Wave' }],
          };
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
      expect(events.indexOf('coordinator.play:77')).toBeLessThan(
        events.indexOf('authFetch:/api/wave/queue'),
      );
      expect(events.indexOf('coordinator.play:77')).toBeLessThan(
        events.indexOf('authFetch:/api/tracks/77/history'),
      );

      // Also verify order in fetchNextTrack: coordinator.play must precede feedback and history
      events.length = 0;
      await act(async () => {
        await controller.fetchNextTrack();
      });

      expect(events[0]).toBe('coordinator.play:99');
      expect(events).toContain('authFetch:/api/wave/feedback');
      expect(events).toContain('authFetch:/api/tracks/99/history');
      expect(events.indexOf('coordinator.play:99')).toBeLessThan(
        events.indexOf('authFetch:/api/wave/feedback'),
      );
      expect(events.indexOf('coordinator.play:99')).toBeLessThan(
        events.indexOf('authFetch:/api/tracks/99/history'),
      );
    });

    test('history dedup incorporates user and resets when user changes via addAuthListener', async () => {
      const track = { id: 101, title: 'User Track' };

      await act(async () => {
        controller.playTrack(track);
      });

      const callsUser1 = authFetch.mock.calls.filter((c) =>
        c[0].includes('/api/tracks/101/history'),
      );
      expect(callsUser1.length).toBe(1);

      // Replay in same user session is deduplicated
      await act(async () => {
        controller.playTrack(track);
      });
      expect(
        authFetch.mock.calls.filter((c) =>
          c[0].includes('/api/tracks/101/history'),
        ).length,
      ).toBe(1);

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
      expect(
        authFetch.mock.calls.filter((c) =>
          c[0].includes('/api/tracks/101/history'),
        ).length,
      ).toBe(2);
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
        }),
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
        expect.stringContaining(
          '[usePlayerController] Background event failed (/api/wave/feedback):',
        ),
        expect.any(String),
      );

      // Now network recovers: mock authFetch succeeds
      authFetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      }));

      // Notify good network status to coordinator listeners
      await act(async () => {
        for (const listener of mockCoordinatorListeners) {
          listener({ networkStatus: 'good' });
        }
      });

      // Flushed retry succeeded
      const retriedFeedbackCalls = authFetch.mock.calls.filter((c) =>
        c[0].includes('/api/wave/feedback'),
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
          return new Promise((resolve) => {
            resolveRetry = resolve;
          });
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
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: 'Bad Request' }),
          };
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
        controller.playTrack({ id: 'wave-start', title: 'Wave Start' });
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
