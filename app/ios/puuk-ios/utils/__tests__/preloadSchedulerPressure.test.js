import {
  PreloadScheduler,
  TRACK_STATUS,
  PLAYBACK_PHASE,
} from '../preloadScheduler';

let mockNetworkPolicy = { type: 'wifi', maxConcurrent: 2, lookahead: 2 };

jest.mock('../networkPolicy', () => ({
  getCurrentNetworkPolicy: jest.fn(() => mockNetworkPolicy),
  isPolicyOnline: jest.fn((policy) => !policy || policy.isConnected !== false),
  SAFE_NETWORK_POLICY: { type: 'unknown', maxConcurrent: 1, lookahead: 1 },
  subscribeNetworkPolicy: jest.fn(() => () => {}),
}));

function abortError() {
  const error = new Error('Download cancelled');
  error.name = 'AbortError';
  return error;
}

function createMockCache() {
  const activeFetches = new Map();
  const cache = {
    cachedIds: new Set(),
    isCached: jest.fn((id) => cache.cachedIds.has(String(id))),
    getCachedUri: jest.fn((id) =>
      cache.cachedIds.has(String(id)) ? `file:///mock/${id}.audio` : null,
    ),
    cancel: jest.fn((id) => {
      const fetch = activeFetches.get(String(id));
      if (fetch) {
        fetch.cancelled = true;
        activeFetches.delete(String(id));
        fetch.reject(abortError());
      }
    }),
    getDownloadState: jest.fn((id) => {
      const idStr = String(id);
      if (cache.cachedIds.has(idStr)) {
        return { status: 'cached', uri: `file:///mock/${idStr}.audio` };
      }
      const fetch = activeFetches.get(idStr);
      if (fetch && !fetch.cancelled) {
        return { status: 'downloading', promise: fetch.promise };
      }
      return { status: 'idle' };
    }),
    isDownloading: jest.fn((id) => {
      const fetch = activeFetches.get(String(id));
      return Boolean(fetch && !fetch.cancelled);
    }),
    getOngoingPromise: jest.fn((id) => {
      const fetch = activeFetches.get(String(id));
      return fetch && !fetch.cancelled ? fetch.promise : null;
    }),
    getOrFetch: jest.fn((id, url, opts) => {
      const idStr = String(id);
      if (cache.cachedIds.has(idStr)) {
        return Promise.resolve(`file:///mock/${idStr}.audio`);
      }
      let resolveFn, rejectFn;
      const promise = new Promise((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      promise.catch(() => {});
      activeFetches.set(idStr, {
        resolve: () => {
          cache.cachedIds.add(idStr);
          activeFetches.delete(idStr);
          resolveFn(`file:///mock/${idStr}.audio`);
        },
        reject: (err) => {
          activeFetches.delete(idStr);
          rejectFn(err);
        },
        cancelled: false,
        promise,
      });
      return promise;
    }),
  };
  return { cache, activeFetches };
}

describe('PreloadScheduler playback pressure contract', () => {
  let mockCache;
  let activeFetches;
  let scheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    mockNetworkPolicy = { type: 'wifi', maxConcurrent: 2, lookahead: 2 };
    ({ cache: mockCache, activeFetches } = createMockCache());
    scheduler = new PreloadScheduler({
      maxConcurrent: 2,
      lookahead: 2,
      cache: mockCache,
    });
  });

  afterEach(() => {
    scheduler?.destroy();
    jest.useRealTimers();
  });

  describe('setPlaybackPressure', () => {
    test('startup edge cancels active background jobs once and repeated ticks do not restart', async () => {
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.DOWNLOADING);
      const cancelCalls = mockCache.cancel.mock.calls.length;

      scheduler.setPlaybackPressure({ requestId: 'req-1', phase: 'startup' });
      expect(mockCache.cancel).toHaveBeenCalledWith('20');
      expect(mockCache.cancel).toHaveBeenCalledWith('30');
      expect(mockCache.cancel.mock.calls.length).toBe(cancelCalls + 2);
      expect(scheduler.activeTasks.size).toBe(0);
      expect(scheduler.queue).toHaveLength(0);

      // Repeated ticks of the same edge do nothing.
      scheduler.setPlaybackPressure({ requestId: 'req-1', phase: 'startup' });
      scheduler.setPlaybackPressure({ requestId: 'req-1', phase: 'startup' });
      expect(mockCache.cancel.mock.calls.length).toBe(cancelCalls + 2);

      // No new speculative work starts while pressure persists.
      scheduler.syncQueue({ id: 10 }, [{ id: 40 }, { id: 50 }]);
      scheduler.preloadImmediate({ id: 60 }).catch(() => {});
      expect(mockCache.getOrFetch).not.toHaveBeenCalledWith(
        '40',
        expect.anything(),
        expect.anything(),
      );
      expect(scheduler.activeTasks.size).toBe(0);
      expect(scheduler.getStatus(40)).toBe(TRACK_STATUS.QUEUED);
    });

    test('stalled/recovering/suspended edges each cancel active work exactly once', async () => {
      for (const phase of ['stalled', 'recovering', 'suspended']) {
        scheduler.setPlaybackPressure(null);
        scheduler.syncQueue({ id: 10 }, [{ id: 20 }]);
        expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
        const before = mockCache.cancel.mock.calls.length;

        scheduler.setPlaybackPressure({ requestId: `r-${phase}`, phase });
        expect(mockCache.cancel.mock.calls.length).toBe(before + 1);

        // Idempotent: repeated tick does not cancel again
        scheduler.setPlaybackPressure({ requestId: `r-${phase}`, phase });
        expect(mockCache.cancel.mock.calls.length).toBe(before + 1);

        await Promise.resolve();
      }
    });

    test('a repeated identical edge is idempotent; a new requestId re-applies the cancellation rule', () => {
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }]);
      scheduler.setPlaybackPressure({ requestId: 'a', phase: 'startup' });
      const afterFirst = mockCache.cancel.mock.calls.length;
      expect(afterFirst).toBe(1);

      scheduler.setPlaybackPressure({ requestId: 'a', phase: 'startup' });
      expect(mockCache.cancel.mock.calls.length).toBe(afterFirst);

      scheduler.syncQueue({ id: 10 }, [{ id: 30 }]);
      expect(scheduler.activeTasks.size).toBe(0);

      scheduler.setPlaybackPressure({ requestId: 'a', phase: 'startup' });
      expect(scheduler.activeTasks.size).toBe(0);
      expect(mockCache.cancel.mock.calls.length).toBe(afterFirst);
    });

    test('idle after cancellation leaves no retained jobs and starts nothing', () => {
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }]);
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'startup' });
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'idle' });
      expect(scheduler.queue).toHaveLength(0);
      expect(scheduler.activeTasks.size).toBe(0);
      jest.advanceTimersByTime(10000);
      expect(scheduler.activeTasks.size).toBe(0);
    });

    test('null pressure then syncQueue behaves like the existing baseline', () => {
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }]);
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
    });
  });

  describe('slot occupancy and cancellation accounting', () => {
    test('cancelled task holds slot until underlying cache promise settles; urgent queue waits', async () => {
      const { cache, activeFetches: fetches } = createMockCache();
      const s = new PreloadScheduler({
        maxConcurrent: 1,
        lookahead: 2,
        cache,
      });

      // Track 20 starts downloading (takes the 1 available slot)
      s.syncQueue({ id: 10 }, [{ id: 20 }]);
      expect(s.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(s.activeTasks.size).toBe(1);

      // Custom cancel without immediate promise settlement to simulate slow async teardown
      let cancelPromiseReject;
      const fetch20 = fetches.get('20');
      cache.cancel = jest.fn(() => {
        // Real task teardown takes time; not settled synchronously!
      });

      // Stale sync cancels track 20 immediately
      s.syncQueue({ id: 10 }, [], { force: true });
      expect(cache.cancel).toHaveBeenCalledWith('20');
      expect(s.getStatus(20)).toBe(TRACK_STATUS.CANCELLED);
      // Active tasks map is cleared, but occupied slots still counts the unsettled task
      expect(s.activeTasks.size).toBe(0);
      expect(s._occupiedSlots()).toBe(1);

      // Urgent preload requested while slot is held
      const urgentPromise = s.preloadImmediate({ id: 77 });
      urgentPromise.catch(() => {});
      // Urgent job cannot exceed active cap: stays QUEUED until slot settles!
      expect(s.getStatus(77)).toBe(TRACK_STATUS.QUEUED);
      expect(s.activeTasks.size).toBe(0);

      // Now the underlying cache promise settles
      fetch20.reject(abortError());
      await Promise.resolve();
      await Promise.resolve();

      // Slot is freed and urgent job starts downloading immediately
      expect(s._occupiedSlots()).toBe(1);
      expect(s.activeTasks.size).toBe(1);
      expect(s.getStatus(77)).toBe(TRACK_STATUS.DOWNLOADING);

      fetches.get('77').resolve();
      await urgentPromise;
      expect(s.getStatus(77)).toBe(TRACK_STATUS.READY);
      s.destroy();
    });

    test('pressure -> stable: urgent/new queue waits if old cancellation is still settling', async () => {
      let resolveTeardown;
      const teardownPromise = new Promise((res) => {
        resolveTeardown = res;
      });

      scheduler.syncQueue({ id: 10 }, [{ id: 20 }]);
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

      const fetch20 = activeFetches.get('20');
      mockCache.cancel = jest.fn(() => {
        // Teardown delayed until resolveTeardown
        teardownPromise.then(() => {
          fetch20.reject(abortError());
        });
      });

      // Pressure edge cancels active work
      scheduler.setPlaybackPressure({ requestId: 'r1', phase: 'startup' });
      expect(scheduler.activeTasks.size).toBe(0);
      expect(scheduler._occupiedSlots()).toBe(1);

      // Stable edge arrives, but old teardown has not settled yet
      scheduler.syncQueue({ id: 10 }, [{ id: 99 }]);
      scheduler.setPlaybackPressure({ requestId: 'r1', phase: 'stable' });

      // Ramp allows at most 1 slot; since 1 slot is occupied by settling task, job 99 stays queued!
      expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.QUEUED);
      expect(scheduler.activeTasks.size).toBe(0);

      // Teardown completes
      resolveTeardown();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Now job 99 starts downloading in the freed slot
      expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(scheduler.activeTasks.size).toBe(1);
    });

    test('urgent preemption with deferred concrete cache promise holds slot until settlement', async () => {
      const { cache, activeFetches: fetches } = createMockCache();
      const s = new PreloadScheduler({
        maxConcurrent: 1,
        lookahead: 2,
        cache,
      });

      s.syncQueue({ id: 10 }, [{ id: 20 }]);
      expect(s.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      const activeTask20 = s.activeTasks.get('20');
      const originalPromise20 = activeTask20.promise;

      // Defer concrete cache cancellation promise
      const fetch20 = fetches.get('20');
      cache.cancel = jest.fn(() => {});

      // Urgent task arrives
      const urgentPromise = s.preloadImmediate({ id: 99 });
      urgentPromise.catch(() => {});

      expect(cache.cancel).toHaveBeenCalledWith('20');
      expect(s.getStatus(20)).toBe(TRACK_STATUS.QUEUED);
      // Urgent task 99 cannot take the slot while task 20 is still settling!
      expect(s.getStatus(99)).toBe(TRACK_STATUS.QUEUED);
      expect(s._occupiedSlots()).toBe(1);
      expect(s.activeTasks.size).toBe(0);

      // Now concrete cache cancellation promise settles
      fetch20.reject(abortError());
      await Promise.resolve();
      await Promise.resolve();

      // Urgent task 99 takes the freed slot
      expect(s.getStatus(99)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(s.activeTasks.size).toBe(1);

      fetches.get('99').resolve();
      await urgentPromise;
      expect(s.getStatus(99)).toBe(TRACK_STATUS.READY);

      // Task 20 resumes downloading as attempt 2
      expect(s.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      fetches.get('20').resolve();
      const uri20 = await originalPromise20;
      expect(uri20).toBe('file:///mock/20.audio');
      expect(s.getStatus(20)).toBe(TRACK_STATUS.READY);
      s.destroy();
    });

    test('rapid urgent requests under pressure bound queue to MAX_DESIRED_JOBS and reject obsolete requests with AbortError', async () => {
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'startup' });
      const errors = [];
      const promises = [];
      for (let id = 1; id <= 10; id += 1) {
        const p = scheduler.preloadImmediate({ id }, { currentTrackId: id });
        p.catch((err) => errors.push({ id, name: err?.name }));
        promises.push(p);
      }

      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
      // Exactly 7 older urgent requests were cancelled with AbortError
      expect(errors).toHaveLength(7);
      for (const err of errors) {
        expect(err.name).toBe('AbortError');
      }
      // Only the latest 3 desired urgent requests remain queued
      expect(scheduler.queue).toHaveLength(3);
      expect(scheduler.queue.map((q) => q.trackId)).toEqual(['10', '9', '8']);
      expect(scheduler.activeTasks.size).toBe(0);
      expect(mockCache.getOrFetch).not.toHaveBeenCalled();
    });

    test('rapid skips with active cancel-ignoring promise hold slot and bound queue until settlement', async () => {
      const { cache, activeFetches: fetches } = createMockCache();
      const s = new PreloadScheduler({
        maxConcurrent: 1,
        lookahead: 2,
        cache,
      });

      // Track 1 starts downloading
      s.syncQueue({ id: 0 }, [{ id: 1 }]);
      expect(s.getStatus(1)).toBe(TRACK_STATUS.DOWNLOADING);

      // Cancel-ignoring: cache.cancel does NOT resolve or reject fetch 1
      const fetch1 = fetches.get('1');
      cache.cancel = jest.fn(() => {});

      // User skips rapidly from track 2 to 11
      const errors = [];
      for (let id = 2; id <= 11; id += 1) {
        const p = s.preloadImmediate({ id }, { currentTrackId: id });
        p.catch((err) => errors.push({ id, name: err?.name }));
      }

      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
      // Older urgent requests 2..8 are cancelled with AbortError
      expect(errors).toHaveLength(7);
      for (const err of errors) {
        expect(err.name).toBe('AbortError');
      }
      // Queue is strictly bounded to latest 3 (11, 10, 9)
      expect(s.queue).toHaveLength(3);
      expect(s.queue.map((q) => q.trackId)).toEqual(['11', '10', '9']);

      // Track 1 is still settling, so slot is held: nothing new has started!
      expect(s._occupiedSlots()).toBe(1);
      expect(s.activeTasks.size).toBe(0);
      expect(s.getStatus(11)).toBe(TRACK_STATUS.QUEUED);

      // Track 1 finally settles on network
      fetch1.resolve('file:///mock/1.audio');
      await Promise.resolve();
      await Promise.resolve();

      // Freed slot is now taken by the latest urgent request (track 11)
      expect(s.getStatus(11)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(s.activeTasks.size).toBe(1);
      fetches.get('11').resolve();
      await Promise.resolve();
      expect(s.getStatus(11)).toBe(TRACK_STATUS.READY);
      s.destroy();
    });

    test('cancelAll holds slot until old concrete cache promise settles before new request starts', async () => {
      const { cache, activeFetches: fetches } = createMockCache();
      const s = new PreloadScheduler({
        maxConcurrent: 1,
        lookahead: 2,
        cache,
      });

      s.syncQueue({ id: 10 }, [{ id: 20 }]);
      expect(s.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

      const fetch20 = fetches.get('20');
      cache.cancel = jest.fn(() => {});

      // cancelAll called
      s.cancelAll();
      expect(cache.cancel).toHaveBeenCalledWith('20');
      expect(s.getStatus(20)).toBe(TRACK_STATUS.CANCELLED);
      expect(s._occupiedSlots()).toBe(1);

      // New request arrives before old task settles
      const newPromise = s.preloadImmediate({ id: 88 });
      newPromise.catch(() => {});

      // New request cannot start: slot still occupied by settling task 20
      expect(s.getStatus(88)).toBe(TRACK_STATUS.QUEUED);
      expect(s.activeTasks.size).toBe(0);

      // Old task settles
      fetch20.reject(abortError());
      await Promise.resolve();
      await Promise.resolve();

      // Now new request starts downloading
      expect(s.getStatus(88)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(s.activeTasks.size).toBe(1);
      fetches.get('88').resolve();
      await newPromise;
      expect(s.getStatus(88)).toBe(TRACK_STATUS.READY);
      s.destroy();
    });
  });

  describe('stable resume ramp', () => {
    test('stable edge starts one slot immediately and ramps second slot after 1000ms', async () => {
      // Clean start on Wi-Fi with 2 queued jobs
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'startup' });
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      expect(scheduler.activeTasks.size).toBe(0);

      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'stable' });
      // Exactly ONE slot starts immediately on stable edge
      expect(scheduler.activeTasks.size).toBe(1);
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);

      // Ramp is active: after 999ms, second slot is still blocked
      jest.advanceTimersByTime(999);
      expect(scheduler.activeTasks.size).toBe(1);
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);

      // At 1000ms, second slot opens and track 30 starts downloading
      jest.advanceTimersByTime(1);
      expect(scheduler.activeTasks.size).toBe(2);
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.DOWNLOADING);
    });

    test('stable ramp allows only one start before 1000ms even if first job completes early', async () => {
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'startup' });
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'stable' });

      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);

      // Job 20 resolves at 300ms (before 1s ramp ends)
      jest.advanceTimersByTime(300);
      activeFetches.get('20').resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.READY);
      // Under section 4.4 ramp rule, only one start is permitted before 1000ms;
      // job 30 stays queued until the 1000ms ramp interval elapses.
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);
      expect(scheduler.activeTasks.size).toBe(0);

      // At 1000ms, ramp ends and job 30 starts downloading
      jest.advanceTimersByTime(700);
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(scheduler.activeTasks.size).toBe(1);
    });

    test('a new pressure edge during stable invalidates the ramp without restarting work', async () => {
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'startup' });
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'stable' });
      expect(scheduler.activeTasks.size).toBe(1);

      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'stalled' });
      expect(scheduler.activeTasks.size).toBe(0);

      // Ramp timer from the old stable edge must not start anything.
      jest.advanceTimersByTime(2000);
      expect(scheduler.activeTasks.size).toBe(0);
    });
  });

  describe('cacheCurrent', () => {
    test('enters the unified priority queue (priority 0.5) and observes 5s stable eligibility', async () => {
      // Enter stable phase
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'stable' });
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }]);
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

      // cacheCurrent called for current track 10
      const p1 = scheduler.cacheCurrent({ id: 10 });
      const p2 = scheduler.cacheCurrent({ id: 10 });
      // Dedup returns same promise
      expect(p1).toBe(p2);
      // Not eligible yet: waits 5000ms after entering stable
      expect(scheduler.getStatus(10)).toBe(TRACK_STATUS.QUEUED);
      expect(mockCache.getOrFetch).not.toHaveBeenCalledWith(
        '10',
        expect.anything(),
        expect.anything(),
      );

      // After 5000ms, eligibility delay expires and current-cache starts downloading
      jest.advanceTimersByTime(5000);
      expect(scheduler.getStatus(10)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(scheduler.activeTasks.has('10')).toBe(true);

      // Both track 10 and track 20 fit in maxConcurrent 2
      expect(scheduler.activeTasks.size).toBe(2);

      activeFetches.get('10').resolve();
      activeFetches.get('20').resolve();
      await p1;
      expect(scheduler.getStatus(10)).toBe(TRACK_STATUS.READY);
    });

    test('cache hit resolves immediately without network', async () => {
      mockCache.cachedIds.add('11');
      await expect(scheduler.cacheCurrent({ id: 11 })).resolves.toBe(
        'file:///mock/11.audio',
      );
      expect(mockCache.getOrFetch).not.toHaveBeenCalled();
    });

    test('pressure aborts a pending cacheCurrent with AbortError', async () => {
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'stable' });
      const promise = scheduler.cacheCurrent({ id: 12 });
      promise.catch(() => {});
      expect(scheduler.getStatus(12)).toBe(TRACK_STATUS.QUEUED);

      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'startup' });
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(mockCache.cancel).toHaveBeenCalledWith('12');
      expect(scheduler.getStatus(12)).toBe(TRACK_STATUS.CANCELLED);
    });

    test('combined budget: cacheCurrent plus preload never exceed configured active cap', async () => {
      const { cache, activeFetches: fetches } = createMockCache();
      const budget = new PreloadScheduler({
        maxConcurrent: 2,
        lookahead: 2,
        cache,
        currentCacheDelayMs: 0,
      });

      budget.cacheCurrent({ id: 10 }).catch(() => {});
      budget.preloadImmediate({ id: 21 }).catch(() => {});
      budget.preloadImmediate({ id: 22 }).catch(() => {});
      budget.syncQueue({ id: 10 }, [{ id: 30 }, { id: 31 }]);

      // Active cap 2 is strictly enforced across current-cache and preloads combined
      expect(budget.activeTasks.size).toBeLessThanOrEqual(2);
      budget.destroy();
    });

    test('pressure cancellation prevents a scheduled cacheCurrent from starting', () => {
      scheduler.cacheCurrent({ id: 13 }).catch(() => {});
      scheduler.setPlaybackPressure({ requestId: 'r', phase: 'startup' });
      jest.advanceTimersByTime(5000);
      expect(mockCache.getOrFetch).not.toHaveBeenCalledWith(
        '13',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('network constraints', () => {
    test('unknown/cellular never expand limits and offline starts zero jobs', () => {
      mockNetworkPolicy = { type: 'cellular', maxConcurrent: 1, lookahead: 1 };
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      expect(scheduler.activeTasks.size).toBe(1);
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.IDLE);

      const { cache: offlineCache, activeFetches: offlineFetches } =
        createMockCache();
      mockNetworkPolicy = {
        type: 'wifi',
        maxConcurrent: 2,
        lookahead: 2,
        isConnected: false,
      };
      const offlineScheduler = new PreloadScheduler({
        maxConcurrent: 2,
        lookahead: 2,
        cache: offlineCache,
      });
      offlineScheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      expect(offlineFetches.size).toBe(0);
      expect(offlineScheduler.activeTasks.size).toBe(0);
      offlineScheduler.destroy();
    });

    test('reconnect pumps exactly once subject to pressure', () => {
      let notify;
      mockNetworkPolicy = { type: 'wifi', maxConcurrent: 2, lookahead: 2 };
      const reconnectScheduler = new PreloadScheduler({
        maxConcurrent: 2,
        lookahead: 2,
        cache: mockCache,
        subscribeNetworkPolicy: (cb) => {
          notify = cb;
          return () => {};
        },
      });
      reconnectScheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      const startsBefore = mockCache.getOrFetch.mock.calls.length;

      mockNetworkPolicy = {
        type: 'wifi',
        maxConcurrent: 2,
        lookahead: 2,
        isConnected: false,
      };
      notify(mockNetworkPolicy);
      reconnectScheduler.setPlaybackPressure({
        requestId: 'r',
        phase: 'startup',
      });
      const cancelCount = mockCache.cancel.mock.calls.length;
      const startsOffline = mockCache.getOrFetch.mock.calls.length;

      mockNetworkPolicy = { type: 'wifi', maxConcurrent: 2, lookahead: 2 };
      notify(mockNetworkPolicy);
      // Pressure is still active: reconnect does not start speculative work.
      expect(mockCache.getOrFetch.mock.calls.length).toBe(startsOffline);
      expect(mockCache.cancel.mock.calls.length).toBe(cancelCount);
      expect(startsBefore).toBeGreaterThan(0);
      reconnectScheduler.destroy();
    });

    test('fast skips bound obsolete tasks: no unbounded queue growth', () => {
      for (let i = 0; i < 10; i += 1) {
        scheduler.syncQueue({ id: 100 + i }, [
          { id: 200 + i },
          { id: 300 + i },
        ]);
        jest.advanceTimersByTime(100);
      }
      expect(scheduler.queue.length).toBeLessThanOrEqual(4);
      expect(scheduler.activeTasks.size).toBeLessThanOrEqual(2);
    });

    test('grace cancellation, dedup and urgent priority are retained under limit 1', async () => {
      const { cache: c2, activeFetches: f2 } = createMockCache();
      const s2 = new PreloadScheduler({
        maxConcurrent: 1,
        lookahead: 2,
        cache: c2,
      });
      s2.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      expect(s2.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

      s2.syncQueue({ id: 10 }, [{ id: 99 }]);
      expect(c2.cancel).not.toHaveBeenCalledWith('20');
      jest.advanceTimersByTime(3000);
      expect(c2.cancel).toHaveBeenCalledWith('20');
      // The slot is held until the cancelled task settles
      expect(s2.getStatus(99)).toBe(TRACK_STATUS.QUEUED);
      await Promise.resolve();
      expect(s2.getStatus(99)).toBe(TRACK_STATUS.DOWNLOADING);

      const urgent = s2.preloadImmediate({ id: 77 });
      // Urgent preempts track 99; slot is held until track 99 settles
      expect(s2.getStatus(99)).toBe(TRACK_STATUS.QUEUED);
      expect(s2.getStatus(77)).toBe(TRACK_STATUS.QUEUED);
      await Promise.resolve();
      expect(s2.getStatus(77)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(s2.activeTasks.size).toBe(1);
      f2.get('77').resolve();
      await urgent;
      expect(s2.getStatus(77)).toBe(TRACK_STATUS.READY);
      s2.destroy();
    });
  });

  describe('Gate A Section 4.4 pressure edge regressions (coordinator review)', () => {
    test('retained next queue reschedules and starts on transition to stable after pressure cancellation', async () => {
      // 1. Startup pressure active
      scheduler.setPlaybackPressure({ requestId: 'r1', phase: 'startup' });
      // 2. Queue synced with next track while pressure is active
      scheduler.syncQueue({ id: 'current' }, [{ id: 'next' }]);
      expect(scheduler.queue.length).toBe(1);
      expect(mockCache.getOrFetch).not.toHaveBeenCalled();

      // 3. Stalled pressure cancels queued/active background jobs
      scheduler.setPlaybackPressure({ requestId: 'r1', phase: 'stalled' });
      expect(scheduler.queue.length).toBe(0);
      expect(scheduler.activeTasks.size).toBe(0);

      // 4. Stable transition reschedules retained desired metadata and starts downloading next track under ramp
      scheduler.setPlaybackPressure({ requestId: 'r1', phase: 'stable' });
      expect(scheduler.getStatus('next')).toBe(TRACK_STATUS.DOWNLOADING);
      expect(mockCache.getOrFetch).toHaveBeenCalledWith(
        'next',
        expect.any(String),
        expect.any(Object),
      );
    });

    test('cacheCurrent requested during pressure observes 5s eligibility delay after entering stable', async () => {
      // 1. Startup pressure active
      scheduler.setPlaybackPressure({ requestId: 'r2', phase: 'startup' });
      // 2. cacheCurrent called during startup
      const p = scheduler.cacheCurrent({ id: 'current-track' });
      p.catch(() => {});
      expect(scheduler.getStatus('current-track')).toBe(TRACK_STATUS.QUEUED);
      expect(mockCache.getOrFetch).not.toHaveBeenCalled();

      // 3. Transition to stable
      scheduler.setPlaybackPressure({ requestId: 'r2', phase: 'stable' });
      // Must NOT start immediately: must wait for 5s eligibility delay
      expect(scheduler.getStatus('current-track')).toBe(TRACK_STATUS.QUEUED);
      expect(mockCache.getOrFetch).not.toHaveBeenCalledWith(
        'current-track',
        expect.any(String),
        expect.any(Object),
      );

      // 4. After 4999ms, still queued
      jest.advanceTimersByTime(4999);
      expect(scheduler.getStatus('current-track')).toBe(TRACK_STATUS.QUEUED);

      // 5. At 5000ms after stable, eligibility delay elapses and download starts
      jest.advanceTimersByTime(1);
      expect(scheduler.getStatus('current-track')).toBe(
        TRACK_STATUS.DOWNLOADING,
      );
      expect(mockCache.getOrFetch).toHaveBeenCalledWith(
        'current-track',
        expect.any(String),
        expect.any(Object),
      );
    });
  });
});
