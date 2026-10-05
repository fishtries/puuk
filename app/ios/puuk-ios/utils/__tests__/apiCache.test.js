const mockFs = new Map();

function mockNormalizeUri(uri) {
  return uri.replace(/\/+/g, '/').replace(':/', '://');
}

class MockDirectory {
  constructor(...parts) {
    this.uri = mockNormalizeUri(parts.map((p) => (p && p.uri ? p.uri : String(p))).join('/'));
    this.name = this.uri.split('/').pop() || '';
  }

  get exists() {
    return mockFs.has(this.uri) && mockFs.get(this.uri).isDir;
  }

  create({ intermediates } = {}) {
    mockFs.set(this.uri, { isDir: true });
  }

  delete() {
    for (const key of Array.from(mockFs.keys())) {
      if (key === this.uri || key.startsWith(this.uri + '/')) {
        mockFs.delete(key);
      }
    }
  }

  list() {
    const results = [];
    const prefix = this.uri.endsWith('/') ? this.uri : this.uri + '/';
    for (const [key, val] of mockFs.entries()) {
      if (key.startsWith(prefix) && key !== this.uri) {
        const rest = key.slice(prefix.length);
        if (!rest.includes('/')) {
          if (val.isDir) {
            results.push(new MockDirectory(key));
          } else {
            results.push(new MockFile(key));
          }
        }
      }
    }
    return results;
  }
}

class MockFile {
  constructor(...parts) {
    this.uri = mockNormalizeUri(parts.map((p) => (p && p.uri ? p.uri : String(p))).join('/'));
    this.name = this.uri.split('/').pop() || '';
  }

  get exists() {
    return mockFs.has(this.uri) && !mockFs.get(this.uri).isDir;
  }

  write(content) {
    mockFs.set(this.uri, {
      content: String(content),
      size: Buffer.byteLength(String(content)),
      isDir: false,
    });
  }

  async text() {
    const entry = mockFs.get(this.uri);
    if (!entry) throw new Error('File not found');
    return entry.content;
  }

  delete() {
    mockFs.delete(this.uri);
  }

  async move(dest) {
    const entry = mockFs.get(this.uri);
    if (!entry) throw new Error('Source file does not exist');
    mockFs.set(dest.uri, entry);
    mockFs.delete(this.uri);
    this.uri = dest.uri;
  }
}

jest.mock('expo-file-system', () => {
  return {
    Directory: function (...args) {
      return new MockDirectory(...args);
    },
    File: function (...args) {
      return new MockFile(...args);
    },
    Paths: {
      document: 'file://mock/documents',
      cache: 'file://mock/cache',
    },
  };
});

jest.mock('../api', () => {
  return {
    SERVER_URL: 'https://web.puuk.fun',
    authFetch: jest.fn(),
    getSavedUser: jest.fn().mockResolvedValue({ id: 10, username: 'tester' }),
  };
});

import {
  getCachedCatalog,
  setCachedCatalog,
  removeCachedCatalog,
  clearCatalogCache,
  fetchCatalogWithCache,
  resetMemoryCache,
  getCacheFile,
  getCacheKey,
  deriveCacheKeyFromEndpoint,
  TRACKS_PAGE_SIZE,
  mergeTracks,
  fetchTracksPage,
  CATALOG_CACHE_VERSION,
  normalizeServerUrl,
  hashString,
} from '../apiCache';
import { authFetch } from '../api';

describe('utils/apiCache - Local catalog cache & SWR', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockFs.clear();
    resetMemoryCache();
  });

  describe('запись и чтение валидного кэша', () => {
    it('saves and reads valid catalog cache from memory and disk', async () => {
      const tracks = [{ id: '1', title: 'Song 1' }, { id: '2', title: 'Song 2' }];
      await setCachedCatalog('tracks', tracks, { userId: 10, serverUrl: 'https://web.puuk.fun' });

      // Immediate read (from memory)
      const cachedMem = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      expect(cachedMem).not.toBeNull();
      expect(cachedMem.data).toEqual(tracks);
      expect(cachedMem.version).toBe(CATALOG_CACHE_VERSION);
      expect(cachedMem.isStale).toBe(false);

      // Clear memory cache to force reading from mock filesystem
      resetMemoryCache();

      const cachedDisk = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      expect(cachedDisk).not.toBeNull();
      expect(cachedDisk.data).toEqual(tracks);
      expect(cachedDisk.isStale).toBe(false);
    });
  });

  describe('истёкший кэш всё равно доступен как stale', () => {
    it('returns expired cache marked with isStale: true instead of null', async () => {
      const albums = [{ id: 'a1', title: 'Album 1' }];
      const oldTime = Date.now() - 100000; // 100s ago

      await setCachedCatalog('albums', albums, {
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        savedAt: oldTime,
      });

      // TTL is 50s
      const result = await getCachedCatalog('albums', {
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        ttlMs: 50000,
      });

      expect(result).not.toBeNull();
      expect(result.data).toEqual(albums);
      expect(result.isStale).toBe(true);
    });
  });

  describe('повреждённый JSON удаляется и возвращает null', () => {
    it('gracefully handles corrupted JSON on disk, deletes corrupted file, and returns null', async () => {
      const cacheKey = getCacheKey('tracks', 'https://web.puuk.fun', 10);
      const file = getCacheFile(cacheKey);
      file.write('{ invalid json here !!! ');

      expect(file.exists).toBe(true);

      const result = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      expect(result).toBeNull();
      expect(file.exists).toBe(false); // Cleaned up
    });
  });

  describe('разделение данных по serverUrl и user id', () => {
    it('isolates cache between different servers', async () => {
      await setCachedCatalog('tracks', [{ id: 'srv1' }], { userId: 10, serverUrl: 'https://server1.com' });
      await setCachedCatalog('tracks', [{ id: 'srv2' }], { userId: 10, serverUrl: 'https://server2.com' });

      const res1 = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://server1.com' });
      const res2 = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://server2.com' });

      expect(res1.data).toEqual([{ id: 'srv1' }]);
      expect(res2.data).toEqual([{ id: 'srv2' }]);
    });

    it('isolates cache between different user accounts', async () => {
      await setCachedCatalog('playlists', [{ name: 'User 10 List' }], { userId: 10, serverUrl: 'https://web.puuk.fun' });
      await setCachedCatalog('playlists', [{ name: 'User 20 List' }], { userId: 20, serverUrl: 'https://web.puuk.fun' });

      const resUser10 = await getCachedCatalog('playlists', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      const resUser20 = await getCachedCatalog('playlists', { userId: 20, serverUrl: 'https://web.puuk.fun' });

      expect(resUser10.data).toEqual([{ name: 'User 10 List' }]);
      expect(resUser20.data).toEqual([{ name: 'User 20 List' }]);
    });
  });

  describe('очистка одного ключа и полная очистка', () => {
    it('removes specific cache key while preserving others', async () => {
      await setCachedCatalog('tracks', [{ id: '1' }], { userId: 10, serverUrl: 'https://web.puuk.fun' });
      await setCachedCatalog('albums', [{ id: 'a1' }], { userId: 10, serverUrl: 'https://web.puuk.fun' });

      await removeCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' });

      expect(await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' })).toBeNull();
      expect(await getCachedCatalog('albums', { userId: 10, serverUrl: 'https://web.puuk.fun' })).not.toBeNull();
    });

    it('clears all cache for a specific user when userId is provided', async () => {
      await setCachedCatalog('tracks', [{ id: 'u1' }], { userId: 1, serverUrl: 'https://web.puuk.fun' });
      await setCachedCatalog('tracks', [{ id: 'u2' }], { userId: 2, serverUrl: 'https://web.puuk.fun' });

      await clearCatalogCache({ userId: 1 });

      expect(await getCachedCatalog('tracks', { userId: 1, serverUrl: 'https://web.puuk.fun' })).toBeNull();
      expect(await getCachedCatalog('tracks', { userId: 2, serverUrl: 'https://web.puuk.fun' })).not.toBeNull();
    });

    it('completely clears all catalog cache when no userId is specified', async () => {
      await setCachedCatalog('tracks', [{ id: '1' }], { userId: 1, serverUrl: 'https://web.puuk.fun' });
      await setCachedCatalog('albums', [{ id: '2' }], { userId: 2, serverUrl: 'https://web.puuk.fun' });

      await clearCatalogCache();

      expect(await getCachedCatalog('tracks', { userId: 1, serverUrl: 'https://web.puuk.fun' })).toBeNull();
      expect(await getCachedCatalog('albums', { userId: 2, serverUrl: 'https://web.puuk.fun' })).toBeNull();
    });
  });

  describe('stale-while-revalidate & deduplication', () => {
    it('deduplicates parallel calls for the same resource to a single network request', async () => {
      authFetch.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 'shared', title: 'Shared Song' }],
        };
      });

      const onData1 = jest.fn();
      const onData2 = jest.fn();

      const [res1, res2] = await Promise.all([
        fetchCatalogWithCache('/api/tracks', {
          key: 'tracks',
          userId: 10,
          serverUrl: 'https://web.puuk.fun',
          onData: onData1,
        }),
        fetchCatalogWithCache('/api/tracks', {
          key: 'tracks',
          userId: 10,
          serverUrl: 'https://web.puuk.fun',
          onData: onData2,
        }),
      ]);

      expect(res1.data).toEqual([{ id: 'shared', title: 'Shared Song' }]);
      expect(res2.data).toEqual([{ id: 'shared', title: 'Shared Song' }]);
      // Single network fetch executed!
      expect(authFetch).toHaveBeenCalledTimes(1);

      // Both callers received onData callback with fresh data!
      expect(onData1).toHaveBeenCalledWith([{ id: 'shared', title: 'Shared Song' }], { fromCache: false, isStale: false });
      expect(onData2).toHaveBeenCalledWith([{ id: 'shared', title: 'Shared Song' }], { fromCache: false, isStale: false });

      // The result is actually saved in cache and readable without network request
      const cachedEntry = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      expect(cachedEntry).not.toBeNull();
      expect(cachedEntry.data).toEqual([{ id: 'shared', title: 'Shared Song' }]);
      expect(cachedEntry.isStale).toBe(false);
    });

    it('caller with aborted signal aborts immediately without breaking shared network request', async () => {
      let resolveFetch;
      authFetch.mockImplementationOnce(() => new Promise((r) => { resolveFetch = r; }));

      const controller = new AbortController();

      const req1 = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
      });

      const req2 = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        signal: controller.signal,
      });

      // Abort caller 2 before network finishes
      controller.abort();

      await expect(req2).rejects.toThrow('Aborted');

      // Caller 1 continues and completes successfully
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => [{ id: 'ok-1', title: 'Success' }],
      });

      const res1 = await req1;
      expect(res1.data).toEqual([{ id: 'ok-1', title: 'Success' }]);
    });

    it('forceRefresh does not delete a newer inFlightRequests promise', async () => {
      let resolveReq1;
      const promise1 = new Promise((r) => { resolveReq1 = r; });
      authFetch.mockImplementationOnce(() => promise1);

      // Start Request 1
      const req1 = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
      });

      // Start Request 2 with forceRefresh
      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'fresh-2' }],
      });
      const req2 = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
      });

      // Now resolve Req 1 afterwards
      resolveReq1({
        ok: true,
        status: 200,
        json: async () => [{ id: 'slow-1' }],
      });

      await Promise.all([req1, req2]);

      // Cache stores fresh-2
      const cached = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      expect(cached.data).toEqual([{ id: 'fresh-2' }]);
    });

    it('immediately yields cached data, fetches fresh in background, and preserves stale on network failure', async () => {
      const staleTracks = [{ id: 'stale-1', title: 'Old Song' }];
      await setCachedCatalog('tracks', staleTracks, {
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        savedAt: Date.now() - 200000, // expired
      });

      // Network fails
      authFetch.mockRejectedValueOnce(new TypeError('Network request failed'));

      const onDataCalls = [];
      const result = await fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        ttlMs: 1000,
        onData: (data, meta) => onDataCalls.push({ data, meta }),
      });

      // Callback received cached data immediately
      expect(onDataCalls.length).toBe(1);
      expect(onDataCalls[0].data).toEqual(staleTracks);
      expect(onDataCalls[0].meta.fromCache).toBe(true);
      expect(onDataCalls[0].meta.isStale).toBe(true);

      // Stale data was preserved
      expect(result.data).toEqual(staleTracks);
      expect(result.isStale).toBe(true);
      expect(result.fromCache).toBe(true);
      expect(result.error).toBeTruthy();
    });

    it('does not overwrite newer cache entry with a slower, superseded response', async () => {
      let resolveSlow;
      const slowPromise = new Promise((r) => {
        resolveSlow = r;
      });

      // Request 1 is slow
      authFetch.mockImplementationOnce(() => slowPromise);

      const req1 = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
      });

      // Request 2 starts later and finishes quickly with fresh data
      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'fresh-req-2', title: 'Fresh Version' }],
      });

      const req2 = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
      });

      await req2;

      const cacheAfterReq2 = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      expect(cacheAfterReq2.data).toEqual([{ id: 'fresh-req-2', title: 'Fresh Version' }]);

      // Now resolve the older slow request 1
      resolveSlow({
        ok: true,
        status: 200,
        json: async () => [{ id: 'stale-req-1', title: 'Old Outdated Version' }],
      });

      await req1;

      // Must NOT have overwritten fresh-req-2!
      const finalCache = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      expect(finalCache.data).toEqual([{ id: 'fresh-req-2', title: 'Fresh Version' }]);
    });

    it('does not cache 401 unauthorized response', async () => {
      authFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      await expect(
        fetchCatalogWithCache('/api/tracks', {
          key: 'tracks',
          userId: 10,
          serverUrl: 'https://web.puuk.fun',
          forceRefresh: true,
        })
      ).rejects.toThrow('HTTP 401');

      const cached = await getCachedCatalog('tracks', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      expect(cached).toBeNull();
    });
  });

  describe('интеграционные сценарии UI каталога (App.js & HomeScreen)', () => {
    it('UI появляется из локального кэша до завершения сети и затем обновляется', async () => {
      const cached = [{ id: '1', title: 'Cached Song' }];
      await setCachedCatalog('tracks', cached, { userId: 10, serverUrl: 'https://web.puuk.fun' });

      let resolveNetwork;
      const networkPromise = new Promise((r) => {
        resolveNetwork = r;
      });
      authFetch.mockImplementationOnce(() => networkPromise);

      const uiUpdates = [];
      const fetchTask = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
        onData: (data, meta) => uiUpdates.push({ data, meta }),
      });

      // Let microtasks tick for local cache read
      await new Promise((r) => setTimeout(r, 10));

      // UI receives cached tracks immediately, before network promise resolves!
      expect(uiUpdates.length).toBe(1);
      expect(uiUpdates[0].data).toEqual(cached);
      expect(uiUpdates[0].meta.fromCache).toBe(true);

      // Now network resolves
      resolveNetwork({
        ok: true,
        status: 200,
        json: async () => [{ id: '1', title: 'Fresh Song' }],
      });
      await fetchTask;

      expect(uiUpdates.length).toBe(2);
      expect(uiUpdates[1].data).toEqual([{ id: '1', title: 'Fresh Song' }]);
      expect(uiUpdates[1].meta.fromCache).toBe(false);
    });

    it('ошибка сети не очищает уже показанный каталог', async () => {
      const cached = [{ id: '1', title: 'Song 1' }];
      await setCachedCatalog('tracks', cached, { userId: 10, serverUrl: 'https://web.puuk.fun' });

      authFetch.mockRejectedValueOnce(new TypeError('Network request failed'));

      let uiTracks = null;
      const res = await fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
        onData: (data) => {
          uiTracks = data;
        },
      });

      // Stale tracks remain on screen
      expect(uiTracks).toEqual(cached);
      expect(res.data).toEqual(cached);
      expect(res.isStale).toBe(true);
    });

    it('смена пользователя не показывает старый каталог', async () => {
      await setCachedCatalog('tracks', [{ id: 'u1-song' }], { userId: 1, serverUrl: 'https://web.puuk.fun' });

      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'u2-song' }],
      });

      let uiTracks = null;
      // User 2 logs in and fetches tracks
      await fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 2,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
        onData: (data) => {
          uiTracks = data;
        },
      });

      // Must not show user 1's tracks!
      expect(uiTracks).toEqual([{ id: 'u2-song' }]);
      expect(uiTracks).not.toEqual([{ id: 'u1-song' }]);
    });
  });

  describe('mergeTracks - Дедупликация и сохранение порядка', () => {
    it('объединяет страницы без дубликатов по track.id с сохранением порядка', () => {
      const page1 = [
        { id: '1', title: 'Song 1' },
        { id: '2', title: 'Song 2' },
      ];
      const page2 = [
        { id: '2', title: 'Song 2 (updated)' },
        { id: '3', title: 'Song 3' },
      ];

      const merged = mergeTracks(page1, page2);
      expect(merged).toHaveLength(3);
      expect(merged.map((t) => t.id)).toEqual(['1', '2', '3']);
      expect(merged[1].title).toBe('Song 2 (updated)');
    });

    it('корректно обрабатывает пустые списки или элементы без id', () => {
      expect(mergeTracks([], [])).toEqual([]);
      expect(mergeTracks([{ id: '1' }], [null, undefined, {}, { id: '2' }])).toEqual([
        { id: '1' },
        { id: '2' },
      ]);
    });
  });

  describe('fetchTracksPage & кэширование страниц', () => {
    it('первый запрос использует limit=30&offset=0 и формирует правильную структуру страницы', async () => {
      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          { id: 't-1', title: 'Track 1' },
          { id: 't-2', title: 'Track 2' },
        ],
      });

      const res = await fetchTracksPage(0, 30, {
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
      });

      expect(authFetch).toHaveBeenCalledWith(
        '/api/tracks?limit=30&offset=0',
        expect.anything()
      );

      expect(res.data).toEqual({
        page: 0,
        limit: 30,
        offset: 0,
        items: [
          { id: 't-1', title: 'Track 1', coverArt: 'https://web.puuk.fun/api/cover/t-1' },
          { id: 't-2', title: 'Track 2', coverArt: 'https://web.puuk.fun/api/cover/t-2' },
        ],
        hasMore: false, // 2 items < 30
      });
    });

    it('страницы кэшируются независимо (tracks_page_0 vs tracks_page_30)', async () => {
      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'p0-track' }],
      });
      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'p30-track' }],
      });

      await fetchTracksPage(0, 30, { userId: 10, serverUrl: 'https://web.puuk.fun', forceRefresh: true });
      await fetchTracksPage(30, 30, { userId: 10, serverUrl: 'https://web.puuk.fun', forceRefresh: true });

      const cachePage0 = await getCachedCatalog('tracks_page_0', { userId: 10, serverUrl: 'https://web.puuk.fun' });
      const cachePage30 = await getCachedCatalog('tracks_page_30', { userId: 10, serverUrl: 'https://web.puuk.fun' });

      expect(cachePage0).not.toBeNull();
      expect(cachePage30).not.toBeNull();
      expect(cachePage0.data.items[0].id).toBe('p0-track');
      expect(cachePage30.data.items[0].id).toBe('p30-track');
    });

    it('fetchTracksPage корректно прокидывает onFreshData и onCachedData с нормализацией', async () => {
      const onFreshData = jest.fn();
      const onCachedData = jest.fn();

      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'fd-1', title: 'Fresh Callback Track' }],
      });

      await fetchTracksPage(0, 30, {
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
        onFreshData,
        onCachedData,
      });

      expect(onFreshData).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 0,
          limit: 30,
          offset: 0,
          items: [expect.objectContaining({ id: 'fd-1' })],
        })
      );
    });

    it('onData устаревшего forceRefresh запроса не вызывается после завершения более нового запроса', async () => {
      let resolveOldReq;
      const oldReqPromise = new Promise((r) => {
        resolveOldReq = r;
      });
      authFetch.mockImplementationOnce(() => oldReqPromise);

      const oldOnData = jest.fn();
      const req1 = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
        onData: oldOnData,
      });

      // Newer request starts and finishes
      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'new-fresh-data' }],
      });
      const newOnData = jest.fn();
      const req2 = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 10,
        serverUrl: 'https://web.puuk.fun',
        forceRefresh: true,
        onData: newOnData,
      });

      await req2;
      expect(newOnData).toHaveBeenCalledWith([{ id: 'new-fresh-data' }], { fromCache: false, isStale: false });

      // Now resolve the old slow request
      resolveOldReq({
        ok: true,
        status: 200,
        json: async () => [{ id: 'old-stale-data' }],
      });

      await req1;

      // The old request's onData must NOT have been called with the stale data!
      expect(oldOnData).not.toHaveBeenCalledWith([{ id: 'old-stale-data' }], expect.anything());
    });

    it('deriveCacheKeyFromEndpoint формирует безопасные ключи с query-параметрами', () => {
      expect(deriveCacheKeyFromEndpoint('/api/tracks?limit=30&offset=0')).toBe('tracks_limit_30_offset_0');
      expect(deriveCacheKeyFromEndpoint('/api/tracks?limit=30&offset=30')).toBe('tracks_limit_30_offset_30');
      expect(deriveCacheKeyFromEndpoint('/api/albums')).toBe('albums');
    });
  });

  describe('защита от коллизий и нормализация serverUrl в getCacheKey', () => {
    it('нормализует serverUrl (trailing slashes, регистр, пробелы)', () => {
      expect(normalizeServerUrl('  https://FOO.bar/  ')).toBe('https://foo.bar');
      expect(normalizeServerUrl('http://192.168.1.100:8000///')).toBe('http://192.168.1.100:8000');
      expect(normalizeServerUrl('')).toBe('');
      expect(normalizeServerUrl(null)).toBe('');
    });

    it('практически исключает коллизии для похожих URL (https://foo.bar vs https://foo/bar)', () => {
      const key1 = getCacheKey('tracks', 'https://foo.bar', 1);
      const key2 = getCacheKey('tracks', 'https://foo/bar', 1);

      expect(key1).not.toBe(key2);
      expect(key1).toContain('foo_bar');
      expect(key2).toContain('foo_bar');
      // Хэши должны различаться
      expect(hashString('https://foo.bar')).not.toBe(hashString('https://foo/bar'));
    });

    it('изолирует кэш при смене порта или протокола сервера', () => {
      const keyHttp = getCacheKey('tracks', 'http://puuk.fun:8000', 1);
      const keyHttps = getCacheKey('tracks', 'https://puuk.fun:8000', 1);
      const keyAltPort = getCacheKey('tracks', 'http://puuk.fun:3000', 1);

      expect(keyHttp).not.toBe(keyHttps);
      expect(keyHttp).not.toBe(keyAltPort);
    });
  });

  describe('отмена in-flight запросов при clearCatalogCache / logout и защита от сохранения stale snapshot', () => {
    it('clearCatalogCache({ userId }) отменяет активный in-flight запрос и не даёт ему записать snapshot на диск', async () => {
      let resolveNetwork;
      authFetch.mockImplementation((endpoint, options) => {
        return new Promise((resolve, reject) => {
          if (options?.signal?.aborted) {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            return reject(err);
          }
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          }
          resolveNetwork = () => {
            resolve({
              ok: true,
              status: 200,
              json: async () => [{ id: 'stale-user1-track', title: 'Should Not Persist' }],
            });
          };
        });
      });

      const onData = jest.fn();
      // Стартуем сетевой запрос для User 1
      const fetchPromise = fetchCatalogWithCache('/api/tracks', {
        key: 'tracks',
        userId: 1,
        serverUrl: 'https://puuk.app',
        onData,
      });

      // Даём промису перейти от чтения кэша к сетевому запросу
      await new Promise((r) => setImmediate(r));

      // Пользователь делает logout
      await clearCatalogCache({ userId: 1 });

      // Позже старый сетевой ответ пытается разрешиться
      if (resolveNetwork) resolveNetwork();

      try {
        await fetchPromise;
      } catch (err) {
        expect(err.name).toBe('AbortError');
      }

      // 1. onData не должен был вызваться с результатами старого запроса
      expect(onData).not.toHaveBeenCalled();

      // 2. Кэш User 1 на диске и в памяти должен быть чистым (не восстановлен старым запросом!)
      const cached = await getCachedCatalog('tracks', { userId: 1, serverUrl: 'https://puuk.app' });
      expect(cached).toBeNull();
    });

    it('полный clearCatalogCache() отменяет все активные in-flight запросы', async () => {
      let abortedSignalsCount = 0;
      authFetch.mockImplementation((endpoint, options) => {
        if (options?.signal) {
          options.signal.addEventListener('abort', () => {
            abortedSignalsCount += 1;
          }, { once: true });
        }
        return new Promise(() => {}); // hang
      });

      // Запускаем два параллельных запроса для разных ключей
      fetchCatalogWithCache('/api/favorites', { key: 'favorites', userId: 1 });
      fetchCatalogWithCache('/api/playlists', { key: 'playlists', userId: 1 });

      // Даём промисам перейти от чтения кэша к сетевым запросам
      await new Promise((r) => setImmediate(r));

      // Вызываем полный clear
      await clearCatalogCache();

      // Оба in-flight запроса должны быть отменены
      expect(abortedSignalsCount).toBe(2);
    });

    it('защищает от race condition: если clearCatalogCache({ userId }) происходит во время асинхронного перемещения файла snapshot, файл удаляется с диска', async () => {
      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'late-race-user-track', title: 'Late User Race' }],
      });

      const originalMove = MockFile.prototype.move;
      MockFile.prototype.move = async function (dest) {
        // Симулируем logout конкретного пользователя во время файлового I/O
        await clearCatalogCache({ userId: 1 });
        return originalMove.call(this, dest);
      };

      const onData = jest.fn();
      try {
        await fetchCatalogWithCache('/api/tracks', {
          key: 'tracks',
          userId: 1,
          serverUrl: 'https://puuk.app',
          onData,
        });
      } finally {
        MockFile.prototype.move = originalMove;
      }

      // 1. onData не должен был вызваться
      expect(onData).not.toHaveBeenCalled();

      // 2. Файл кэша не должен остаться на диске или в памяти
      const cached = await getCachedCatalog('tracks', { userId: 1, serverUrl: 'https://puuk.app' });
      expect(cached).toBeNull();
    });

    it('защищает от race condition: если полный clearCatalogCache() происходит во время асинхронного перемещения файла snapshot, файл удаляется с диска', async () => {
      authFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ id: 'late-race-global-track', title: 'Late Global Race' }],
      });

      const originalMove = MockFile.prototype.move;
      MockFile.prototype.move = async function (dest) {
        // Симулируем полный сброс кэша прямо во время записи
        await clearCatalogCache();
        return originalMove.call(this, dest);
      };

      const onData = jest.fn();
      try {
        await fetchCatalogWithCache('/api/tracks', {
          key: 'tracks',
          userId: 1,
          serverUrl: 'https://puuk.app',
          onData,
        });
      } finally {
        MockFile.prototype.move = originalMove;
      }

      expect(onData).not.toHaveBeenCalled();

      const cached = await getCachedCatalog('tracks', { userId: 1, serverUrl: 'https://puuk.app' });
      expect(cached).toBeNull();
    });
  });
});
