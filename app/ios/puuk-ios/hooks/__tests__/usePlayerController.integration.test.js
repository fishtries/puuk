import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import usePlayerController from '../usePlayerController';
import { PlaybackCoordinator } from '../../utils/playbackCoordinator';
import {
  getAuthHeaders,
  getCachedAuthHeaders,
  authFetch,
} from '../../shared/api/api';
import { recordPlayStart } from '../../shared/api/artists';

let mockCoordinator;
let mockPlayer;
let mockStatus;
jest.mock('../playbackStatus', () => ({
  usePlaybackState: () => mockStatus,
  getPlaybackSnapshot: () => mockStatus,
}));
const mockAuthListeners = new Set();
jest.mock('../../utils/playbackCoordinator', () => {
  const actual = jest.requireActual('../../utils/playbackCoordinator');
  return {
    __esModule: true,
    ...actual,
    default: new Proxy(
      {},
      {
        get: (_, key) => {
          const value = mockCoordinator[key];
          return typeof value === 'function'
            ? value.bind(mockCoordinator)
            : value;
        },
      },
    ),
  };
});
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => mockPlayer,
  setAudioModeAsync: jest.fn().mockResolvedValue(),
}));
jest.mock('../../shared/api/api', () => ({
  SERVER_URL: 'https://puuk.app',
  authFetch: jest.fn(),
  getAuthHeaders: jest.fn(),
  getCachedAuthHeaders: jest.fn(),
  getCachedAuthToken: () => null,
  getCachedUser: () => ({ id: 1 }),
  getSavedUser: () => Promise.resolve({ id: 1 }),
  addAuthListener: (cb) => {
    mockAuthListeners.add(cb);
    return () => mockAuthListeners.delete(cb);
  },
  isRetryableStatus: (status) => status >= 500,
  isNetworkError: () => false,
  ApiError: class extends Error {},
}));
jest.mock('../../shared/api/artists', () => ({
  recordPlayStart: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../shared/media/CoverImage', () => ({
  resolveCoverUri: (uri) => uri,
  prefetchCover: jest.fn(),
}));

// Native contract model: install/play/seek reject obsolete source or revision;
// successful commands are acceptance only, readiness/progress are separate events.
function nativePlayer() {
  const listeners = new Map();
  const p = {
    puukSourceIdentityVersion: 1,
    attempt: null,
    revision: 0,
    intent: 'pause',
    position: 0,
    addListener: jest.fn((name, callback) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
      return { remove: () => listeners.get(name).delete(callback) };
    }),
    event(patch = {}) {
      return {
        sourceIdentityVersion: 1,
        sourceAttemptId: p.attempt,
        intentRevision: p.revision,
        nativeIntent: p.intent,
        nativeEvent: 'snapshot',
        isLoaded: true,
        playing: p.intent === 'play',
        currentTime: p.position,
        duration: 100,
        ...patch,
      };
    },
    emit(patch = {}, name = 'playbackStatusUpdate') {
      const event = p.event(patch);
      for (const listener of listeners.get(name) || []) listener(event);
      return event;
    },
    replaceWithAttempt: jest.fn((source, attempt, revision, expected) => {
      if (
        revision !== null &&
        (expected !== p.attempt ||
          revision !== p.revision ||
          p.intent !== 'play')
      )
        return false;
      p.attempt = attempt;
      p.position = 0;
      p.onInstall?.();
      return true;
    }),
    playForAttempt: jest.fn((attempt, revision) => {
      if (
        attempt !== p.attempt ||
        (revision !== null && (revision !== p.revision || p.intent !== 'play'))
      )
        return false;
      p.intent = 'play';
      p.revision += 1;
      p.emit({ nativeEvent: 'intent' });
      return true;
    }),
    seekForAttempt: jest.fn((attempt, target, revision) => {
      if (
        attempt !== p.attempt ||
        (revision !== null && revision !== p.revision)
      )
        return false;
      if (revision === null) p.revision += 1;
      const seekOrigin = revision === null ? 'user' : 'recovery';
      p.emit({
        nativeEvent: 'seekIntent',
        seekTargetSeconds: target,
        seekOrigin,
      });
      p.position = target;
      if (p.ackSeek)
        p.emit({
          nativeEvent: 'seek',
          seekTargetSeconds: target,
          seekOrigin,
          seekCompleted: true,
        });
      return true;
    }),
    ackSeek: true,
    pause: jest.fn(() => {
      p.intent = 'pause';
      p.revision += 1;
      p.emit({ nativeEvent: 'intent' });
    }),
    play: jest.fn(() => {
      p.intent = 'play';
    }),
    replace: jest.fn(),
    seekTo: jest.fn(),
    setActiveForLockScreen: jest.fn(),
  };
  return p;
}

const track = (id) => ({
  id,
  title: id,
  duration: 100,
  loudness_status: 'analyzed',
});
const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};
describe('usePlayerController with accepted real coordinator', () => {
  let controller, renderer, scheduler, cache;
  function Harness() {
    controller = usePlayerController({ setTracks: () => {} });
    return null;
  }
  async function select(id = 'A') {
    await act(async () => {
      controller.playTrack(track(id));
      await flush();
    });
  }
  async function progress(position = 1) {
    await act(async () => {
      mockPlayer.position = position;
      mockPlayer.emit({ nativeEvent: 'progress' });
      await flush();
    });
  }
  async function advance(ms) {
    await act(async () => {
      jest.advanceTimersByTime(ms);
      await flush();
    });
  }
  async function retryReady() {
    await act(async () => {
      mockPlayer.emit({ nativeEvent: 'loaded' });
      await flush();
    });
  }
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockAuthListeners.clear();
    getAuthHeaders.mockResolvedValue({ Authorization: 'Bearer synthetic' });
    getCachedAuthHeaders.mockReturnValue({ Authorization: 'Bearer synthetic' });
    authFetch.mockResolvedValue({ ok: true, json: async () => [] });
    mockStatus = {
      playing: false,
      currentTime: 0,
      duration: 100,
      didJustFinish: false,
    };
    mockPlayer = nativePlayer();
    scheduler = {
      addListener: () => () => {},
      syncQueue: jest.fn(),
      getStatus: () => 'idle',
      getError: () => null,
      setPlaybackPressure: jest.fn(),
      cancelAll: jest.fn(),
    };
    cache = {
      getCachedUri: () => null,
      setProtectedTrackIds: jest.fn(),
      invalidate: jest.fn().mockResolvedValue(true),
    };
    mockCoordinator = new PlaybackCoordinator({
      cache,
      scheduler,
      serverUrl: 'https://puuk.app',
      clock: () => Date.now(),
      preloadNative: jest.fn(),
    });
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
      await flush();
    });
  });
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    mockCoordinator.destroy();
    jest.useRealTimers();
  });

  test('subscription precedes commands; pending, snapshot and loaded are not start, real progress starts once', async () => {
    mockPlayer.onInstall = () => {
      expect(mockPlayer.addListener.mock.calls[0][0]).toBe(
        'playbackStatusUpdate',
      );
      mockPlayer.emit({ nativeEvent: 'loaded' });
    };
    await select();
    expect(controller.currentPlayback.status).toBe('starting');
    expect(recordPlayStart).not.toHaveBeenCalled();
    await act(async () => {
      mockPlayer.emit({ nativeEvent: 'snapshot', currentTime: 30 });
    });
    expect(recordPlayStart).not.toHaveBeenCalled();
    await progress(1);
    await progress(2);
    expect(recordPlayStart).toHaveBeenCalledTimes(1);
    expect(recordPlayStart).toHaveBeenCalledWith('A', { retry: 1 });
  });

  test.each(['before command resolves', 'after command resolves'])(
    'one-event native error %s survives React snapshot overwrite with recovery or safe terminal outcome',
    async (when) => {
      if (when === 'before command resolves')
        mockPlayer.onInstall = () =>
          mockPlayer.emit({ nativeEvent: 'error', error: 'broken' });
      await select();
      mockPlayer.onInstall = null;
      if (when === 'after command resolves')
        await act(async () => {
          mockPlayer.emit({ nativeEvent: 'error', error: 'broken' });
          mockPlayer.emit({ nativeEvent: 'snapshot', error: undefined });
        });
      expect(controller.currentPlayback.status).toBe('recovering');
      const initialPlayCalls = mockPlayer.playForAttempt.mock.calls.length;
      await advance(800);
      expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(2);
      if (when === 'before command resolves') {
        expect(controller.currentPlayback.status).toBe('error');
        expect(controller.currentPlayback.error.kind).toBe('playback');
        expect(mockPlayer.playForAttempt).not.toHaveBeenCalled();
        // Explicit Retry prepares a healthy paused source; explicit Play then
        // grants fresh native intent without weakening an automatic guard.
        let pending;
        await act(async () => {
          pending = controller.retryCurrent();
          await flush();
        });
        await retryReady();
        await act(async () => {
          await pending;
        });
        expect(controller.currentPlayback.status).toBe('paused');
        await act(async () => controller.togglePlayPause());
      } else {
        await retryReady();
        expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(
          initialPlayCalls + 1,
        );
      }
      expect(mockPlayer.playForAttempt.mock.results.at(-1).value).toBe(true);
      expect(mockPlayer.intent).toBe('play');
      expect(recordPlayStart).not.toHaveBeenCalled();
    },
  );

  test('current Retry replaces source, joins double taps, waits loaded/true seek ack, preserves logical history/start', async () => {
    await select();
    await progress(4);
    const request = controller.currentPlayback.requestId;
    const oldAttempt = mockPlayer.attempt;
    const histories = () =>
      authFetch.mock.calls.filter(([url]) => url.endsWith('/history'));
    expect(histories()).toHaveLength(1);
    mockPlayer.ackSeek = false;
    let one, two;
    await act(async () => {
      one = controller.retryCurrent();
      two = controller.retryCurrent();
      await flush();
    });
    expect(one).toBe(two);
    expect(mockPlayer.attempt).not.toBe(oldAttempt);
    expect(getAuthHeaders).toHaveBeenCalled();
    expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(1);
    await retryReady();
    expect(mockPlayer.seekForAttempt).toHaveBeenLastCalledWith(
      mockPlayer.attempt,
      4,
      expect.any(Number),
    );
    expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(1);
    await act(async () => {
      mockPlayer.emit({
        nativeEvent: 'seek',
        seekOrigin: 'recovery',
        seekCompleted: false,
      });
      await flush();
    });
    expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(1);
    // Failed restore is terminal; a second explicit Retry gets a fresh episode.
    await act(async () => {
      await one;
    });
    expect(controller.currentPlayback.status).toBe('error');
    mockPlayer.ackSeek = true;
    let retry;
    await act(async () => {
      retry = controller.retryCurrent();
      await flush();
    });
    await retryReady();
    await act(async () => {
      await retry;
    });
    expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(2);
    expect(controller.currentPlayback.requestId).toBe(request);
    await progress(5);
    expect(recordPlayStart).toHaveBeenCalledTimes(1);
    expect(histories()).toHaveLength(1);
  });

  test.each([
    'pause',
    'seek',
    'dismiss',
    'logout',
    'auth-change',
    'unmount',
    'track',
  ])('%s cancels pending retry headers and old callbacks', async (action) => {
    await select();
    await progress(3);
    let headers;
    getAuthHeaders.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          headers = resolve;
        }),
    );
    let retry;
    await act(async () => {
      retry = controller.retryCurrent();
      await flush();
    });
    const old = mockPlayer.event({
      nativeEvent: 'finish',
      didJustFinish: true,
    });
    await act(async () => {
      if (action === 'pause') controller.togglePlayPause();
      if (action === 'seek') controller.seekTo(17);
      if (action === 'dismiss') await controller.dismissPlayer();
      if (action === 'logout' || action === 'auth-change')
        for (const cb of mockAuthListeners)
          cb(action === 'logout' ? null : { id: 2 });
      if (action === 'track') controller.playTrack(track('B'));
      if (action === 'unmount') {
        renderer.unmount();
        renderer = null;
      }
      await flush();
    });
    const replacements = mockPlayer.replaceWithAttempt.mock.calls.length;
    const plays = mockPlayer.playForAttempt.mock.calls.length;
    await act(async () => {
      headers({ Authorization: 'Bearer late' });
      await retry;
      await flush();
    });
    await advance(35000);
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(replacements);
    expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(plays);
    if (action !== 'pause' && action !== 'seek') {
      await act(async () => {
        mockPlayer.emit(old);
        await flush();
      });
      expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(replacements);
    }
  });

  test('pause during scheduled recovery and same-turn double toggle retain latest intent', async () => {
    await select();
    await act(async () => {
      mockPlayer.emit({ nativeEvent: 'error', error: 'broken' });
      controller.togglePlayPause();
    });
    await advance(1000);
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1);
    expect(mockPlayer.intent).toBe('pause');
    await act(async () => {
      controller.togglePlayPause();
      controller.togglePlayPause();
    });
    expect(mockPlayer.intent).toBe('pause');
  });

  test('A/B/A and same-track explicit selections have distinct IDs; obsolete/missing status and skip are inert', async () => {
    await select();
    const a = mockPlayer.event({ nativeEvent: 'finish', didJustFinish: true });
    const first = controller.currentPlayback.requestId;
    await select('B');
    await select();
    const third = controller.currentPlayback.requestId;
    expect(third).not.toBe(first);
    await select();
    expect(controller.currentPlayback.requestId).not.toBe(third);
    const installs = mockPlayer.replaceWithAttempt.mock.calls.length;
    await act(async () => {
      mockPlayer.emit(a);
      mockPlayer.emit({
        nativeEvent: 'error',
        sourceAttemptId: null,
        error: 'broken',
      });
      mockPlayer.emit(a, 'nextTrack');
      mockPlayer.emit({ sourceAttemptId: null }, 'previousTrack');
    });
    await advance(1000);
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(installs);
    expect(controller.currentTrack.id).toBe('A');
  });

  test('accepted finish advances exactly once even with duplicate events and React didJustFinish', async () => {
    await act(async () => {
      controller.playTrackList([track('A'), track('B'), track('C')]);
      await flush();
    });
    const finish = mockPlayer.event({
      nativeEvent: 'finish',
      didJustFinish: true,
      currentTime: 100,
    });
    mockStatus.didJustFinish = true;
    await act(async () => {
      mockPlayer.emit(finish);
      mockPlayer.emit(finish);
      await flush();
    });
    expect(controller.currentTrack.id).toBe('B');
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(2);
    expect(controller.upNextQueue.map((t) => t.id)).toEqual(['C']);
  });

  test('next-only Retry forces queue sync, joins taps and cannot replace current or clear current error', async () => {
    await act(async () => {
      controller.playTrackList([track('A'), track('B')]);
      await flush();
    });
    await act(async () => {
      mockPlayer.emit({ nativeEvent: 'error', error: { statusCode: 404 } });
    });
    expect(controller.currentPlayback.error.kind).toBe('not_found');
    let one, two;
    await act(async () => {
      one = controller.retryPreload();
      two = controller.retryPreload();
      await one;
    });
    expect(one).toBe(two);
    expect(scheduler.syncQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'A' }),
      [expect.objectContaining({ id: 'B' })],
      expect.objectContaining({ force: true }),
    );
    expect(controller.currentPlayback.error.kind).toBe('not_found');
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1);
  });

  test('missing guarded capability uses legacy completion and remote controls, with no attributed recovery', async () => {
    delete mockPlayer.seekForAttempt;
    await select();
    expect(controller.identityAvailable).toBe(false);
    await act(async () => {
      mockPlayer.emit({}, 'previousTrack');
    });
    expect(mockPlayer.seekTo).toHaveBeenCalledWith(0);
    await act(async () => {
      mockPlayer.emit({ nativeEvent: 'error', error: 'broken' });
    });
    await advance(35000);
    expect(mockPlayer.replaceWithAttempt).not.toHaveBeenCalled();
    expect(mockPlayer.replace).toHaveBeenCalledTimes(1);
    mockStatus.didJustFinish = true;
    await act(async () => {
      controller.setCurrentTrack({ ...controller.currentTrack });
      await flush();
    });
    expect(mockPlayer.pause).toHaveBeenCalled();
  });

  test.each([false, true])(
    'manual zero-position Retry restores loaded/seek ack and retains paused=%s',
    async (paused) => {
      await select();
      if (paused) await act(async () => controller.togglePlayPause());
      let pending;
      await act(async () => {
        pending = controller.retryCurrent();
        await flush();
      });
      expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(1);
      await retryReady();
      await act(async () => {
        await pending;
      });
      expect(mockPlayer.seekForAttempt).toHaveBeenLastCalledWith(
        mockPlayer.attempt,
        0,
        expect.any(Number),
      );
      expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(paused ? 1 : 2);
      expect(mockPlayer.intent).toBe(paused ? 'pause' : 'play');
    },
  );

  test('native pause cancels recovery and stale play/progress cannot undo it', async () => {
    await select();
    await act(async () => {
      mockPlayer.emit({ nativeEvent: 'error', error: 'broken' });
      const queued = mockPlayer.event({
        nativeEvent: 'progress',
        currentTime: 1,
      });
      mockPlayer.pause();
      mockPlayer.emit(queued);
    });
    await advance(35000);
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1);
    expect(controller.currentPlayback.intent).toBe('pause');
    expect(recordPlayStart).not.toHaveBeenCalled();
  });

  test('unstructured unauthorized text is generic and never changes auth owner', async () => {
    await select();
    await act(async () =>
      mockPlayer.emit({
        nativeEvent: 'error',
        error: 'unauthorized credential=privatevalue',
      }),
    );
    await advance(800);
    await retryReady();
    await act(async () =>
      mockPlayer.emit({
        nativeEvent: 'error',
        error: 'unauthorized credential=privatevalue',
      }),
    );
    expect(controller.currentPlayback.error.kind).toBe('playback');
    expect(controller.currentTrack.id).toBe('A');
    expect(mockAuthListeners.size).toBe(1);
  });

  test('minimizing keeps playback; dismiss makes captured native callbacks inert', async () => {
    await select();
    const listener = mockPlayer.addListener.mock.calls.find(
      ([name]) => name === 'playbackStatusUpdate',
    )[1];
    const finish = mockPlayer.event({
      nativeEvent: 'finish',
      didJustFinish: true,
    });
    const pauses = mockPlayer.pause.mock.calls.length;
    await act(async () => controller.setIsPlayerVisible(false));
    expect(mockPlayer.pause).toHaveBeenCalledTimes(pauses);
    await act(async () => controller.dismissPlayer());
    await act(async () => {
      listener(finish);
      listener(mockPlayer.event({ nativeEvent: 'error', error: 'broken' }));
    });
    await advance(35000);
    expect(controller.currentTrack).toBeNull();
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1);
  });

  test('pause while collection tail awaits recommendations prevents delayed autoplay', async () => {
    await act(async () => {
      controller.playTrackList([track('A')]);
      await flush();
    });
    let response;
    authFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          response = resolve;
        }),
    );
    let next;
    await act(async () => {
      next = controller.fetchNextTrack();
      await flush();
    });
    await act(async () => controller.togglePlayPause());
    await act(async () => {
      response({ ok: true, json: async () => [track('B')] });
      await next;
    });
    expect(controller.currentTrack.id).toBe('A');
    expect(mockPlayer.intent).toBe('pause');
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(1);
  });

  test('direct accepted completion reports original finish position and duration', async () => {
    await act(async () => {
      controller.playTrackList([track('A'), track('B')]);
      await flush();
    });
    await act(async () => {
      mockPlayer.emit({
        nativeEvent: 'finish',
        didJustFinish: true,
        currentTime: 99,
        duration: 100,
      });
      await flush();
    });
    const feedback = authFetch.mock.calls.find(
      ([url]) => url === '/api/wave/feedback',
    );
    expect(feedback[1].body).toEqual(
      expect.objectContaining({
        event_type: 'finish',
        listen_duration_ms: 99000,
      }),
    );
  });

  test('same-turn list selection and native finish read the newly selected queue before React renders', async () => {
    await act(async () => {
      controller.playTrackList([track('A'), track('B'), track('C')]);
      mockPlayer.intent = 'play';
      mockPlayer.emit({ nativeEvent: 'finish', didJustFinish: true });
      await flush();
    });
    expect(controller.currentTrack.id).toBe('B');
    expect(controller.upNextQueue.map((t) => t.id)).toEqual(['C']);
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(2);
  });

  test('previous-to-zero and terminal queue pause route through coordinator intents', async () => {
    await select();
    await progress(5);
    await act(async () => controller.playPreviousTrack());
    expect(mockPlayer.seekForAttempt).toHaveBeenLastCalledWith(
      mockPlayer.attempt,
      0,
      null,
    );
    await act(async () => {
      mockPlayer.emit({ nativeEvent: 'finish', didJustFinish: true });
      await flush();
    });
    expect(controller.currentPlayback.intent).toBe('pause');
    expect(mockPlayer.intent).toBe('pause');
  });

  test('obsolete next-only retry headers cannot sync a new selection or user', async () => {
    await select();
    let headers;
    getAuthHeaders.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          headers = resolve;
        }),
    );
    let pending;
    await act(async () => {
      pending = controller.retryPreload();
    });
    await select('B');
    scheduler.syncQueue.mockClear();
    await act(async () => {
      headers({ Authorization: 'Bearer late' });
      await pending;
    });
    expect(scheduler.syncQueue).not.toHaveBeenCalled();
    expect(controller.currentTrack.id).toBe('B');
  });

  test('queued native error after command microtasks is delivered despite a later presentation snapshot', async () => {
    const play = mockPlayer.playForAttempt.getMockImplementation();
    mockPlayer.playForAttempt.mockImplementationOnce((...args) => {
      const accepted = play(...args);
      const event = mockPlayer.event({
        nativeEvent: 'error',
        error: 'queued item failure',
      });
      setTimeout(() => {
        mockPlayer.emit(event);
        mockPlayer.emit({ nativeEvent: 'snapshot', error: undefined });
      }, 0);
      return accepted;
    });
    await select();
    expect(controller.currentPlayback.status).toBe('starting');
    await advance(0);
    expect(controller.currentPlayback.status).toBe('recovering');
    await advance(800);
    await retryReady();
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(2);
    expect(mockPlayer.playForAttempt.mock.results.at(-1).value).toBe(true);
    expect(recordPlayStart).not.toHaveBeenCalled();
  });

  test('captured user selection callbacks cannot restart playback after owner unmount', async () => {
    await select();
    const stale = controller;
    await act(async () => {
      renderer.unmount();
      renderer = null;
    });
    const calls = mockPlayer.replaceWithAttempt.mock.calls.length;
    authFetch.mockClear();
    await act(async () => {
      stale.playTrack(track('B'));
      stale.playTrackList([track('C')]);
      await stale.startWave();
      stale.togglePlayPause();
      stale.seekTo(9);
      await stale.retryCurrent();
      await stale.retryPreload();
    });
    expect(mockPlayer.replaceWithAttempt).toHaveBeenCalledTimes(calls);
    expect(authFetch).not.toHaveBeenCalled();
  });

  test('immutable installation error delivered FIFO after play admission drives real bounded recovery', async () => {
    const queued = [];
    const deliver = mockPlayer.emit;
    mockPlayer.emit = (patch = {}, name = 'playbackStatusUpdate') => {
      const event = mockPlayer.event(patch);
      queued.push([event, name]);
      return event;
    };
    mockPlayer.onInstall = () =>
      mockPlayer.emit({
        nativeEvent: 'error',
        error: 'queued installation failure',
      });
    await select();
    mockPlayer.onInstall = null;
    const sourceEvents = queued.filter(
      ([event]) => event.sourceAttemptId === mockPlayer.attempt,
    );
    expect(sourceEvents[0][0]).toEqual(
      expect.objectContaining({ nativeEvent: 'error', nativeIntent: 'pause' }),
    );
    expect(sourceEvents[1][0]).toEqual(
      expect.objectContaining({ nativeEvent: 'intent', nativeIntent: 'play' }),
    );
    expect(sourceEvents[0][0].intentRevision).toBeLessThan(
      sourceEvents[1][0].intentRevision,
    );
    mockPlayer.emit = deliver;
    await act(async () => {
      for (const [event, name] of queued) deliver(event, name);
      await flush();
    });
    expect(controller.currentPlayback.status).toBe('recovering');
    await advance(800);
    expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(1);
    await retryReady();
    expect(mockPlayer.seekForAttempt).toHaveBeenLastCalledWith(
      mockPlayer.attempt,
      0,
      expect.any(Number),
    );
    expect(mockPlayer.playForAttempt).toHaveBeenCalledTimes(2);
    expect(recordPlayStart).not.toHaveBeenCalled();
    expect(
      authFetch.mock.calls.filter(([url]) => url.endsWith('/history')),
    ).toHaveLength(1);
    await progress(1);
    expect(recordPlayStart).toHaveBeenCalledTimes(1);
  });
});
