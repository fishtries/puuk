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

    expect(uri).toContain('101.mp3');
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
    expect(cachedUri).toContain('303.mp3');
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
});