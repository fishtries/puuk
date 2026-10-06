// In-memory mock filesystem for expo-file-system
const mockFs = new Map();
let mockActiveDownloadTasks = [];

function mockNormalizeUri(uri) {
  return uri.replace(/\/+/g, '/').replace(':/', '://');
}

class MockDirectory {
  constructor(...parts) {
    this.uri = mockNormalizeUri(parts.map(p => (p && p.uri ? p.uri : String(p))).join('/'));
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

class MockDownloadTask {
  constructor(url, destinationFile, options = {}) {
    this.url = url;
    this.destinationFile = destinationFile;
    this.options = options;
    this.isCancelled = false;
    this.isReleased = false;
    mockActiveDownloadTasks.push(this);
  }

  async downloadAsync() {
    if (this.isCancelled) {
      throw new Error('Download cancelled');
    }
    if (this.url.includes('fail_forever')) {
      throw new Error('HTTP 500 Server Error');
    }

    mockFs.set(this.destinationFile.uri, {
      content: 'audio-bytes',
      size: 5000,
      isDir: false,
    });

    return this.destinationFile;
  }

  cancel() {
    this.isCancelled = true;
  }

  release() {
    this.isReleased = true;
  }
}

class MockFile {
  constructor(...parts) {
    this.uri = mockNormalizeUri(parts.map(p => (p && p.uri ? p.uri : String(p))).join('/'));
    this.name = this.uri.split('/').pop() || '';
  }

  get exists() {
    return mockFs.has(this.uri) && !mockFs.get(this.uri).isDir;
  }

  get size() {
    const entry = mockFs.get(this.uri);
    return entry ? entry.size : null;
  }

  info() {
    const entry = mockFs.get(this.uri);
    if (!entry) return { exists: false, size: null };
    return { exists: true, size: entry.size };
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

  static createDownloadTask(url, destinationFile, options) {
    return new MockDownloadTask(url, destinationFile, options);
  }
}

jest.mock('expo-file-system', () => {
  return {
    Directory: function (...args) {
      return new MockDirectory(...args);
    },
    File: Object.assign(
      function (...args) {
        return new MockFile(...args);
      },
      {
        createDownloadTask: (...args) => MockFile.createDownloadTask(...args),
      }
    ),
    Paths: {
      get document() {
        return new MockDirectory('file:///mock/documents');
      },
      availableDiskSpace: 500 * 1024 * 1024,
    },
  };
});

// Import AudioCache AFTER jest.mock
const { AudioCache } = require('../audioCache');

describe('AudioCache', () => {
  let cache;

  beforeEach(() => {
    mockFs.clear();
    mockActiveDownloadTasks = [];
    cache = new AudioCache({
      baseDir: 'file:///mock/documents',
      maxSizeBytes: 10000,
      downloadTimeoutMs: 1000,
    });
  });

  test('init() creates cache and temp directories and loads empty manifest', async () => {
    await cache.init();
    expect(cache.cacheDir.exists).toBe(true);
    expect(cache.tempDir.exists).toBe(true);
    expect(cache.manifest).toEqual({});
  });

  test('init() repairs corrupted manifest entries when files are missing on disk', async () => {
    await cache.init();
    cache.manifest = {
      'track-1': { uri: 'file:///mock/documents/audio-cache/track-1.mp3', size: 1000, mtime: 100 },
    };
    await cache._saveManifest();

    const newCache = new AudioCache({ baseDir: 'file:///mock/documents' });
    await newCache.init();
    expect(newCache.manifest).toEqual({});
  });

  test('getOrFetch() downloads and caches audio atomically as .mp3', async () => {
    await cache.init();
    const uri = await cache.getOrFetch('101', 'https://puuk.app/api/stream/101');

    expect(uri).toMatch(/101_\d+\.mp3$/);
    expect(cache.isCached('101')).toBe(true);
    expect(cache.getCachedUri('101')).toBe(uri);
    expect(cache.manifest['101']).toBeDefined();
    expect(cache.manifest['101'].size).toBe(5000);
  });

  test('getOrFetch() deduplicates concurrent requests for the same track', async () => {
    await cache.init();
    const p1 = cache.getOrFetch('202', 'https://puuk.app/api/stream/202');
    const p2 = cache.getOrFetch('202', 'https://puuk.app/api/stream/202');

    expect(p1).toBe(p2);
    const [u1, u2] = await Promise.all([p1, p2]);
    expect(u1).toBe(u2);
    expect(mockActiveDownloadTasks.filter(t => t.url.includes('202')).length).toBe(1);
  });

  test('getOrFetch() returns cached URI immediately on second call without re-downloading', async () => {
    await cache.init();
    await cache.getOrFetch('303', 'https://puuk.app/api/stream/303');
    const countBefore = mockActiveDownloadTasks.length;

    const cachedUri = await cache.getOrFetch('303', 'https://puuk.app/api/stream/303');
    expect(cachedUri).toMatch(/303_\d+\.mp3$/);
    expect(mockActiveDownloadTasks.length).toBe(countBefore);
  });

  test('cancel() cancels in-flight download and cleans up temp file', async () => {
    await cache.init();
    let downloadResolve;
    const slowTaskPromise = new Promise(res => { downloadResolve = res; });

    const origCreate = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = async () => {
        mockFs.set(dest.uri, { content: 'partial', size: 100, isDir: false });
        await slowTaskPromise;
        return dest;
      };
      return task;
    };

    try {
      const fetchPromise = cache.getOrFetch('404', 'https://puuk.app/api/stream/404');
      expect(cache.ongoingDownloads.has('404')).toBe(true);

      cache.cancel('404');
      expect(cache.ongoingDownloads.has('404')).toBe(false);

      downloadResolve();
      await expect(fetchPromise).rejects.toThrow();
    } finally {
      MockFile.createDownloadTask = origCreate;
    }
  });

  test('LRU eviction deletes oldest accessed files when size limit is exceeded', async () => {
    await cache.init();

    await cache.getOrFetch('t1', 'https://puuk.app/api/stream/t1');
    cache.manifest['t1'].lastAccessed = 1000;
    await cache._saveManifest();

    await cache.getOrFetch('t2', 'https://puuk.app/api/stream/t2');
    cache.manifest['t2'].lastAccessed = 2000;
    await cache._saveManifest();

    expect(cache.isCached('t1')).toBe(true);
    expect(cache.isCached('t2')).toBe(true);

    await cache.getOrFetch('t3', 'https://puuk.app/api/stream/t3');

    expect(cache.isCached('t1')).toBe(false);
    expect(cache.isCached('t2')).toBe(true);
    expect(cache.isCached('t3')).toBe(true);
  });

  test('remove() removes a specific track from disk and manifest', async () => {
    await cache.init();
    await cache.getOrFetch('505', 'https://puuk.app/api/stream/505');
    expect(cache.isCached('505')).toBe(true);

    await cache.remove('505');
    expect(cache.isCached('505')).toBe(false);
    expect(cache.manifest['505']).toBeUndefined();
  });

  test('clear() wipes all cached files and resets manifest', async () => {
    await cache.init();
    await cache.getOrFetch('601', 'https://puuk.app/api/stream/601');
    await cache.getOrFetch('602', 'https://puuk.app/api/stream/602');
    expect(await cache.getSize()).toBe(10000);

    await cache.clear();
    expect(await cache.getSize()).toBe(0);
    expect(cache.isCached('601')).toBe(false);
    expect(cache.isCached('602')).toBe(false);
  });

  test('cleans up legacy .audio entries in manifest and getCachedUri', async () => {
    await cache.init();
    const legacyFile = new MockFile(cache.cacheDir, 'legacy-track.audio');
    legacyFile.write('audio-bytes');
    cache.manifest['legacy-track'] = {
      uri: legacyFile.uri,
      size: 5000,
      mtime: 100,
    };

    expect(cache.getCachedUri('legacy-track')).toBeNull();
    expect(cache.manifest['legacy-track']).toBeUndefined();
    expect(legacyFile.exists).toBe(false);
  });

  test('getDownloadState() correctly reflects idle, downloading, and cached states', async () => {
    await cache.init();
    expect(cache.getDownloadState('701')).toEqual({ status: 'idle' });
    expect(cache.isDownloading('701')).toBe(false);

    let resolveDownload;
    const slowTaskPromise = new Promise(res => { resolveDownload = res; });
    const origCreate = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = async () => {
        mockFs.set(dest.uri, { content: 'partial', size: 100, isDir: false });
        await slowTaskPromise;
        return dest;
      };
      return task;
    };

    try {
      const fetchPromise = cache.getOrFetch('701', 'https://puuk.app/api/stream/701');
      expect(cache.isDownloading('701')).toBe(true);
      const state = cache.getDownloadState('701');
      expect(state.status).toBe('downloading');
      expect(state.promise).toBe(fetchPromise);
      expect(cache.getOngoingPromise('701')).toBe(fetchPromise);

      resolveDownload();
      const uri = await fetchPromise;

      expect(cache.isDownloading('701')).toBe(false);
      expect(cache.getOngoingPromise('701')).toBeNull();
      expect(cache.getDownloadState('701')).toEqual({
        status: 'cached',
        uri,
      });
    } finally {
      MockFile.createDownloadTask = origCreate;
    }
  });

  test('getOrFetch() with signal rejects for aborted caller without cancelling shared in-flight download', async () => {
    await cache.init();
    let resolveDownload;
    const slowTaskPromise = new Promise(res => { resolveDownload = res; });
    const origCreate = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = async () => {
        mockFs.set(dest.uri, { content: 'mp3-content', size: 5000, isDir: false });
        await slowTaskPromise;
        return dest;
      };
      return task;
    };

    try {
      // First caller starts download
      const p1 = cache.getOrFetch('801', 'https://puuk.app/api/stream/801');

      // Second caller joins with an AbortController
      const abortController = new AbortController();
      const p2 = cache.getOrFetch('801', 'https://puuk.app/api/stream/801', {
        signal: abortController.signal,
      });

      // Second caller aborts
      abortController.abort();

      await expect(p2).rejects.toThrow('Download cancelled');

      // First caller's download completes successfully!
      resolveDownload();
      const uri = await p1;
      expect(uri).toMatch(/801_\d+\.mp3$/);
      expect(cache.isCached('801')).toBe(true);
    } finally {
      MockFile.createDownloadTask = origCreate;
    }
  });

  test('cancel() followed by new getOrFetch() preserves new download record when old download finishes late', async () => {
    await cache.init();

    let resolveDownloadA, resolveDownloadB;
    const taskAPromise = new Promise((res) => { resolveDownloadA = res; });
    const taskBPromise = new Promise((res) => { resolveDownloadB = res; });

    let callCount = 0;
    const origCreate = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      callCount += 1;
      const currentCall = callCount;
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = async () => {
        mockFs.set(dest.uri, { content: `content-${currentCall}`, size: 5000, isDir: false });
        if (currentCall === 1) {
          await taskAPromise;
        } else if (currentCall === 2) {
          await taskBPromise;
        }
        return dest;
      };
      return task;
    };

    try {
      // 1. Начинаем загрузку A (track-1)
      const promiseA = cache.getOrFetch('track-1', 'https://puuk.app/api/stream/1');
      expect(callCount).toBe(1);

      // 2. Отменяем A
      cache.cancel('track-1');

      // 3. Начинаем загрузку B (track-1) ДО завершения A
      const promiseB = cache.getOrFetch('track-1', 'https://puuk.app/api/stream/1');
      expect(callCount).toBe(2);
      expect(promiseB).not.toBe(promiseA);

      // 4. Завершаем A
      resolveDownloadA();
      await expect(promiseA).rejects.toThrow('Download cancelled');

      // 5. Убеждаемся, что getOngoingPromise(trackId) возвращает promise B, а не null (запись B не была удалена старым finally!)
      expect(cache.getOngoingPromise('track-1')).toBe(promiseB);
      expect(cache.isDownloading('track-1')).toBe(true);

      // 6. Убеждаемся, что третий getOrFetch() присоединяется к B и не создаёт новую native download task
      const promiseC = cache.getOrFetch('track-1', 'https://puuk.app/api/stream/1');
      expect(promiseC).toBe(promiseB);
      expect(callCount).toBe(2); // Никакой третьей задачи создано не было!

      // 7. Завершаем B
      resolveDownloadB();
      const uriB = await promiseB;
      const uriC = await promiseC;

      expect(uriB).toMatch(/track-1_\d+\.mp3$/);
      expect(uriC).toBe(uriB);
      expect(cache.isCached('track-1')).toBe(true);
      expect(cache.manifest['track-1']).toBeDefined();
    } finally {
      MockFile.createDownloadTask = origCreate;
    }
  });

  test('cancelled task completing late cannot overwrite newly cached file or corrupt manifest', async () => {
    await cache.init();

    let resolveSlowA;
    const taskAPromise = new Promise((res) => { resolveSlowA = res; });

    let callCount = 0;
    const origCreate = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      callCount += 1;
      const currentCall = callCount;
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = async () => {
        if (currentCall === 1) {
          // Task A ignores cancel and takes long time
          await taskAPromise;
          mockFs.set(dest.uri, { content: 'STALE_A', size: 100, isDir: false });
        } else {
          // Task B completes quickly
          mockFs.set(dest.uri, { content: 'FRESH_B', size: 200, isDir: false });
        }
        return dest;
      };
      return task;
    };

    try {
      // Запускаем A
      const promiseA = cache.getOrFetch('race-1', 'https://puuk.app/api/stream/race-1');

      // Отменяем A
      cache.cancel('race-1');

      // Запускаем B, которое завершается сразу
      const promiseB = cache.getOrFetch('race-1', 'https://puuk.app/api/stream/race-1');
      const uriB = await promiseB;
      expect(cache.manifest['race-1'].size).toBe(200);

      // Теперь задача A завершается позже
      resolveSlowA();
      await expect(promiseA).rejects.toThrow('Download cancelled');

      // Задача A не должна перезаписать manifest или файл задачи B!
      expect(cache.manifest['race-1'].size).toBe(200);
      const file = new MockFile(uriB);
      const content = await file.text();
      expect(content).toBe('FRESH_B');
    } finally {
      MockFile.createDownloadTask = origCreate;
    }
  });

  test('late move of cancelled download cannot overwrite or delete a newer generation file', async () => {
    await cache.init();

    const originalCreate = MockFile.createDownloadTask;
    const originalMove = MockFile.prototype.move;
    let downloadCount = 0;
    let moveCount = 0;
    let releaseMoveA;
    const moveGateA = new Promise((resolve) => { releaseMoveA = resolve; });

    MockFile.createDownloadTask = (url, dest, opts) => {
      downloadCount += 1;
      const currentDownload = downloadCount;
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = async () => {
        const content = currentDownload === 1 ? 'STALE_A' : 'FRESH_B';
        const size = currentDownload === 1 ? 100 : 200;
        mockFs.set(dest.uri, { content, size, isDir: false });
        return dest;
      };
      return task;
    };

    MockFile.prototype.move = async function (dest) {
      moveCount += 1;
      if (moveCount === 1) {
        await moveGateA;
      }
      return originalMove.call(this, dest);
    };

    try {
      // A has passed its pre-move generation check and is suspended inside move().
      const promiseA = cache.getOrFetch('race-move', 'https://puuk.app/api/stream/race-move');
      await new Promise((resolve) => setImmediate(resolve));
      expect(moveCount).toBe(1);

      cache.cancel('race-move');
      const promiseB = cache.getOrFetch('race-move', 'https://puuk.app/api/stream/race-move');
      const uriB = await promiseB;

      expect(cache.manifest['race-move']).toEqual(expect.objectContaining({ uri: uriB, size: 200 }));
      expect(await new MockFile(uriB).text()).toBe('FRESH_B');

      // A completes its delayed move after B is already published.
      releaseMoveA();
      await expect(promiseA).rejects.toThrow('Download cancelled');

      expect(cache.manifest['race-move']).toEqual(expect.objectContaining({ uri: uriB, size: 200 }));
      expect(await new MockFile(uriB).text()).toBe('FRESH_B');
      expect(new MockFile(cache.cacheDir, 'race-move_1.mp3').exists).toBe(false);
    } finally {
      releaseMoveA();
      MockFile.createDownloadTask = originalCreate;
      MockFile.prototype.move = originalMove;
    }
  });
});
