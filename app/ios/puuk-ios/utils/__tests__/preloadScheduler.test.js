import { PreloadScheduler, TRACK_STATUS } from '../preloadScheduler';

let mockNetworkPolicy = { type: 'wifi', maxConcurrent: 2, lookahead: 2 };

jest.mock('../networkPolicy', () => ({
  getCurrentNetworkPolicy: jest.fn(() => mockNetworkPolicy),
  SAFE_NETWORK_POLICY: { type: 'unknown', maxConcurrent: 1, lookahead: 1 },
  subscribeNetworkPolicy: jest.fn(() => () => {}),
}));

describe('PreloadScheduler', () => {
  let mockCache;
  let scheduler;
  let activeFetches;

  beforeEach(() => {
    mockNetworkPolicy = { type: 'wifi', maxConcurrent: 2, lookahead: 2 };
    activeFetches = new Map();

    mockCache = {
      cachedIds: new Set(),
      isCached: jest.fn((id) => mockCache.cachedIds.has(String(id))),
      getCachedUri: jest.fn((id) => (mockCache.cachedIds.has(String(id)) ? `file:///mock/${id}.audio` : null)),
      cancel: jest.fn((id) => {
        const fetch = activeFetches.get(String(id));
        if (fetch) {
          fetch.cancelled = true;
          fetch.reject(new Error('Download cancelled'));
          activeFetches.delete(String(id));
        }
      }),
      getDownloadState: jest.fn((id) => {
        const idStr = String(id);
        if (mockCache.cachedIds.has(idStr)) {
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
        return (fetch && !fetch.cancelled) ? fetch.promise : null;
      }),
      getOrFetch: jest.fn((id, url, opts) => {
        const idStr = String(id);
        if (mockCache.cachedIds.has(idStr)) {
          return Promise.resolve(`file:///mock/${idStr}.audio`);
        }

        let resolveFn, rejectFn;
        const promise = new Promise((res, rej) => {
          resolveFn = res;
          rejectFn = rej;
        });

        activeFetches.set(idStr, {
          resolve: () => {
            mockCache.cachedIds.add(idStr);
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

    scheduler = new PreloadScheduler({
      maxConcurrent: 1, // Concurrency limit 1 for precise step-by-step testing
      lookahead: 2,
      cache: mockCache,
    });
  });

  afterEach(() => {
    scheduler?.destroy();
  });

  test('prioritizes next track (priority 1) before next-next (priority 2)', async () => {
    const events = [];
    scheduler.addListener(ev => events.push(ev));

    const currentTrack = { id: 10, title: 'Current' };
    const queue = [
      { id: 20, title: 'Next' },
      { id: 30, title: 'NextNext' },
      { id: 40, title: 'TooFar' },
    ];

    scheduler.syncQueue(currentTrack, queue);

    // Track 20 should be downloading immediately (concurrency 1)
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
    // Track 30 should be queued
    expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);
    // Track 40 is beyond lookahead 2, should be idle
    expect(scheduler.getStatus(40)).toBe(TRACK_STATUS.IDLE);

    // Complete track 20
    activeFetches.get('20').resolve();
    await Promise.resolve(); // flush microtasks

    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.READY);
    // Track 30 should now start downloading
    expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.DOWNLOADING);

    // Complete track 30
    activeFetches.get('30').resolve();
    await Promise.resolve();

    expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.READY);
  });

  test('defers stale download cancellation during the grace period', async () => {
    jest.useFakeTimers();
    const currentTrack = { id: 10, title: 'Current' };
    const queue = [
      { id: 20, title: 'Next' },
      { id: 30, title: 'NextNext' },
    ];

    scheduler.syncQueue(currentTrack, queue);
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

    // User skips or rearranges queue completely
    const newQueue = [
      { id: 99, title: 'NewNext' },
      { id: 88, title: 'NewNextNext' },
    ];

    scheduler.syncQueue(currentTrack, newQueue);

    // Old track 20 remains active during the grace period.
    expect(mockCache.cancel).not.toHaveBeenCalledWith('20');
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

    // The occupied slot keeps the replacement queued until the grace expires.
    expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.QUEUED);

    jest.advanceTimersByTime(3000);
    expect(mockCache.cancel).toHaveBeenCalledWith('20');
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.CANCELLED);
    expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.DOWNLOADING);
    jest.useRealTimers();
  });

  test('restores a stale task when it returns before the grace period expires', () => {
    jest.useFakeTimers();
    const currentTrack = { id: 10 };

    scheduler.syncQueue(currentTrack, [{ id: 20 }]);
    scheduler.syncQueue(currentTrack, [{ id: 99 }]);
    expect(mockCache.cancel).not.toHaveBeenCalledWith('20');

    scheduler.syncQueue(currentTrack, [{ id: 20 }]);
    jest.advanceTimersByTime(3000);

    expect(mockCache.cancel).not.toHaveBeenCalledWith('20');
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
    jest.useRealTimers();
  });

  test('cancels a task immediately after repeated queue changes', () => {
    const currentTrack = { id: 10 };

    scheduler.syncQueue(currentTrack, [{ id: 20 }]);
    scheduler.syncQueue(currentTrack, []);
    expect(mockCache.cancel).not.toHaveBeenCalledWith('20');

    scheduler.syncQueue(currentTrack, []);
    expect(mockCache.cancel).toHaveBeenCalledWith('20');
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.CANCELLED);
  });

  test('force cancels stale tasks immediately', () => {
    const currentTrack = { id: 10 };

    scheduler.syncQueue(currentTrack, [{ id: 20 }]);
    scheduler.syncQueue(currentTrack, [{ id: 99 }], { force: true });

    expect(mockCache.cancel).toHaveBeenCalledWith('20');
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.CANCELLED);
  });

  test('urgent preload cancels stale tasks immediately', async () => {
    const currentTrack = { id: 10 };

    scheduler.syncQueue(currentTrack, [{ id: 20 }]);
    scheduler.syncQueue(currentTrack, []);
    const urgentPromise = scheduler.preloadImmediate({ id: 77 });

    expect(mockCache.cancel).toHaveBeenCalledWith('20');
    expect(scheduler.getStatus(77)).toBe(TRACK_STATUS.DOWNLOADING);

    activeFetches.get('77').resolve();
    await urgentPromise;
  });

  test('never cancels the current track through syncQueue', () => {
    scheduler.syncQueue({ id: 10 }, [{ id: 20 }]);
    scheduler.syncQueue({ id: 20 }, [{ id: 30 }], { force: true });

    expect(mockCache.cancel).not.toHaveBeenCalledWith('20');
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
  });

  test('does not duplicate download if already cached or in flight', async () => {
    mockCache.cachedIds.add('50');

    const currentTrack = { id: 10, title: 'Current' };
    const queue = [
      { id: 50, title: 'AlreadyCached' },
      { id: 60, title: 'NeedsDownload' },
    ];

    scheduler.syncQueue(currentTrack, queue);

    // Track 50 was already cached
    expect(scheduler.getStatus(50)).toBe(TRACK_STATUS.READY);
    // Track 60 immediately gets the concurrency slot
    expect(scheduler.getStatus(60)).toBe(TRACK_STATUS.DOWNLOADING);
  });

  test('preloadImmediate immediately starts download and returns URI', async () => {
    const track = { id: 77, title: 'Urgent' };
    const promise = scheduler.preloadImmediate(track);

    expect(scheduler.getStatus(77)).toBe(TRACK_STATUS.DOWNLOADING);
    activeFetches.get('77').resolve();

    const uri = await promise;
    expect(uri).toBe('file:///mock/77.audio');
    expect(scheduler.getStatus(77)).toBe(TRACK_STATUS.READY);
  });

  test('handles download errors and sets FAILED status', async () => {
    const currentTrack = { id: 10 };
    const queue = [{ id: 88 }];

    scheduler.syncQueue(currentTrack, queue);
    expect(scheduler.getStatus(88)).toBe(TRACK_STATUS.DOWNLOADING);

    activeFetches.get('88').reject(new Error('Network failure'));
    await Promise.resolve();

    expect(scheduler.getStatus(88)).toBe(TRACK_STATUS.FAILED);
    expect(scheduler.getError(88)?.message).toBe('Network failure');
  });

  test('preloadImmediate promotes existing queued task to priority 0 and preempts lower priority task', async () => {
    const currentTrack = { id: 10 };
    const queue = [
      { id: 20, title: 'Next' },
      { id: 30, title: 'NextNext' },
    ];

    scheduler.syncQueue(currentTrack, queue);
    // Track 20 is downloading (concurrency 1), track 30 is queued with priority 2
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
    expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);

    // Call preloadImmediate for track 30
    const urgentPromise = scheduler.preloadImmediate({ id: 30, title: 'NextNext' });

    // Track 30 was promoted to priority 0 and preempted track 20
    expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.DOWNLOADING);
    expect(scheduler.activeTasks.has('30')).toBe(true);
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.QUEUED);
    expect(scheduler.queue.find(q => q.trackId === '20')).toBeDefined();

    // Complete track 30
    activeFetches.get('30').resolve();
    const uri = await urgentPromise;
    expect(uri).toBe('file:///mock/30.audio');
    expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.READY);

    // Track 20 resumes downloading automatically after track 30 finishes
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
    activeFetches.get('20').resolve();
    await Promise.resolve();
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.READY);
  });

  test('preloadImmediate waits in queue at priority 0 when active tasks are already priority 0', async () => {
    // Start first urgent task
    const p1 = scheduler.preloadImmediate({ id: 101, title: 'Urgent 1' });
    expect(scheduler.getStatus(101)).toBe(TRACK_STATUS.DOWNLOADING);
    expect(scheduler.activeTasks.get('101').priority).toBe(0);

    // Start second urgent task (concurrency 1 is full with priority 0)
    const p2 = scheduler.preloadImmediate({ id: 102, title: 'Urgent 2' });

    // Task 102 must NOT preempt task 101 because task 101 is already priority 0
    expect(scheduler.getStatus(101)).toBe(TRACK_STATUS.DOWNLOADING);
    expect(scheduler.getStatus(102)).toBe(TRACK_STATUS.QUEUED);
    const queued102 = scheduler.queue.find(q => q.trackId === '102');
    expect(queued102).toBeDefined();
    expect(queued102.priority).toBe(0);

    // Complete task 101
    activeFetches.get('101').resolve();
    await p1;

    // Task 102 now starts downloading
    expect(scheduler.getStatus(102)).toBe(TRACK_STATUS.DOWNLOADING);
    activeFetches.get('102').resolve();
    await p2;
    expect(scheduler.getStatus(102)).toBe(TRACK_STATUS.READY);
  });

  test('preloadImmediate returns existing promise if download is already in flight', async () => {
    const currentTrack = { id: 10 };
    const queue = [{ id: 20, title: 'Next' }];

    scheduler.syncQueue(currentTrack, queue);
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

    const callCountBefore = mockCache.getOrFetch.mock.calls.length;

    // Call preloadImmediate for the track that is already in flight
    const immediatePromise = scheduler.preloadImmediate({ id: 20, title: 'Next' });

    // It must NOT call getOrFetch a second time!
    expect(mockCache.getOrFetch.mock.calls.length).toBe(callCountBefore);

    activeFetches.get('20').resolve();
    const uri = await immediatePromise;
    expect(uri).toBe('file:///mock/20.audio');
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.READY);
  });

  test('preloadImmediate strictly respects maxConcurrent and preempts lower priority background task', async () => {
    const currentTrack = { id: 10 };
    const queue = [{ id: 20, title: 'Next' }];

    scheduler.syncQueue(currentTrack, queue);
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
    expect(scheduler.activeTasks.size).toBe(1);

    // Track 99 arrives as urgent download (preloadImmediate)
    const urgentPromise = scheduler.preloadImmediate({ id: 99, title: 'UrgentNow' });

    // Track 20 was preempted and returned to queue
    expect(mockCache.cancel).toHaveBeenCalledWith('20');
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.QUEUED);

    // Track 99 took over the single active slot (concurrency limit 1 is NOT exceeded!)
    expect(scheduler.activeTasks.size).toBe(1);
    expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.DOWNLOADING);

    // Complete track 99
    activeFetches.get('99').resolve();
    const uri99 = await urgentPromise;
    expect(uri99).toBe('file:///mock/99.audio');
    expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.READY);

    // Track 20 resumes downloading automatically
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
    activeFetches.get('20').resolve();
    await Promise.resolve();
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.READY);
  });

  test('syncQueue coordinates with AudioCache when download was already started externally', async () => {
    // Simulate PlaybackCoordinator starting download of track 55 directly in AudioCache
    const externalPromise = mockCache.getOrFetch('55', 'https://puuk.app/api/stream/55');

    const currentTrack = { id: 10 };
    const queue = [{ id: 55, title: 'PlayingSoon' }];

    // syncQueue should notice AudioCache is already downloading track 55
    scheduler.syncQueue(currentTrack, queue);

    expect(scheduler.getStatus(55)).toBe(TRACK_STATUS.DOWNLOADING);
    // It did NOT add a duplicate fetch to the queue
    expect(scheduler.queue.find(q => q.trackId === '55')).toBeUndefined();

    // Resolving the external download updates scheduler's status to READY
    activeFetches.get('55').resolve();
    await externalPromise;
    await Promise.resolve();

    expect(scheduler.getStatus(55)).toBe(TRACK_STATUS.READY);
  });

  describe('network policy', () => {
    test.each([
      ['cellular', 1, 1],
      ['unknown', 1, 1],
      ['wifi', 2, 2],
    ])('%s applies maxConcurrent=%i and lookahead=%i', (type, maxConcurrent, lookahead) => {
      const policyScheduler = new PreloadScheduler({
        maxConcurrent: 2,
        lookahead: 2,
        cache: mockCache,
        getNetworkPolicy: () => ({ type, maxConcurrent, lookahead }),
      });

      policyScheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }, { id: 40 }]);

      expect(policyScheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(policyScheduler.getStatus(30)).toBe(
        lookahead === 2 ? TRACK_STATUS.DOWNLOADING : TRACK_STATUS.IDLE
      );
      expect(policyScheduler.getStatus(40)).toBe(TRACK_STATUS.IDLE);
      expect(policyScheduler.activeTasks.size).toBe(maxConcurrent === 1 ? 1 : 2);
      policyScheduler.destroy();
    });

    test('null/unknown policy clamps scheduler to safe baseline (maxConcurrent=1, lookahead=1)', () => {
      const unknownScheduler = new PreloadScheduler({
        maxConcurrent: 2,
        lookahead: 2,
        cache: mockCache,
        getNetworkPolicy: () => null,
      });
      const limits = unknownScheduler._effectiveLimits();
      expect(limits.maxConcurrent).toBe(1);
      expect(limits.lookahead).toBe(1);

      unknownScheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      // On safe baseline, lookahead is 1, so only track 20 is queued/downloading, track 30 is idle
      expect(unknownScheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(unknownScheduler.getStatus(30)).toBe(TRACK_STATUS.IDLE);
      unknownScheduler.destroy();
    });

    test('transition from wifi to cellular resyncs queue and limits lookahead to 1', () => {
      let currentPolicy = { type: 'wifi', maxConcurrent: 2, lookahead: 2 };
      let notifyPolicyChange;
      const subscribeMock = (cb) => {
        notifyPolicyChange = cb;
        return () => {};
      };

      const dynamicScheduler = new PreloadScheduler({
        maxConcurrent: 2,
        lookahead: 2,
        cache: mockCache,
        getNetworkPolicy: () => currentPolicy,
        subscribeNetworkPolicy: subscribeMock,
      });

      dynamicScheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      // On Wi-Fi: both 20 and 30 are downloading (concurrency 2)
      expect(dynamicScheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(dynamicScheduler.getStatus(30)).toBe(TRACK_STATUS.DOWNLOADING);

      // Switch to cellular
      currentPolicy = { type: 'cellular', maxConcurrent: 1, lookahead: 1 };
      notifyPolicyChange(currentPolicy);

      // Limits updated
      const limits = dynamicScheduler._effectiveLimits();
      expect(limits.maxConcurrent).toBe(1);
      expect(limits.lookahead).toBe(1);
      dynamicScheduler.destroy();
    });

    test('_pump() does not start already queued priority 2 task when lookahead decreases to 1', async () => {
      let currentPolicy = { type: 'wifi', maxConcurrent: 1, lookahead: 2 };

      const dynamicScheduler = new PreloadScheduler({
        maxConcurrent: 1,
        lookahead: 2,
        cache: mockCache,
        getNetworkPolicy: () => currentPolicy,
      });

      dynamicScheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      // Concurrency 1: track 20 downloading, track 30 queued
      expect(dynamicScheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      expect(dynamicScheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);

      // Network policy drops lookahead to 1
      currentPolicy = { type: 'cellular', maxConcurrent: 1, lookahead: 1 };

      // Track 20 finishes
      activeFetches.get('20').resolve();
      await Promise.resolve();

      expect(dynamicScheduler.getStatus(20)).toBe(TRACK_STATUS.READY);
      // Track 30 has priority 2 > lookahead 1, so _pump() must NOT start it!
      expect(dynamicScheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);
      dynamicScheduler.destroy();
    });

    test('preempted background task promise resolves when task is restarted and completed', async () => {
      // Track 20 starts downloading
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

      // External caller holds original promise for track 20
      const activeTask20 = scheduler.activeTasks.get('20');
      const originalPromise20 = activeTask20.promise;

      // Urgent task 99 preempts track 20
      const urgentPromise = scheduler.preloadImmediate({ id: 99, title: 'Urgent' });
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.QUEUED);

      // Urgent task completes
      activeFetches.get('99').resolve();
      await urgentPromise;
      expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.READY);

      // Track 20 resumed downloading
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

      // Complete restarted track 20
      activeFetches.get('20').resolve();

      // Original promise MUST resolve, never hang pending!
      const resolvedUri = await originalPromise20;
      expect(resolvedUri).toBe('file:///mock/20.audio');
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.READY);
    });

    test('grace period applies to queued tasks and cancels them after grace timeout', () => {
      jest.useFakeTimers();
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);
      // 20 is downloading, 30 is queued
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);

      // New queue drops track 30 completely
      scheduler.syncQueue({ id: 10 }, [{ id: 20 }]);

      // Track 30 is NOT cancelled immediately, it has grace timer
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.QUEUED);
      expect(scheduler.graceTimers.has('30')).toBe(true);

      // Advance by 3000ms
      jest.advanceTimersByTime(3000);

      // Now track 30 is cancelled
      expect(scheduler.getStatus(30)).toBe(TRACK_STATUS.CANCELLED);
      expect(scheduler.queue.find(q => q.trackId === '30')).toBeUndefined();
      jest.useRealTimers();
    });

    test('preemption with out-of-order completion: attempt 2 finishes before attempt 1 catch without hanging promise', async () => {
      let attempt1Reject;
      let attempt2Resolve;
      let urgentResolve;
      let attemptCount = 0;

      mockCache.getOrFetch = jest.fn((id) => {
        attemptCount++;
        const currentAttempt = attemptCount;
        return new Promise((res, rej) => {
          if (String(id) === '99') {
            urgentResolve = res;
          } else if (currentAttempt === 1) {
            attempt1Reject = rej;
          } else {
            attempt2Resolve = res;
          }
        });
      });

      scheduler.syncQueue({ id: 10 }, [{ id: 20 }]);
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);
      const activeTask20 = scheduler.activeTasks.get('20');
      const originalPromise = activeTask20.promise;

      // Urgent preload preempts track 20
      const urgentPromise = scheduler.preloadImmediate({ id: 99 });
      expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.DOWNLOADING);

      // Track 20 was preempted and is back in queue
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.QUEUED);

      // Urgent preload finishes
      urgentResolve('file:///mock/99.audio');
      await urgentPromise;
      expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.READY);

      // Now scheduler restarts track 20 (attempt 2)
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

      // Attempt 2 completes IMMEDIATELY before attempt 1 rejection settles
      attempt2Resolve('file:///mock/20.audio');
      await Promise.resolve();

      // Later, attempt 1 rejects with cancellation
      if (attempt1Reject) {
        attempt1Reject(new Error('Download cancelled'));
      }
      await Promise.resolve();

      // The original promise MUST resolve successfully with the uri of attempt 2!
      const uri = await originalPromise;
      expect(uri).toBe('file:///mock/20.audio');
      expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.READY);
    });

    test('preloadImmediate with options.currentTrackId clears grace timer and protects track without prior setCurrentTrack', async () => {
      jest.useFakeTimers();
      // Track 10 was queued and fell into grace period
      scheduler.syncQueue({ id: 5 }, [{ id: 10 }, { id: 20 }]);
      scheduler.syncQueue({ id: 5 }, [{ id: 20 }]); // track 10 falls into grace

      expect(scheduler.graceTimers.has('10')).toBe(true);

      // NO setCurrentTrack called! Only passed via options:
      const urgentPromise = scheduler.preloadImmediate({ id: 99 }, { currentTrackId: 10 });
      urgentPromise.catch(() => {});

      // The grace timer for track 10 must be cleared immediately
      expect(scheduler.graceTimers.has('10')).toBe(false);

      // Even after 3000ms grace period expires, track 10 is NOT cancelled
      jest.advanceTimersByTime(3000);
      expect(scheduler.getStatus(10)).not.toBe(TRACK_STATUS.CANCELLED);

      activeFetches.get('99')?.resolve();
      await urgentPromise;
      jest.useRealTimers();
    });

    test('network policy change does not inherit force: true from previous syncQueue call', () => {
      let currentPolicy = { type: 'wifi', maxConcurrent: 2, lookahead: 2 };
      let notifyPolicyChange;
      const subscribeMock = (cb) => {
        notifyPolicyChange = cb;
        return () => {};
      };

      const dynamicScheduler = new PreloadScheduler({
        maxConcurrent: 2,
        lookahead: 2,
        cache: mockCache,
        getNetworkPolicy: () => currentPolicy,
        subscribeNetworkPolicy: subscribeMock,
      });

      // Previous sync had force: true
      dynamicScheduler.syncQueue({ id: 10 }, [{ id: 20 }], { force: true });
      expect(dynamicScheduler.getStatus(20)).toBe(TRACK_STATUS.DOWNLOADING);

      // Add another track to queue
      dynamicScheduler.syncQueue({ id: 10 }, [{ id: 20 }, { id: 30 }]);

      // Simulate network policy change (e.g. Wi-Fi -> cellular)
      currentPolicy = { type: 'cellular', maxConcurrent: 1, lookahead: 1 };
      notifyPolicyChange(currentPolicy);

      // Track 30 should receive grace timer rather than being immediately force-cancelled
      expect(dynamicScheduler.getStatus(30)).not.toBe(TRACK_STATUS.CANCELLED);
      dynamicScheduler.destroy();
    });
  });
});
