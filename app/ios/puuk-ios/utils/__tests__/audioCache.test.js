// In-memory mock filesystem for expo-file-system
const mockFs = new Map();
let mockActiveDownloadTasks = [];

function mockNormalizeUri(uri) {
  return uri.replace(/\/+/g, '/').replace(':/', '://');
}

class MockDirectory {
  constructor(...parts) {
    this.uri = mockNormalizeUri(
      parts.map((p) => (p && p.uri ? p.uri : String(p))).join('/'),
    );
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
    this.uri = mockNormalizeUri(
      parts.map((p) => (p && p.uri ? p.uri : String(p))).join('/'),
    );
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
      },
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
const { AudioCache, classifyDownloadError } = require('../audioCache');

function httpError(status) {
  const err = new Error(`HTTP ${status}`);
  err.status = status;
  return err;
}

function flush() {
  return Promise.resolve();
}

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
      'track-1': {
        uri: 'file:///mock/documents/audio-cache/track-1.mp3',
        size: 1000,
        mtime: 100,
      },
    };
    await cache._saveManifest();

    const newCache = new AudioCache({ baseDir: 'file:///mock/documents' });
    await newCache.init();
    expect(newCache.manifest).toEqual({});
  });

  test('getOrFetch() downloads and caches audio atomically as .mp3', async () => {
    await cache.init();
    const uri = await cache.getOrFetch(
      '101',
      'https://puuk.app/api/stream/101',
    );
    expect(uri).toMatch(/101_[a-z0-9]+_\d+\.mp3$/);
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
    expect(
      mockActiveDownloadTasks.filter((t) => t.url.includes('202')).length,
    ).toBe(1);
  });

  test('getOrFetch() returns cached URI immediately on second call without re-downloading', async () => {
    await cache.init();
    await cache.getOrFetch('303', 'https://puuk.app/api/stream/303');
    const countBefore = mockActiveDownloadTasks.length;

    const cachedUri = await cache.getOrFetch(
      '303',
      'https://puuk.app/api/stream/303',
    );
    expect(cachedUri).toMatch(/303_[a-z0-9]+_\d+\.mp3$/);
    expect(mockActiveDownloadTasks.length).toBe(countBefore);
  });

  test('cancel() cancels in-flight download and cleans up temp file', async () => {
    await cache.init();
    let downloadResolve;
    const slowTaskPromise = new Promise((res) => {
      downloadResolve = res;
    });

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
      const fetchPromise = cache.getOrFetch(
        '404',
        'https://puuk.app/api/stream/404',
      );
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
    const slowTaskPromise = new Promise((res) => {
      resolveDownload = res;
    });
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
      const fetchPromise = cache.getOrFetch(
        '701',
        'https://puuk.app/api/stream/701',
      );
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
    const slowTaskPromise = new Promise((res) => {
      resolveDownload = res;
    });
    const origCreate = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = async () => {
        mockFs.set(dest.uri, {
          content: 'mp3-content',
          size: 5000,
          isDir: false,
        });
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
      expect(uri).toMatch(/801_[a-z0-9]+_\d+\.mp3$/);
      expect(cache.isCached('801')).toBe(true);
    } finally {
      MockFile.createDownloadTask = origCreate;
    }
  });

  test('cancel() followed by new getOrFetch() preserves new download record when old download finishes late', async () => {
    await cache.init();

    let resolveDownloadA, resolveDownloadB;
    const taskAPromise = new Promise((res) => {
      resolveDownloadA = res;
    });
    const taskBPromise = new Promise((res) => {
      resolveDownloadB = res;
    });

    let callCount = 0;
    const origCreate = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      callCount += 1;
      const currentCall = callCount;
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = async () => {
        mockFs.set(dest.uri, {
          content: `content-${currentCall}`,
          size: 5000,
          isDir: false,
        });
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
      const promiseA = cache.getOrFetch(
        'track-1',
        'https://puuk.app/api/stream/1',
      );
      expect(callCount).toBe(1);

      // 2. Отменяем A
      cache.cancel('track-1');

      // 3. Начинаем загрузку B (track-1) ДО завершения A
      const promiseB = cache.getOrFetch(
        'track-1',
        'https://puuk.app/api/stream/1',
      );
      expect(callCount).toBe(2);
      expect(promiseB).not.toBe(promiseA);

      // 4. Завершаем A
      resolveDownloadA();
      await expect(promiseA).rejects.toThrow('Download cancelled');

      // 5. Убеждаемся, что getOngoingPromise(trackId) возвращает promise B, а не null (запись B не была удалена старым finally!)
      expect(cache.getOngoingPromise('track-1')).toBe(promiseB);
      expect(cache.isDownloading('track-1')).toBe(true);

      // 6. Убеждаемся, что третий getOrFetch() присоединяется к B и не создаёт новую native download task
      const promiseC = cache.getOrFetch(
        'track-1',
        'https://puuk.app/api/stream/1',
      );
      expect(promiseC).toBe(promiseB);
      expect(callCount).toBe(2); // Никакой третьей задачи создано не было!

      // 7. Завершаем B
      resolveDownloadB();
      const uriB = await promiseB;
      const uriC = await promiseC;

      expect(uriB).toMatch(/track-1_[a-z0-9]+_\d+\.mp3$/);
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
    const taskAPromise = new Promise((res) => {
      resolveSlowA = res;
    });

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
      const promiseA = cache.getOrFetch(
        'race-1',
        'https://puuk.app/api/stream/race-1',
      );

      // Отменяем A
      cache.cancel('race-1');

      // Запускаем B, которое завершается сразу
      const promiseB = cache.getOrFetch(
        'race-1',
        'https://puuk.app/api/stream/race-1',
      );
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
    const moveGateA = new Promise((resolve) => {
      releaseMoveA = resolve;
    });

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
      const promiseA = cache.getOrFetch(
        'race-move',
        'https://puuk.app/api/stream/race-move',
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(moveCount).toBe(1);

      cache.cancel('race-move');
      const promiseB = cache.getOrFetch(
        'race-move',
        'https://puuk.app/api/stream/race-move',
      );
      const uriB = await promiseB;

      expect(cache.manifest['race-move']).toEqual(
        expect.objectContaining({ uri: uriB, size: 200 }),
      );
      expect(await new MockFile(uriB).text()).toBe('FRESH_B');

      // A completes its delayed move after B is already published.
      releaseMoveA();
      await expect(promiseA).rejects.toThrow('Download cancelled');

      expect(cache.manifest['race-move']).toEqual(
        expect.objectContaining({ uri: uriB, size: 200 }),
      );
      expect(await new MockFile(uriB).text()).toBe('FRESH_B');
      expect(new MockFile(cache.cacheDir, 'race-move_m1_1.mp3').exists).toBe(
        false,
      );
    } finally {
      releaseMoveA();
      MockFile.createDownloadTask = originalCreate;
      MockFile.prototype.move = originalMove;
    }
  });

  test('setProtectedTrackIds protects active tracks from LRU eviction', async () => {
    const smallCache = new AudioCache({
      baseDir: 'file://mock/documents',
      maxSizeBytes: 250,
    });
    await smallCache.init();

    // Populate cache with 3 tracks (100 bytes each)
    mockFs.set('file://mock/documents/audio-cache/track-1_m1_1.mp3', {
      content: 'x'.repeat(100),
      size: 100,
      isDir: false,
    });
    mockFs.set('file://mock/documents/audio-cache/track-2_m1_1.mp3', {
      content: 'x'.repeat(100),
      size: 100,
      isDir: false,
    });
    mockFs.set('file://mock/documents/audio-cache/track-3_m1_1.mp3', {
      content: 'x'.repeat(100),
      size: 100,
      isDir: false,
    });

    smallCache.manifest = {
      'track-1': {
        uri: 'file://mock/documents/audio-cache/track-1_m1_1.mp3',
        size: 100,
        lastAccessed: 1000,
      },
      'track-2': {
        uri: 'file://mock/documents/audio-cache/track-2_m1_1.mp3',
        size: 100,
        lastAccessed: 2000,
      },
      'track-3': {
        uri: 'file://mock/documents/audio-cache/track-3_m1_1.mp3',
        size: 100,
        lastAccessed: 3000,
      },
    };

    // Track 1 is the oldest, but it is currently playing and protected!
    smallCache.setProtectedTrackIds(['track-1']);

    await smallCache._enforceSizeLimit();

    // Track 1 must NOT be evicted because it is protected; Track 2 should be evicted instead!
    expect(smallCache.manifest['track-1']).toBeDefined();
    expect(smallCache.manifest['track-2']).toBeUndefined();
    expect(smallCache.manifest['track-3']).toBeDefined();
  });
});

describe('AudioCache reliability (Gate A)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockFs.clear();
    mockActiveDownloadTasks = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeCache(overrides = {}) {
    return new AudioCache({
      baseDir: 'file:///mock/documents',
      maxSizeBytes: 10000,
      ...overrides,
    });
  }

  test('classifyDownloadError uses structured numeric status and ignores text', () => {
    expect(classifyDownloadError(httpError(401))).toEqual({
      kind: 'auth',
      statusCode: 401,
      retryable: false,
    });
    expect(classifyDownloadError(httpError(403)).kind).toBe('auth');
    expect(classifyDownloadError(httpError(404))).toEqual({
      kind: 'not_found',
      statusCode: 404,
      retryable: false,
    });
    expect(classifyDownloadError(httpError(400)).kind).toBe('permanent');
    expect(classifyDownloadError(httpError(409)).retryable).toBe(false);
    expect(classifyDownloadError(httpError(408)).kind).toBe('transient');
    expect(classifyDownloadError(httpError(429)).retryable).toBe(true);
    expect(classifyDownloadError(httpError(503)).kind).toBe('transient');
    expect(classifyDownloadError(httpError(503)).retryable).toBe(true);

    // Textual "401"/"Unable to download" must NOT become auth/status.
    const textOnly = new Error(
      'Unable to download a file: server returned HTTP 401 Unauthorized',
    );
    expect(classifyDownloadError(textOnly)).toEqual({
      kind: 'unknown',
      statusCode: null,
      retryable: false,
    });

    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    expect(classifyDownloadError(abortErr)).toEqual({
      kind: 'cancelled',
      statusCode: null,
      retryable: false,
    });
  });

  test('transient failure retries within a bounded total budget and then succeeds', async () => {
    const cache = makeCache({
      inactivityTimeoutMs: 20000,
      totalTimeoutMs: 180000,
    });
    await cache.init();

    let calls = 0;
    const orig = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      const task = new MockDownloadTask(url, dest, opts);
      calls += 1;
      const call = calls;
      task.downloadAsync = async () => {
        if (call < 3) throw httpError(503);
        mockFs.set(dest.uri, { content: 'ok', size: 5000, isDir: false });
        return dest;
      };
      return task;
    };
    try {
      const p = cache.getOrFetch('retry-ok', 'https://x/stream');
      await jest.advanceTimersByTimeAsync(10);
      await jest.advanceTimersByTimeAsync(800);
      await jest.advanceTimersByTimeAsync(2000);
      const uri = await p;
      expect(uri).toMatch(/retry-ok_[a-z0-9]+_\d+\.mp3$/);
      expect(calls).toBe(3);
    } finally {
      MockFile.createDownloadTask = orig;
    }
  });

  test('permanent 401/403/404 and unknown native errors are not retried', async () => {
    for (const [error, expectedCalls] of [
      [httpError(401), 1],
      [httpError(403), 1],
      [httpError(404), 1],
      [new Error('Unable to download a file: server returned HTTP 401'), 1],
    ]) {
      mockFs.clear();
      mockActiveDownloadTasks = [];
      const cache = makeCache();
      await cache.init();
      let calls = 0;
      const orig = MockFile.createDownloadTask;
      MockFile.createDownloadTask = (url, dest, opts) => {
        calls += 1;
        const task = new MockDownloadTask(url, dest, opts);
        task.downloadAsync = async () => {
          throw error;
        };
        return task;
      };
      try {
        const p = cache.getOrFetch('perm', 'https://x/stream');
        p.catch(() => {});
        await jest.advanceTimersByTimeAsync(10000);
        await expect(p).rejects.toBe(error);
        expect(calls).toBe(expectedCalls);
        expect(cache.ongoingDownloads.has('perm')).toBe(false);
      } finally {
        MockFile.createDownloadTask = orig;
      }
    }
  });

  test('inactivity timeout aborts a stalled attempt and retries transiently', async () => {
    jest.setTimeout(20000);
    const cache = makeCache({ inactivityTimeoutMs: 200, retryDelaysMs: [0] });
    await cache.init();

    let calls = 0;
    const orig = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      calls += 1;
      const task = new MockDownloadTask(url, dest, opts);
      if (calls === 1) {
        // Stalled: native promise never settles and ignores cancel.
        task.downloadAsync = () => {
          return new Promise(() => {});
        };
      } else {
        task.downloadAsync = async () => {
          mockFs.set(dest.uri, { content: 'ok', size: 5000, isDir: false });
          return dest;
        };
      }
      return task;
    };
    try {
      const p = cache.getOrFetch('stall', 'https://x/stream');
      p.catch(() => {});
      await jest.advanceTimersByTimeAsync(200);
      await jest.advanceTimersByTimeAsync(10);
      const uri = await p;
      expect(uri).toMatch(/stall_[a-z0-9]+_\d+\.mp3$/);
      expect(calls).toBe(2);
      expect(mockActiveDownloadTasks[0].isCancelled).toBe(true);
    } finally {
      MockFile.createDownloadTask = orig;
    }
  });

  test('useful progression extends inactivity but never the overall 180s budget', async () => {
    const cache = makeCache({
      inactivityTimeoutMs: 20000,
      totalTimeoutMs: 180000,
      retryDelaysMs: [],
    });
    await cache.init();

    const orig = MockFile.createDownloadTask;
    let capturedOptions;
    MockFile.createDownloadTask = (url, dest, opts) => {
      capturedOptions = opts;
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = () => new Promise(() => {});
      return task;
    };
    try {
      const p = cache.getOrFetch('slow', 'https://x/stream');
      p.catch(() => {});
      await jest.advanceTimersByTimeAsync(10);
      // Progress every 15s keeps inactivity alive but 180s total still wins.
      for (let i = 1; i <= 15; i += 1) {
        jest.advanceTimersByTime(15000);
        capturedOptions.onProgress({ bytesWritten: i * 1000, totalBytes: -1 });
        await Promise.resolve();
      }
      await jest.advanceTimersByTimeAsync(15000);
      await expect(p).rejects.toThrow('total budget');
      expect(cache.ongoingDownloads.has('slow')).toBe(false);
    } finally {
      MockFile.createDownloadTask = orig;
    }
  });

  test('zero/repeated bytesWritten never extends inactivity', async () => {
    const cache = makeCache({ inactivityTimeoutMs: 20000, retryDelaysMs: [] });
    await cache.init();

    const orig = MockFile.createDownloadTask;
    let capturedOptions;
    MockFile.createDownloadTask = (url, dest, opts) => {
      capturedOptions = opts;
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = () => new Promise(() => {});
      return task;
    };
    try {
      const p = cache.getOrFetch('zero', 'https://x/stream');
      p.catch(() => {});
      await jest.advanceTimersByTimeAsync(10);
      for (let i = 0; i < 5; i += 1) {
        jest.advanceTimersByTime(3000);
        capturedOptions.onProgress({ bytesWritten: 0, totalBytes: -1 });
        await Promise.resolve();
      }
      awaiting: {
        // Total elapsed 15s < 20s inactivity: not yet rejected.
        let rejected = false;
        p.catch(() => {
          rejected = true;
        });
        expect(rejected).toBe(false);
      }
      await jest.advanceTimersByTimeAsync(6000);
      await expect(p).rejects.toThrow('inactivity');
    } finally {
      MockFile.createDownloadTask = orig;
    }
  });

  test('retry resets progress baseline and ignores stale progress from an old attempt', async () => {
    const cache = makeCache({
      inactivityTimeoutMs: 20000,
      totalTimeoutMs: 180000,
      retryDelaysMs: [0],
    });
    await cache.init();

    const optionHistory = [];
    let calls = 0;
    const orig = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      calls += 1;
      optionHistory.push(opts);
      const task = new MockDownloadTask(url, dest, opts);
      const call = calls;
      if (call === 1) {
        // First attempt emits useful progress then fails; its callback is stale afterwards.
        task.downloadAsync = async () => {
          opts.onProgress({ bytesWritten: 1000, totalBytes: 10000 });
          await flush();
          throw httpError(503);
        };
      } else {
        task.downloadAsync = () => new Promise(() => {});
      }
      return task;
    };
    try {
      const p = cache.getOrFetch('stale-progress', 'https://x/stream');
      p.catch(() => {});
      await jest.advanceTimersByTimeAsync(10);
      expect(calls).toBe(2);
      // Old attempt progress after the retry started must not extend the new timer.
      optionHistory[0].onProgress({ bytesWritten: 9000, totalBytes: 10000 });
      optionHistory[0].onProgress({ bytesWritten: 9500, totalBytes: 10000 });
      await jest.advanceTimersByTimeAsync(19000);
      let rejected = false;
      p.catch(() => {
        rejected = true;
      });
      expect(rejected).toBe(false);
      await jest.advanceTimersByTimeAsync(2000);
      await expect(p).rejects.toThrow('inactivity');
    } finally {
      MockFile.createDownloadTask = orig;
    }
  });

  test('cancel during abortable backoff settles immediately and starts no new request', async () => {
    const cache = makeCache({
      inactivityTimeoutMs: 20000,
      retryDelaysMs: [5000],
    });
    await cache.init();

    let calls = 0;
    const orig = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      calls += 1;
      const task = new MockDownloadTask(url, dest, opts);
      task.downloadAsync = async () => {
        throw httpError(503);
      };
      return task;
    };
    try {
      const p = cache.getOrFetch('backoff', 'https://x/stream');
      p.catch(() => {});
      await jest.advanceTimersByTimeAsync(10);
      expect(calls).toBe(1);
      cache.cancel('backoff');
      await expect(p).rejects.toThrow('Download cancelled');
      await jest.advanceTimersByTimeAsync(10000);
      expect(calls).toBe(1);
      expect(cache.ongoingDownloads.has('backoff')).toBe(false);
    } finally {
      MockFile.createDownloadTask = orig;
    }
  });

  test('never-settling init allows cancel and total budget to settle and clean up', async () => {
    for (const mode of ['cancel', 'total']) {
      mockFs.clear();
      const cache = makeCache({ totalTimeoutMs: 180000, retryDelaysMs: [] });
      let initStarted = false;
      cache._runInit = async () => {
        initStarted = true;
        return new Promise(() => {});
      };
      const p = cache.getOrFetch(`init-${mode}`, 'https://x/stream');
      p.catch(() => {});
      await flush();
      expect(initStarted).toBe(true);
      expect(cache.ongoingDownloads.has(`init-${mode}`)).toBe(true);

      if (mode === 'cancel') {
        cache.cancel(`init-${mode}`);
        await expect(p).rejects.toThrow('Download cancelled');
      } else {
        await jest.advanceTimersByTimeAsync(180000);
        await expect(p).rejects.toThrow('total budget');
      }
      expect(cache.ongoingDownloads.has(`init-${mode}`)).toBe(false);
      // init itself was never resolved or failed
    }
  });

  test('cancel settles a cancel-ignoring native download by total deadline', async () => {
    mockFs.clear();
    const cache = makeCache({
      totalTimeoutMs: 180000,
      inactivityTimeoutMs: 20000,
      retryDelaysMs: [],
    });
    await cache.init();

    const orig = MockFile.createDownloadTask;
    const task = null;
    let createdTask;
    MockFile.createDownloadTask = (url, dest) => {
      createdTask = new MockDownloadTask(url, dest, {});
      createdTask.downloadAsync = () => new Promise(() => {});
      return createdTask;
    };
    try {
      const p = cache.getOrFetch('ignore-cancel', 'https://x/stream');
      p.catch(() => {});
      await jest.advanceTimersByTimeAsync(10);
      expect(createdTask).toBeDefined();
      // Inactivity first, then no retry delays configured -> single attempt ends.
      await jest.advanceTimersByTimeAsync(20000);
      await expect(p).rejects.toThrow('inactivity');
      expect(createdTask.isCancelled).toBe(true);
      expect(cache.ongoingDownloads.has('ignore-cancel')).toBe(false);
    } finally {
      MockFile.createDownloadTask = orig;
      void task;
    }
  });

  test('late cancelled result cannot publish or start a new network request', async () => {
    mockFs.clear();
    const cache = makeCache({ inactivityTimeoutMs: 20000, retryDelaysMs: [] });
    await cache.init();

    let releaseOld;
    const oldGate = new Promise((resolve) => {
      releaseOld = resolve;
    });
    let calls = 0;
    const orig = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest, opts) => {
      calls += 1;
      const task = new MockDownloadTask(url, dest, opts);
      const call = calls;
      task.downloadAsync = async () => {
        if (call === 1) {
          await oldGate;
          mockFs.set(dest.uri, { content: 'OLD', size: 100, isDir: false });
        } else {
          mockFs.set(dest.uri, { content: 'NEW', size: 200, isDir: false });
        }
        return dest;
      };
      return task;
    };
    try {
      const pOld = cache.getOrFetch('late', 'https://x/stream');
      pOld.catch(() => {});
      await jest.advanceTimersByTimeAsync(10);
      cache.cancel('late');
      await expect(pOld).rejects.toThrow('Download cancelled');

      const pNew = cache.getOrFetch('late', 'https://x/stream');
      await jest.advanceTimersByTimeAsync(10);
      const uriNew = await pNew;
      expect(await new MockFile(uriNew).text()).toBe('NEW');

      releaseOld();
      await flush();
      await flush();
      expect(cache.manifest['late'].uri).toBe(uriNew);
      expect(await new MockFile(uriNew).text()).toBe('NEW');
      expect(calls).toBe(2);
    } finally {
      MockFile.createDownloadTask = orig;
      releaseOld();
    }
  });

  test('invalidate removes only the exact expected URI and leaves newer copy', async () => {
    mockFs.clear();
    const cache = makeCache();
    await cache.init();

    const oldUri = 'file://mock/documents/audio-cache/trk_old_1.mp3';
    const newUri = 'file://mock/documents/audio-cache/trk_new_2.mp3';
    mockFs.set(oldUri, { content: 'OLD', size: 100, isDir: false });
    mockFs.set(newUri, { content: 'NEW', size: 200, isDir: false });
    cache.manifest['trk'] = {
      uri: newUri,
      size: 200,
      mtime: 1,
      lastAccessed: 1,
    };

    // Stale expected URI: no entry match -> false, nothing deleted.
    await expect(cache.invalidate('trk', oldUri)).resolves.toBe(false);
    expect(mockFs.has(oldUri)).toBe(true);
    expect(cache.manifest['trk'].uri).toBe(newUri);
    expect(mockFs.has(newUri)).toBe(true);

    // Correct URI: removes entry + only that file.
    mockFs.set(oldUri, { content: 'OLD', size: 100, isDir: false });
    cache.manifest['trk'] = {
      uri: oldUri,
      size: 100,
      mtime: 1,
      lastAccessed: 1,
    };
    await expect(cache.invalidate('trk', oldUri)).resolves.toBe(true);
    expect(cache.manifest['trk']).toBeUndefined();
    expect(mockFs.has(oldUri)).toBe(false);
    expect(mockFs.has(newUri)).toBe(true);

    // Missing file, entry still matches: idempotent true, no throw.
    cache.manifest['trk'] = {
      uri: oldUri,
      size: 100,
      mtime: 1,
      lastAccessed: 1,
    };
    await expect(cache.invalidate('trk', oldUri)).resolves.toBe(true);
    expect(cache.manifest['trk']).toBeUndefined();

    // No entry: false.
    await expect(cache.invalidate('missing', newUri)).resolves.toBe(false);
  });

  test('invalidate does not cancel unrelated in-flight downloads or clear cache', async () => {
    mockFs.clear();
    const cache = makeCache({ inactivityTimeoutMs: 20000, retryDelaysMs: [] });
    await cache.init();
    const cachedUri = 'file://mock/documents/audio-cache/cached_1.mp3';
    mockFs.set(cachedUri, { content: 'CACHED', size: 50, isDir: false });
    cache.manifest['cached'] = {
      uri: cachedUri,
      size: 50,
      mtime: 1,
      lastAccessed: 1,
    };

    const orig = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest) => {
      const task = new MockDownloadTask(url, dest, {});
      task.downloadAsync = () => new Promise(() => {});
      return task;
    };
    try {
      const p = cache.getOrFetch('inflight', 'https://x/stream');
      p.catch(() => {});
      await jest.advanceTimersByTimeAsync(10);
      expect(cache.ongoingDownloads.has('inflight')).toBe(true);

      await cache.invalidate('cached', cachedUri);
      expect(cache.manifest['cached']).toBeUndefined();
      expect(cache.ongoingDownloads.has('inflight')).toBe(true);

      cache.cancel('inflight');
      await expect(p).rejects.toThrow('Download cancelled');
    } finally {
      MockFile.createDownloadTask = orig;
    }
  });

  test('publication names are unique across cache instances so stale URI cannot match a newer copy', async () => {
    mockFs.clear();
    const cacheA = makeCache();
    await cacheA.init();
    const uriA = await cacheA.getOrFetch('shared', 'https://x/stream');

    const cacheB = makeCache();
    await cacheB.init();
    // Simulate restart: same track downloaded again by a new instance.
    delete cacheB.manifest['shared'];
    const uriB = await cacheB.getOrFetch('shared', 'https://x/stream');

    expect(uriA).not.toBe(uriB);
    expect(new MockFile(uriA).exists).toBe(true);
    expect(new MockFile(uriB).exists).toBe(true);

    // The stale URI from the old instance must not invalidate B's published entry.
    cacheB.manifest['shared'] = {
      uri: uriB,
      size: 5000,
      mtime: 1,
      lastAccessed: 1,
    };
    await expect(cacheB.invalidate('shared', uriA)).resolves.toBe(false);
    expect(cacheB.manifest['shared'].uri).toBe(uriB);
    expect(new MockFile(uriB).exists).toBe(true);
  });

  test('injected retry delays are clamped to at most three attempts total', async () => {
    mockFs.clear();
    const cache = makeCache({ retryDelaysMs: [10, 20, 30, 40, 50] });
    expect(cache.retryDelaysMs).toHaveLength(2);
    expect(cache.maxAttempts).toBe(3);
  });

  test('total budget includes init and all attempts, never resets', async () => {
    mockFs.clear();
    const cache = makeCache({
      totalTimeoutMs: 5000,
      inactivityTimeoutMs: 1000,
      retryDelaysMs: [2000, 2000],
    });
    await cache.init();

    const orig = MockFile.createDownloadTask;
    MockFile.createDownloadTask = (url, dest) => {
      const task = new MockDownloadTask(url, dest, {});
      task.downloadAsync = () => new Promise(() => {});
      return task;
    };
    try {
      const p = cache.getOrFetch('budget', 'https://x/stream');
      p.catch(() => {});
      await jest.advanceTimersByTimeAsync(1000); // inactivity fails attempt 1
      await jest.advanceTimersByTimeAsync(2000); // backoff 2s (clamped to remaining)
      await jest.advanceTimersByTimeAsync(1000); // inactivity fails attempt 2
      await jest.advanceTimersByTimeAsync(2000); // backoff capped by remaining budget
      await expect(p).rejects.toThrow(/budget|inactivity/);
      expect(cache.ongoingDownloads.has('budget')).toBe(false);
    } finally {
      MockFile.createDownloadTask = orig;
    }
  });

  test('single in-flight init is retried after an init failure', async () => {
    mockFs.clear();
    const cache = makeCache();
    let calls = 0;
    const realRunInit = cache._runInit.bind(cache);
    cache._runInit = async () => {
      calls += 1;
      if (calls === 1) throw new Error('init boom');
      return realRunInit();
    };
    try {
      await expect(cache.init()).rejects.toThrow('init boom');
      // init itself was never resolved or failed
      expect(cache.isInitialized).toBe(false);
      const p1 = cache.init();
      const p2 = cache.init();
      expect(p1).toBe(p2);
      await p1;
      expect(cache.isInitialized).toBe(true);
      expect(calls).toBe(2);
    } finally {
      cache._runInit = realRunInit;
    }
  });

  test('wall clock backwards jump does not prevent total budget timeout', async () => {
    mockFs.clear();
    const realDateNow = Date.now;
    let fakeWallTime = realDateNow();
    Date.now = () => fakeWallTime;

    try {
      const cache = makeCache({
        totalTimeoutMs: 180000,
        inactivityTimeoutMs: 20000,
        retryDelaysMs: [800, 2000],
      });
      await cache.init();

      let calls = 0;
      let capturedOptions;
      const orig = MockFile.createDownloadTask;
      MockFile.createDownloadTask = (url, dest, opts) => {
        calls += 1;
        capturedOptions = opts;
        const task = new MockDownloadTask(url, dest, opts);
        task.downloadAsync = () => new Promise(() => {}); // never settles
        return task;
      };

      try {
        const p = cache.getOrFetch('wall-jump', 'https://x/stream');
        p.catch(() => {});
        await jest.advanceTimersByTimeAsync(10);

        // Progress every 15s keeps inactivity timer from firing
        for (let i = 1; i <= 4; i += 1) {
          jest.advanceTimersByTime(15000);
          capturedOptions.onProgress({
            bytesWritten: i * 1000,
            totalBytes: -1,
          });
          await Promise.resolve();
        }

        // At 60s elapsed, wall clock jumps backwards by 1 hour (NTP sync / user change)
        fakeWallTime -= 3600000;

        // Progress continues up to 180s total monotonic budget
        for (let i = 5; i <= 12; i += 1) {
          jest.advanceTimersByTime(15000);
          capturedOptions.onProgress({
            bytesWritten: i * 1000,
            totalBytes: -1,
          });
          await Promise.resolve();
        }

        // Advance the final tick to reach 180s total budget
        await jest.advanceTimersByTimeAsync(10);
        await expect(p).rejects.toThrow('total budget');

        // Verify cleanup and that no further retries or network tasks are launched
        expect(cache.ongoingDownloads.has('wall-jump')).toBe(false);
        await jest.advanceTimersByTimeAsync(30000);
        expect(calls).toBe(1);
      } finally {
        MockFile.createDownloadTask = orig;
      }
    } finally {
      Date.now = realDateNow;
    }
  });
});
