import {
  fetchRecentlyListened,
  normalizeHistoryTracks,
  RECENTLY_LISTENED_CACHE_KEY,
  RECENTLY_LISTENED_TTL_MS,
} from '../history';
import * as apiCacheModule from '../apiCache';

jest.mock('../apiCache', () => ({
  fetchCatalogWithCache: jest.fn(),
}));

describe('history API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('exports correct constants', () => {
    expect(RECENTLY_LISTENED_CACHE_KEY).toBe('recently-listened-v1-limit-100');
    expect(RECENTLY_LISTENED_TTL_MS).toBe(60 * 60 * 1000);
  });

  describe('normalizeHistoryTracks', () => {
    test('filters out invalid or null items and normalizes valid tracks', () => {
      const raw = [
        { id: 10, title: 'Valid 10', artist: 'Artist A' },
        null,
        { title: 'No ID' },
        { id: 'track-20', title: 'Valid 20', artist: 'Artist B', coverArt: 'http://img' },
        { id: 0, title: 'Valid 0', artist: 'Artist C' }, // 0 is valid ID
      ];

      const normalized = normalizeHistoryTracks(raw, 'https://test.server');
      expect(normalized).toHaveLength(3);
      expect(normalized[0].id).toBe(10);
      expect(normalized[0].coverArt).toBe('https://test.server/api/cover/10');
      expect(normalized[1].id).toBe('track-20');
      expect(normalized[1].coverArt).toBe('http://img');
      expect(normalized[2].id).toBe(0);
    });

    test('returns empty array when input is not an array', () => {
      expect(normalizeHistoryTracks(null)).toEqual([]);
      expect(normalizeHistoryTracks(undefined)).toEqual([]);
      expect(normalizeHistoryTracks({})).toEqual([]);
    });
  });

  describe('fetchRecentlyListened', () => {
    test('calls fetchCatalogWithCache with correct endpoint, key, ttlMs and validation', async () => {
      apiCacheModule.fetchCatalogWithCache.mockResolvedValueOnce({
        data: [{ id: 1, title: 'Track 1' }],
        fromCache: false,
        isStale: false,
      });

      const abortController = new AbortController();
      const result = await fetchRecentlyListened({
        userId: 42,
        serverUrl: 'https://puuk.test',
        signal: abortController.signal,
        forceRefresh: true,
      });

      expect(apiCacheModule.fetchCatalogWithCache).toHaveBeenCalledTimes(1);
      const [endpoint, opts] = apiCacheModule.fetchCatalogWithCache.mock.calls[0];

      expect(endpoint).toBe('/api/history?limit=100');
      expect(opts.key).toBe(RECENTLY_LISTENED_CACHE_KEY);
      expect(opts.ttlMs).toBe(3600000);
      expect(opts.userId).toBe(42);
      expect(opts.serverUrl).toBe('https://puuk.test');
      expect(opts.signal).toBe(abortController.signal);
      expect(opts.forceRefresh).toBe(true);

      // Validate option should strictly require an Array
      expect(typeof opts.validate).toBe('function');
      expect(opts.validate([])).toBe(true);
      expect(opts.validate([{ id: 1 }])).toBe(true);
      expect(opts.validate({})).toBe(false);
      expect(opts.validate(null)).toBe(false);
      expect(opts.validate('string')).toBe(false);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(1);
      expect(result.fromCache).toBe(false);
    });

    test('transforms data in callbacks onData, onCachedData, onFreshData', async () => {
      let registeredOpts;
      apiCacheModule.fetchCatalogWithCache.mockImplementationOnce((endpoint, opts) => {
        registeredOpts = opts;
        // Simulate cache hit callback
        opts.onCachedData?.([{ id: 'cached-1', title: 'Cached' }]);
        opts.onData?.([{ id: 'cached-1', title: 'Cached' }], { fromCache: true, isStale: false });
        opts.onFreshData?.([{ id: 'fresh-1', title: 'Fresh' }]);
        return Promise.resolve({
          data: [{ id: 'fresh-1', title: 'Fresh' }],
          fromCache: false,
          isStale: false,
        });
      });

      const onCachedData = jest.fn();
      const onData = jest.fn();
      const onFreshData = jest.fn();

      await fetchRecentlyListened({
        serverUrl: 'https://puuk.test',
        onCachedData,
        onData,
        onFreshData,
      });

      expect(onCachedData).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'cached-1', title: 'Cached' }),
      ]);
      expect(onData).toHaveBeenCalledWith(
        [expect.objectContaining({ id: 'cached-1', title: 'Cached' })],
        { fromCache: true, isStale: false },
      );
      expect(onFreshData).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'fresh-1', title: 'Fresh' }),
      ]);
    });

    test('handles empty array result', async () => {
      apiCacheModule.fetchCatalogWithCache.mockResolvedValueOnce({
        data: [],
        fromCache: true,
        isStale: false,
      });

      const res = await fetchRecentlyListened({ userId: 1 });
      expect(res.data).toEqual([]);
      expect(res.fromCache).toBe(true);
    });
  });
});
