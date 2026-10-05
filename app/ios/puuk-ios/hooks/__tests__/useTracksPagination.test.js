import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import useTracksPagination from '../useTracksPagination';
import { fetchTracksPage, TRACKS_PAGE_SIZE } from '../../utils/apiCache';

jest.mock('../../utils/api', () => ({
  SERVER_URL: 'https://puuk.app',
}));

jest.mock('../../utils/apiCache', () => {
  const actual = jest.requireActual('../../utils/apiCache');
  return {
    ...actual,
    fetchTracksPage: jest.fn(),
  };
});

describe('useTracksPagination', () => {
  let hookResult;
  let setCurrentTrackMock;

  function HookHarness({ currentUser, currentTrack }) {
    hookResult = useTracksPagination({
      currentUser,
      currentTrack,
      setCurrentTrack: setCurrentTrackMock,
      serverUrl: 'https://puuk.app',
    });
    return null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    setCurrentTrackMock = jest.fn();
    hookResult = null;
  });

  it('первый запрос использует limit=30&offset=0', async () => {
    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      const items = [{ id: '1', title: 'Track 1' }];
      if (options?.onData) {
        options.onData({ page: 0, offset: 0, limit: 30, items, hasMore: false });
      }
      return { data: { page: 0, offset: 0, limit: 30, items, hasMore: false }, fromCache: false, isStale: false };
    });

    await act(async () => {
      TestRenderer.create(<HookHarness currentUser={{ id: 1, name: 'Alice' }} currentTrack={null} />);
    });

    expect(fetchTracksPage).toHaveBeenCalledWith(
      0,
      TRACKS_PAGE_SIZE,
      expect.objectContaining({
        userId: 1,
        serverUrl: 'https://puuk.app',
      })
    );
    expect(hookResult.tracks).toEqual([{ id: '1', title: 'Track 1' }]);
    expect(hookResult.hasMoreTracks).toBe(false);
  });

  it('следующая страница использует правильный offset и объединяется без дубликатов', async () => {
    // Generate 30 tracks for page 1
    const page1Items = Array.from({ length: 30 }, (_, i) => ({ id: `t-${i + 1}`, title: `Track ${i + 1}` }));
    // Page 2 has 10 tracks, with the first overlapping with the last item of page 1
    const page2Items = [
      { id: 't-30', title: 'Track 30 Updated' },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `t-${i + 31}`, title: `Track ${i + 31}` })),
    ];

    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      if (offset === 0) {
        const data = { page: 0, offset: 0, limit: 30, items: page1Items, hasMore: true };
        if (options?.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      if (offset === 30) {
        const data = { page: 1, offset: 30, limit: 30, items: page2Items, hasMore: false };
        if (options?.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      return { data: { items: [], hasMore: false }, fromCache: false, isStale: false };
    });

    await act(async () => {
      TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    expect(hookResult.tracks).toHaveLength(30);
    expect(hookResult.hasMoreTracks).toBe(true);

    // Load next page
    await act(async () => {
      await hookResult.loadMoreTracks();
    });

    expect(fetchTracksPage).toHaveBeenCalledWith(
      30,
      TRACKS_PAGE_SIZE,
      expect.objectContaining({
        userId: 1,
      })
    );

    // Total tracks should be 30 + 9 = 39 (track t-30 was deduplicated and updated in place)
    expect(hookResult.tracks).toHaveLength(39);
    expect(hookResult.tracks[29].title).toBe('Track 30 Updated');
    expect(hookResult.tracks[38].id).toBe('t-39');
    expect(hookResult.hasMoreTracks).toBe(false);
  });

  it('count < limit выключает дальнейшую загрузку hasMoreTracks', async () => {
    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      const data = { page: 0, offset: 0, limit: 30, items: [{ id: '1' }], hasMore: false };
      if (options?.onData) options.onData(data);
      return { data, fromCache: false, isStale: false };
    });

    await act(async () => {
      TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    expect(hookResult.hasMoreTracks).toBe(false);

    // Attempting to load more when hasMoreTracks is false does not call fetchTracksPage again
    fetchTracksPage.mockClear();
    await act(async () => {
      await hookResult.loadMoreTracks();
    });

    expect(fetchTracksPage).not.toHaveBeenCalled();
  });

  it('повторный loadMoreTracks не создаёт параллельный сетевой запрос (ref lock)', async () => {
    const page1Items = Array.from({ length: 30 }, (_, i) => ({ id: `t-${i}` }));

    let resolvePage2;
    const page2Promise = new Promise((r) => {
      resolvePage2 = r;
    });

    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      if (offset === 0) {
        const data = { page: 0, offset: 0, limit: 30, items: page1Items, hasMore: true };
        if (options?.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      return page2Promise;
    });

    await act(async () => {
      TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    // Fire loadMoreTracks twice concurrently
    let p1;
    let p2;
    act(() => {
      p1 = hookResult.loadMoreTracks();
      p2 = hookResult.loadMoreTracks();
    });

    expect(fetchTracksPage).toHaveBeenCalledTimes(2); // 1 for initial page, exactly 1 for page 2!

    // Resolve page 2
    await act(async () => {
      resolvePage2({
        data: { page: 1, offset: 30, limit: 30, items: [{ id: 't-31' }], hasMore: false },
        fromCache: false,
        isStale: false,
      });
      await p1;
      await p2;
    });

    expect(fetchTracksPage).toHaveBeenCalledTimes(2);
  });

  it('ошибка второй страницы оставляет первую страницу без потерь', async () => {
    const page1Items = [{ id: '1', title: 'Track 1' }];

    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      if (offset === 0) {
        const data = { page: 0, offset: 0, limit: 30, items: page1Items, hasMore: true };
        if (options?.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      throw new Error('Network timeout during page 2');
    });

    await act(async () => {
      TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    expect(hookResult.tracks).toEqual(page1Items);

    await act(async () => {
      await hookResult.loadMoreTracks();
    });

    // Tracks still contain page 1 items
    expect(hookResult.tracks).toEqual(page1Items);
    expect(hookResult.isLoadingMoreTracks).toBe(false);
  });

  it('смена пользователя отменяет старый запрос и игнорирует устаревший ответ', async () => {
    let resolveUser1;
    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      if (options.userId === 1) {
        return new Promise((r) => {
          resolveUser1 = () => {
            if (options.onData) options.onData({ items: [{ id: 'u1-track' }], hasMore: false });
            r({ data: { items: [{ id: 'u1-track' }], hasMore: false }, fromCache: false, isStale: false });
          };
        });
      }
      if (options.userId === 2) {
        const data = { page: 0, offset: 0, limit: 30, items: [{ id: 'u2-track' }], hasMore: false };
        if (options.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      return { data: { items: [] } };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    // User switches to User 2 before User 1's response resolves
    await act(async () => {
      renderer.update(<HookHarness currentUser={{ id: 2 }} currentTrack={null} />);
    });

    // User 1's slow response resolves late
    await act(async () => {
      if (resolveUser1) resolveUser1();
    });

    // Tracks must contain ONLY User 2's track
    expect(hookResult.tracks).toEqual([{ id: 'u2-track' }]);
  });

  it('при смене пользователя tracks мгновенно очищаются ещё до ответа сети нового пользователя', async () => {
    let resolveUser2;
    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      if (options.userId === 1) {
        const data = { page: 0, offset: 0, limit: 30, items: [{ id: 'u1-song' }], hasMore: false };
        if (options.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      if (options.userId === 2) {
        return new Promise((r) => {
          resolveUser2 = () => {
            const data = { page: 0, offset: 0, limit: 30, items: [{ id: 'u2-song' }], hasMore: false };
            if (options.onData) options.onData(data);
            r({ data, fromCache: false, isStale: false });
          };
        });
      }
      return { data: { items: [] } };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    expect(hookResult.tracks).toEqual([{ id: 'u1-song' }]);

    // User switches to User 2 (network pending)
    await act(async () => {
      renderer.update(<HookHarness currentUser={{ id: 2 }} currentTrack={null} />);
    });

    // Tracks MUST BE IMMEDIATELY CLEARED, before User 2 resolves!
    expect(hookResult.tracks).toEqual([]);

    // Now user 2 resolves
    await act(async () => {
      if (resolveUser2) resolveUser2();
    });

    expect(hookResult.tracks).toEqual([{ id: 'u2-song' }]);
  });

  it('завершение старого loadMoreTracks после смены пользователя не сбрасывает loading state новой сессии', async () => {
    let resolveUser1Page2;
    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      if (options.userId === 1 && offset === 0) {
        const data = { page: 0, offset: 0, limit: 30, items: Array.from({ length: 30 }, (_, i) => ({ id: `u1-${i}` })), hasMore: true };
        if (options.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      if (options.userId === 1 && offset === 30) {
        return new Promise((r) => {
          resolveUser1Page2 = r;
        });
      }
      if (options.userId === 2) {
        const data = { page: 0, offset: 0, limit: 30, items: [{ id: 'u2-0' }], hasMore: false };
        if (options.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      return { data: { items: [] } };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    // Start loadMoreTracks for User 1
    act(() => {
      hookResult.loadMoreTracks();
    });

    expect(hookResult.isLoadingMoreTracks).toBe(true);

    // Switch to User 2 while User 1 loadMore is in flight
    await act(async () => {
      renderer.update(<HookHarness currentUser={{ id: 2 }} currentTrack={null} />);
    });

    // User 2's session has its own clean state
    expect(hookResult.isLoadingMoreTracks).toBe(false);

    // User 1's loadMore promise resolves late
    await act(async () => {
      if (resolveUser1Page2) {
        resolveUser1Page2({
          data: { page: 1, offset: 30, limit: 30, items: [{ id: 'u1-late' }], hasMore: false },
          fromCache: false,
          isStale: false,
        });
      }
    });

    // Still clean, tracks are User 2 only
    expect(hookResult.tracks).toEqual([{ id: 'u2-0' }]);
    expect(hookResult.isLoadingMoreTracks).toBe(false);
  });

  it('после logout tracks очищаются', async () => {
    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      const data = { page: 0, offset: 0, limit: 30, items: [{ id: '1' }], hasMore: false };
      if (options?.onData) options.onData(data);
      return { data, fromCache: false, isStale: false };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    expect(hookResult.tracks).toEqual([{ id: '1' }]);

    // Logout
    await act(async () => {
      renderer.update(<HookHarness currentUser={null} currentTrack={null} />);
    });

    expect(hookResult.tracks).toEqual([]);
    expect(hookResult.hasMoreTracks).toBe(true);
    expect(hookResult.isLoadingMoreTracks).toBe(false);
  });

  it('не выбирает первый трек повторно, если currentTrack уже восстановлен', async () => {
    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      const data = { page: 0, offset: 0, limit: 30, items: [{ id: '1' }, { id: '2' }], hasMore: false };
      if (options?.onData) options.onData(data);
      return { data, fromCache: false, isStale: false };
    });

    const restoredTrack = { id: 'saved-last-track', title: 'Restored from Storage' };

    await act(async () => {
      TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={restoredTrack} />);
    });

    // Should NOT call setCurrentTrack because currentTrack already exists!
    expect(setCurrentTrackMock).not.toHaveBeenCalled();
  });

  it('выбирает первый трек, если currentTrack отсутствует (null)', async () => {
    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      const data = { page: 0, offset: 0, limit: 30, items: [{ id: 'first-track' }], hasMore: false };
      if (options?.onData) options.onData(data);
      return { data, fromCache: false, isStale: false };
    });

    await act(async () => {
      TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    expect(setCurrentTrackMock).toHaveBeenCalledWith({ id: 'first-track' });
  });

  it('loadMoreTracks передаёт signal в fetchTracksPage и отменяет его при смене пользователя или unmount', async () => {
    let capturedSignal;
    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      if (offset === 0) {
        const data = { page: 0, offset: 0, limit: 30, items: Array.from({ length: 30 }, (_, i) => ({ id: `t-${i}` })), hasMore: true };
        if (options.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      if (offset === 30) {
        capturedSignal = options.signal;
        return new Promise(() => {}); // hang
      }
      return { data: { items: [] } };
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    // Start loadMoreTracks
    act(() => {
      hookResult.loadMoreTracks();
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal.aborted).toBe(false);

    // Switch user or unmount
    await act(async () => {
      renderer.unmount();
    });

    // Signal must have been aborted!
    expect(capturedSignal.aborted).toBe(true);
  });

  it('refresh во время активного loadMoreTracks отменяет старый запрос и сразу сбрасывает isLoadingMoreTracks в false', async () => {
    let capturedLoadMoreSignal;
    let resolveRefresh;

    fetchTracksPage.mockImplementation(async (offset, limit, options) => {
      if (offset === 0 && !options.forceRefresh) {
        // Initial page 0
        const data = { page: 0, offset: 0, limit: 30, items: Array.from({ length: 30 }, (_, i) => ({ id: `t-${i}` })), hasMore: true };
        if (options.onData) options.onData(data);
        return { data, fromCache: false, isStale: false };
      }
      if (offset === 30) {
        // loadMoreTracks
        capturedLoadMoreSignal = options.signal;
        return new Promise(() => {}); // in flight
      }
      if (offset === 0 && options.forceRefresh) {
        // refreshTracks
        return new Promise((r) => {
          resolveRefresh = () => {
            const data = { page: 0, offset: 0, limit: 30, items: [{ id: 'refreshed-1' }], hasMore: false };
            if (options.onData) options.onData(data);
            r({ data, fromCache: false, isStale: false });
          };
        });
      }
      return { data: { items: [] } };
    });

    await act(async () => {
      TestRenderer.create(<HookHarness currentUser={{ id: 1 }} currentTrack={null} />);
    });

    // Start loadMoreTracks
    act(() => {
      hookResult.loadMoreTracks();
    });

    expect(hookResult.isLoadingMoreTracks).toBe(true);
    expect(capturedLoadMoreSignal.aborted).toBe(false);

    // Trigger refreshTracks during active loadMoreTracks
    act(() => {
      hookResult.refreshTracks();
    });

    // loadMoreTracks must be aborted and isLoadingMoreTracks must immediately be false!
    expect(capturedLoadMoreSignal.aborted).toBe(true);
    expect(hookResult.isLoadingMoreTracks).toBe(false);

    // Complete refresh
    await act(async () => {
      if (resolveRefresh) resolveRefresh();
    });

    expect(hookResult.tracks).toEqual([{ id: 'refreshed-1' }]);
    expect(hookResult.isLoadingMoreTracks).toBe(false);
  });
});
