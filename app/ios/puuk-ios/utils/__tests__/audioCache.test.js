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

  rename(name) {
    const dest = this.uri.slice(0, this.uri.lastIndexOf('/') + 1) + name;
    if (mockFs.has(dest)) throw new Error('Destination exists');
    const entry = mockFs.get(this.uri);
    if (!entry) throw new Error('Missing source');
    mockFs.set(dest, entry); mockFs.delete(this.uri); this.uri = dest; this.name = name;
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
    File: MockFile,
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

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
let session, valid, cache;
const options = () => ({ session: () => session, sessionValid: () => valid, safetyMarginBytes: 0 });
function descriptor(id = ID, changes = {}) {
  return { uri: `https://api.test/api/stream/${id}?mt=a.b.c`, headers: {}, delivery: 'direct', trackId: id,
    session: { ...session }, cacheable: true, contentVersion: HASH, contentLength: 5000, downloadBinding: 'if-match', reuseUntil: performance.now() + 30000, ...changes };
}
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
async function ticks() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
beforeEach(async () => {
  mockFs.clear(); mockActiveDownloadTasks = []; jest.restoreAllMocks();
  session = { origin: 'https://api.test', userId: '17', generation: 1 }; valid = true;
  cache = new AudioCache(options()); await cache.init();
});
afterEach(() => { cache.revoke(); jest.useRealTimers(); });

describe('bound transfer admission and crash recovery', () => {
  test('direct GET sends exact If-Match, foreground session, no Range; manifest never stores capability', async () => {
    const uri = await cache.getOrFetch(ID, descriptor());
    expect(uri).toMatch(/^file:.*object-.*\.mp3$/);
    expect(mockActiveDownloadTasks[0].options).toMatchObject({ headers: { 'If-Match': `"sha256-${HASH}"` }, sessionType: 'foreground', signal: expect.anything() });
    expect(JSON.stringify(cache.manifest)).not.toMatch(/mt=|a\.b\.c|headers|sourceUri/);
    expect(cache.getCachedUri(ID)).toBe(uri);
    expect(Object.values(cache.manifest)[0]).toMatchObject({ verification: 'bound-transfer-v1', complete: true, expectedLength: 5000 });
  });
  test('CDN request receives a fresh empty header object', async () => {
    await cache.getOrFetch(ID, descriptor(ID, { delivery: 'cdn', downloadBinding: 'immutable-path', uri: `https://media.puuk.fun/cdn/audio/${ID}/${HASH}?md5=${'z'.repeat(22)}&expires=2000000000`, headers: { Authorization: 'must-not-forward', Cookie: 'must-not-forward' } }));
    expect(mockActiveDownloadTasks[0].options.headers).toEqual({});
  });
  test.each([undefined, 'https://api.test/api/stream/id', { cacheable: false }, { ...descriptor(), downloadBinding: null }, { ...descriptor(), contentLength: null }, { ...descriptor(), contentLength: 500 * 1024 * 1024 + 1 }])('missing/legacy/unbound descriptor streams only (%#)', async d => {
    await expect(cache.getOrFetch(ID, d)).rejects.toThrow();
    expect(mockActiveDownloadTasks).toHaveLength(0); expect(cache.getCachedUri(ID)).toBeNull();
  });
  test.each([null, 0, 4999, 5001])('null/partial/overlong result is discarded (%p)', async result => {
    jest.spyOn(MockDownloadTask.prototype, 'downloadAsync').mockImplementation(async function () {
      mockFs.set(this.destinationFile.uri, {size: result === null ? 5000 : result}); return result === null ? null : this.destinationFile;
    });
    await expect(cache.getOrFetch(ID, descriptor())).rejects.toThrow();
    expect(cache.getCachedUri(ID)).toBeNull(); expect(cache.tempDir.list()).toHaveLength(0);
  });
  test('equal-length replacement before conditional GET (412) cannot admit B as A', async () => {
    jest.spyOn(MockDownloadTask.prototype, 'downloadAsync').mockRejectedValue(httpError(412));
    await expect(cache.getOrFetch(ID, descriptor())).rejects.toThrow();
    expect(Object.keys(cache.manifest)).toHaveLength(0);
  });
  test('a single fresh descriptor restart after precondition failure admits the new version only', async () => {
    const original = MockDownloadTask.prototype.downloadAsync;
    jest.spyOn(MockDownloadTask.prototype, 'downloadAsync').mockRejectedValueOnce(httpError(412)).mockImplementation(original);
    const resolveFresh = jest.fn(async () => descriptor(ID, { contentVersion: 'b'.repeat(64) }));
    await cache.getOrFetch(ID, descriptor(), { resolveFresh });
    expect(resolveFresh).toHaveBeenCalledTimes(1); expect(mockActiveDownloadTasks).toHaveLength(2);
    expect(Object.values(cache.manifest)[0].contentVersion).toBe('b'.repeat(64));
  });
  test('replacement after pin retains A; its descriptor is the binding, not a guessed response ETag', async () => {
    await cache.getOrFetch(ID, descriptor());
    expect(Object.values(cache.manifest)[0].contentVersion).toBe(HASH);
    expect(mockActiveDownloadTasks[0]).not.toHaveProperty('etag');
  });
  test('second admission survives restart without overwriting the existing manifest', async () => {
    const a = await cache.getOrFetch(ID, descriptor()); const b = await cache.getOrFetch(ID2, descriptor(ID2));
    const restarted = new AudioCache(options()); await restarted.init(); restarted.setOnline(false);
    expect(restarted.getCachedUri(ID)).toBe(a); expect(restarted.getCachedUri(ID2)).toBe(b);
    expect(cache.cacheDir.list().filter(f => /^index-.*\.json$/.test(f.name))).toHaveLength(2);
  });
  test('interleaved admissions serialize publication and keep both entries', async () => {
    const original = MockFile.prototype.text, gate = deferred(); let first = true;
    jest.spyOn(MockFile.prototype, 'text').mockImplementation(async function () { if (first) {first = false; await gate.promise;} return original.call(this); });
    const a = cache.getOrFetch(ID, descriptor()); const b = cache.getOrFetch(ID2, descriptor(ID2));
    await ticks(); expect(Object.keys(cache.manifest)).toHaveLength(0); gate.resolve(); await Promise.all([a,b]);
    expect(Object.keys(cache.manifest)).toHaveLength(2);
  });
  test('corrupt newest snapshot falls back to prior complete snapshot; orphans and parts never become hits', async () => {
    const a = await cache.getOrFetch(ID, descriptor()); await cache.getOrFetch(ID2, descriptor(ID2));
    const newest = cache.cacheDir.list().filter(f => /^index-.*\.json$/.test(f.name)).sort((a,b) => b.name.localeCompare(a.name))[0];
    newest.write('{"format":1');
    new MockFile(cache.cacheDir, 'object-orphan.mp3').write('audio'); new MockFile(cache.cacheDir,'index-3-crash.json.part').write('{}');
    const restarted = new AudioCache(options()); await restarted.init(); restarted.setOnline(false);
    expect(restarted.getCachedUri(ID)).toBe(a); expect(restarted.getCachedUri(ID2)).toBeNull();
    expect(cache.cacheDir.list().some(f => /orphan|\.part$/.test(f.name))).toBe(false);
  });
  test('valid JSON metadata corruption is detected by the snapshot checksum', async () => {
    await cache.getOrFetch(ID, descriptor());
    for (const f of cache.cacheDir.list().filter(f => f.name.endsWith('.json'))) {
      const e = JSON.parse(await f.text()); e.data = e.data.replace(HASH, 'b'.repeat(64)); f.write(JSON.stringify(e));
    }
    const restarted = new AudioCache(options()); await restarted.init(); restarted.setOnline(false); expect(restarted.getCachedUri(ID)).toBeNull();
  });
  test('legacy track-only manifest is quarantined even with same length and hash metadata', async () => {
    const f = new MockFile(cache.cacheDir, 'legacy.mp3'); f.write('audio');
    cache.manifestFile.write(JSON.stringify({ [ID]: { uri:f.uri,size:5000,contentVersion:HASH } }));
    const restarted = new AudioCache(options()); await restarted.init(); restarted.setOnline(false); expect(restarted.getCachedUri(ID)).toBeNull();
  });
  test.each(['logout','server','user','foreground'])('generation switch during asynchronous verification cannot publish (%s)', async mode => {
    const gate = deferred(), original = MockFile.prototype.text;
    jest.spyOn(MockFile.prototype,'text').mockImplementation(async function () {await gate.promise; return original.call(this);});
    const job = cache.getOrFetch(ID,descriptor()); job.catch(()=>{}); await ticks();
    if(mode === 'logout') {valid = false; cache.revoke();} else if(mode === 'server') session={...session,origin:'https://other.test',generation:2};
    else if(mode === 'user') session={...session,userId:'99',generation:2}; else cache.setForeground(false);
    gate.resolve(); await expect(job).rejects.toThrow(); await job.settled;
    expect(Object.keys(cache.manifest)).toHaveLength(0); expect(cache.cacheDir.list().filter(f=>/^index-.*\.json$/.test(f.name))).toHaveLength(0);
  });
  test('cancel during async manifest staging never renames it into a commit', async () => {
    const gate=deferred(), original=MockFile.prototype.move;
    jest.spyOn(MockFile.prototype,'move').mockImplementation(async function(dest) { if(dest.name.startsWith('index-')) await gate.promise; return original.call(this,dest); });
    const job=cache.getOrFetch(ID,descriptor()); job.catch(()=>{}); await ticks(); cache.cancel(ID); gate.resolve(); await expect(job).rejects.toThrow(); await job.settled;
    expect(Object.keys(cache.manifest)).toHaveLength(0);
  });
  test('late native completion after cancellation retains its slot and discards its bytes', async () => {
    const gate=deferred(); jest.spyOn(MockDownloadTask.prototype,'downloadAsync').mockImplementation(async function(){await gate.promise; mockFs.set(this.destinationFile.uri,{size:5000}); return this.destinationFile;});
    const job=cache.getOrFetch(ID,descriptor()); job.catch(()=>{}); await ticks(); cache.cancel(ID); await expect(job).rejects.toThrow();
    expect(cache.ongoingDownloads.size).toBe(1); gate.resolve(); await job.settled;
    expect(cache.ongoingDownloads.size).toBe(0); expect(cache.tempDir.list()).toHaveLength(0); expect(Object.keys(cache.manifest)).toHaveLength(0);
  });
  test('a native stall times out publicly but cannot free its occupied slot before actual completion', async () => {
    jest.useFakeTimers(); const gate=deferred(); jest.spyOn(MockDownloadTask.prototype,'downloadAsync').mockImplementation(()=>gate.promise);
    const job=cache.getOrFetch(ID,descriptor()); job.catch(()=>{}); await ticks(); jest.advanceTimersByTime(15000); await expect(job).rejects.toThrow();
    expect(cache.ongoingDownloads.size).toBe(1); gate.resolve(null); await job.settled; expect(cache.ongoingDownloads.size).toBe(0);
  });
  test('aggregate limit evicts LRU across account namespaces, never exceeds 500 MiB', async () => {
    cache.maxSizeBytes=5000; await cache.getOrFetch(ID,descriptor()); session={...session,userId:'99',generation:2};
    await cache.getOrFetch(ID2,descriptor(ID2)); expect(await cache.getSize()).toBe(5000); expect(Object.values(cache.manifest)[0].userId).toBe('99');
  });
  test('protected cache prevents over-budget admission', async () => {
    cache.maxSizeBytes=5000; cache.setProtectedTrackIds([ID]); await cache.getOrFetch(ID,descriptor());
    await expect(cache.getOrFetch(ID2,descriptor(ID2))).rejects.toThrow(); expect(await cache.getSize()).toBe(5000);
  });
  test('offline cache requires same server/account and an unexpired local session', async () => {
    await cache.getOrFetch(ID,descriptor()); cache.setOnline(false); expect(cache.getCachedUri(ID)).toBeTruthy();
    valid=false; expect(cache.getCachedUri(ID)).toBeNull(); valid=true;
    session={...session,userId:'99'}; expect(cache.getCachedUri(ID)).toBeNull(); session={...session,userId:'17',origin:'https://other.test'}; expect(cache.getCachedUri(ID)).toBeNull();
  });
  test('a cache miss skips the metadata round trip and an existing file still requires proof', async () => {
    const metadata = jest.spyOn(require('../../shared/api/api'), 'authFetch')
      .mockResolvedValue({ ok: true, json: async () => ({ content_version: HASH }) });
    await cache.prepareTrack({ id: ID });
    expect(metadata).not.toHaveBeenCalled();
    const uri = await cache.getOrFetch(ID, descriptor());
    cache.setOnline(false);
    cache.setOnline(true);
    await cache.prepareTrack({ id: ID });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(cache.getCachedUri(ID)).toBe(uri);
  });
  test.each([
    ['matching', {}, true],
    ['changed version', { contentVersion: 'b'.repeat(64) }, false],
    ['different length', { contentLength: 17 }, false],
    ['expired proof', { reuseUntil: 0 }, false],
    ['another session', { session: { origin: 'https://api.test', userId: '17', generation: 2 } }, false],
  ])('the playback ticket revalidates stale cache bytes without a metadata request (%s)', async (_name, changes, hit) => {
    const uri = await cache.getOrFetch(ID, descriptor());
    cache.revoke();
    const fetch = jest.spyOn(require('../../shared/api/api'), 'authFetch');
    const resolveTicket = jest.fn(async () => descriptor(ID, { usableUntil: performance.now() + 60000, ...changes }));
    const selected = await cache.prepareTrack({ id: ID }, { resolveTicket });
    expect(resolveTicket).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(selected || null).toBe(hit ? uri : null);
    expect(cache.getCachedUri(ID)).toBe(hit ? uri : null);
  });

  test('reconnect blocks offline bytes until authenticated metadata revalidation', async () => {
    await cache.getOrFetch(ID,descriptor()); cache.setOnline(false); expect(cache.getCachedUri(ID)).toBeTruthy();
    cache.setOnline(true); expect(cache.getCachedUri(ID)).toBeNull();
  });
  test.each([401,403,404,410,412,416,429,500,503])('structured status classifier does not parse a localized message (%i)', status => {
    const e=httpError(status); e.message='localized https://media.puuk.fun/?md5=secret'; const c=classifyDownloadError(e); expect(c.statusCode ?? c.status).toBe(status);
  });
});

describe('additional publication/capacity faults',()=>{
 test('direct conditional GET ignores stale Authorization/Cookie header objects',async()=>{
  await cache.getOrFetch(ID,descriptor(ID,{headers:{Authorization:'CANARY',Cookie:'CANARY'}}));expect(mockActiveDownloadTasks[0].options.headers).toEqual({'If-Match':`"sha256-${HASH}"`});
 });
 test('manifest write failure cannot expose admitted bytes or destroy prior snapshot',async()=>{
  const uri=await cache.getOrFetch(ID,descriptor());const original=MockFile.prototype.write;
  jest.spyOn(MockFile.prototype,'write').mockImplementation(function(value){if(this.name.startsWith('index-'))throw new Error('disk full');return original.call(this,value);});
  await expect(cache.getOrFetch(ID2,descriptor(ID2))).rejects.toThrow();expect(cache.getCachedUri(ID)).toBe(uri);expect(cache.getCachedUri(ID2)).toBeNull();
 });
 test('crash before snapshot publication leaves an orphan that restart cleans',async()=>{
  const f=new MockFile(cache.cacheDir,'object-crash.mp3');f.write('bytes');const snapshot=new MockFile(cache.tempDir,'index-pending.part');snapshot.write('{"format":1');
  const restarted=new AudioCache(options());await restarted.init();restarted.setOnline(false);expect(restarted.getCachedUri(ID)).toBeNull();expect(f.exists).toBe(false);expect(snapshot.exists).toBe(false);
 });
 test('async audio move failure discards temp, final and manifest entry',async()=>{
  jest.spyOn(MockFile.prototype,'move').mockRejectedValue(new Error('move failed'));await expect(cache.getOrFetch(ID,descriptor())).rejects.toThrow();expect(cache.tempDir.list()).toHaveLength(0);expect(Object.keys(cache.manifest)).toHaveLength(0);
 });
 test('two downloads reserve aggregate bytes before any native IO',async()=>{
  cache.maxSizeBytes=5000;const gate=deferred();jest.spyOn(MockDownloadTask.prototype,'downloadAsync').mockImplementation(()=>gate.promise);
  const first=cache.getOrFetch(ID,descriptor());first.catch(()=>{});await ticks();await expect(cache.getOrFetch(ID2,descriptor(ID2))).rejects.toThrow();expect(mockActiveDownloadTasks).toHaveLength(1);expect(cache.reservedBytes).toBe(5000);gate.resolve(null);await expect(first).rejects.toThrow();await first.settled;expect(cache.reservedBytes).toBe(0);
 });
 test('account change while audio move awaits cannot commit into either namespace',async()=>{
  const gate=deferred(),original=MockFile.prototype.move;
  jest.spyOn(MockFile.prototype,'move').mockImplementation(async function(dest){if(dest.name.startsWith('object-'))await gate.promise;return original.call(this,dest);});
  const job=cache.getOrFetch(ID,descriptor());job.catch(()=>{});await ticks();session={...session,userId:'99',generation:2};gate.resolve();await expect(job).rejects.toThrow();await job.settled;expect(Object.keys(cache.manifest)).toHaveLength(0);expect(cache.getCachedUri(ID)).toBeNull();
 });
});

describe('ordinary cache clearing', () => {
  test('preserves a file that fails to delete, frees its neighbor, and retries only the remaining file', async () => {
    const blockedUri = await cache.getOrFetch(ID, descriptor());
    const removableUri = await cache.getOrFetch(ID2, descriptor(ID2));
    const originalDelete = MockFile.prototype.delete;
    const deleteFile = jest.spyOn(MockFile.prototype, 'delete').mockImplementation(function () {
      if (this.uri === blockedUri) throw new Error('simulated filesystem delete failure');
      return originalDelete.call(this);
    });
    cache.setOnline(false);

    await expect(cache.clear()).resolves.toEqual({ freedBytes: 5000, failedFiles: 1 });
    expect(deleteFile.mock.contexts.map(file => file.uri)).toEqual([blockedUri, removableUri]);
    expect(cache.getCachedUri(ID)).toBe(blockedUri);
    expect(cache.getCachedUri(ID2)).toBeNull();
    expect(mockFs.has(removableUri)).toBe(false);
    expect(cache.budgetFiles().get(blockedUri)).toBe(5000);
    expect(cache.budgetFiles().has(removableUri)).toBe(false);
    await expect(cache.getSize()).resolves.toBe(5000);

    const restarted = new AudioCache(options());
    await restarted.init();
    restarted.setOnline(false);
    expect(restarted.getCachedUri(ID)).toBe(blockedUri);
    expect(restarted.getCachedUri(ID2)).toBeNull();

    deleteFile.mockClear();
    await expect(restarted.clear()).resolves.toEqual({ freedBytes: 0, failedFiles: 1 });
    expect(deleteFile.mock.contexts.map(file => file.uri)).toEqual([blockedUri]);
    deleteFile.mockRestore();
    await expect(restarted.clear()).resolves.toEqual({ freedBytes: 5000, failedFiles: 0 });
    expect(restarted.budgetFiles().has(blockedUri)).toBe(false);
    await expect(restarted.getSize()).resolves.toBe(0);
    await expect(restarted.clear()).resolves.toEqual({ freedBytes: 0, failedFiles: 0 });
  });

  test.each(['borrowed', 'active'])('skips a %s file until it is released', async protection => {
    const retainedUri = await cache.getOrFetch(ID, descriptor());
    let borrow;
    if (protection === 'borrowed') {
      borrow = cache.borrowVersion(session, ID, HASH);
      expect(borrow.file.uri).toBe(retainedUri);
    } else {
      cache.setActiveTrackId(ID);
    }
    const deleteFile = jest.spyOn(MockFile.prototype, 'delete');

    await expect(cache.clear()).resolves.toEqual({ freedBytes: 0, failedFiles: 0 });
    expect(deleteFile).not.toHaveBeenCalled();
    expect(cache.budgetFiles().get(retainedUri)).toBe(5000);

    borrow?.release();
    cache.setActiveTrackId(null);
    await expect(cache.clear()).resolves.toEqual({ freedBytes: 5000, failedFiles: 0 });
  });

  test('budget eviction stays best effort and checks the target against bytes actually freed', async () => {
    const blockedUri = await cache.getOrFetch(ID, descriptor());
    const removableUri = await cache.getOrFetch(ID2, descriptor(ID2));
    const originalDelete = MockFile.prototype.delete;
    jest.spyOn(MockFile.prototype, 'delete').mockImplementation(function () {
      if (this.uri === blockedUri) throw new Error('simulated filesystem delete failure');
      return originalDelete.call(this);
    });

    await expect(cache.evictForBudget(bytes => bytes >= 5000, { clear: true })).resolves.toBeUndefined();
    expect(cache.budgetFiles().get(blockedUri)).toBe(5000);
    expect(cache.budgetFiles().has(removableUri)).toBe(false);
  });
});
