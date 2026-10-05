import { PreloadScheduler, TRACK_STATUS } from '../preloadScheduler';

describe('PreloadScheduler', () => {
  let mockCache;
  let scheduler;
  let activeFetches;

  beforeEach(() => {
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

  test('cancels stale downloads when the logical queue changes', async () => {
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

    // Old track 20 was cancelled
    expect(mockCache.cancel).toHaveBeenCalledWith('20');
    expect(scheduler.getStatus(20)).toBe(TRACK_STATUS.CANCELLED);

    // New track 99 should now be downloading
    expect(scheduler.getStatus(99)).toBe(TRACK_STATUS.DOWNLOADING);
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
});