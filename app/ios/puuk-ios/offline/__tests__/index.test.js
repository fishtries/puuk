import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { getSettings, updateSetting } from '../../shared/storage/settings';
import {
  enforceStorageBudget, readStorageBudget, setBudgetCache, updateNativeTransferProgress,
} from '../budget';
import { readOfflineWaveStatus, readWaveQueue, saveWaveQueue, selectLocalWaveTracks, startOfflineWave, WAVE_REASON } from '../wave';
import { listRetentionReasons, reconcileRetention, setRetentionReason } from '../collections';
import { setLocalRating } from '../outbox/runtime';
import { offlineDatabase } from '../storage';
import { fetch as downloadFetch } from 'expo/fetch';
import { mediaDelivery } from '../../shared/api/media';
import { saveFavoriteOffline } from '../foreground';
import { PlaybackCoordinator } from '../../utils/playbackCoordinator';
import {
  acquirePlayable,
  cleanupUnretainedMedia,
  attachNativeTask,
  FAVORITES_COLLECTION,
  getOfflineSession,
  listDownloadJobs,
  markMissing,
  publishVerifiedDownload,
  queueDownload,
  readCollection,
  readFavoriteDownloads,
  readLyrics,
  readMediaKey,
  readPlayableIds,
  reconcileTransfers,
  reserveTransfer,
  retryMediaCleanup,
  saveCollection,
  saveDownloadSchedule,
  saveLyricsResult,
} from '..';
import {
  closeOfflineSession,
  openOfflineSession,
  persistOfflineActivation,
  revokeOfflineActivation,
} from '../session';

const mockFiles = new Map();
let mockNextId = 0;
let mockFailMediaCommit = false;
let mockReopenDatabase;
let mockDisposeDatabase;

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

jest.mock('expo-crypto', () => ({
  randomUUID: () => (++mockNextId).toString(16),
}));
jest.mock('expo-file-system', () => {
  const join = (...parts) => parts.map((p) => p?.uri || p).join('/');
  return {
    FileMode: { WriteOnly: 'w' },
    Paths: {
      document: `file:///test-${process.pid}`,
      availableDiskSpace: 2 ** 31,
    },
    Directory: class {
      constructor(...parts) {
        this.uri = join(...parts);
      }
      create() {}
      get exists() { return true; }
      list() {
        return [...mockFiles.keys()]
          .filter(uri => uri.startsWith(this.uri + '/') && !uri.slice(this.uri.length + 1).includes('/'))
          .map(uri => new (jest.requireMock('expo-file-system').File)(uri));
      }
    },
    File: class {
      constructor(...parts) {
        this.uri = join(...parts);
      }
      create() {
        mockFiles.set(this.uri, 0);
      }
      open() {
        return {
          close() {},
          writeBytes: async (bytes) =>
            mockFiles.set(this.uri, this.size + bytes.byteLength),
        };
      }
      get name() { return this.uri.split('/').pop(); }
      get exists() {
        return mockFiles.has(this.uri);
      }
      get size() {
        return mockFiles.get(this.uri);
      }
      delete() {
        mockFiles.delete(this.uri);
      }
      moveSync(destination) {
        if (mockFiles.has(destination.uri)) throw Error('File already exists');
        mockFiles.set(destination.uri, this.size);
        this.delete();
        this.uri = destination.uri;
      }
    },
  };
});

jest.mock('expo-sqlite', () => ({
  async openDatabaseAsync() {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const fs = process.getBuiltinModule('node:fs');
    const { join } = process.getBuiltinModule('node:path');
    const { tmpdir } = process.getBuiltinModule('node:os');
    const directory = fs.mkdtempSync(join(tmpdir(), 'puuk-offline-jest-'));
    const path = join(directory, 'index.sqlite');
    let db = new DatabaseSync(path);
    mockReopenDatabase = () => {
      db.close();
      db = new DatabaseSync(path);
    };
    mockDisposeDatabase = () => {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    };
    const transaction = (work) => {
      db.exec('BEGIN');
      try {
        work();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    };
    return {
      withTransactionSync: transaction,
      async withTransactionAsync(work) {
        transaction(work);
      },
      async execAsync(sql) {
        db.exec(sql);
      },
      async getAllAsync(sql, ...params) {
        return db.prepare(sql).all(...params);
      },
      async getFirstAsync(sql, ...params) {
        return db.prepare(sql).get(...params) || null;
      },
      async runAsync(sql, ...params) {
        return db.prepare(sql).run(...params);
      },
      execSync: (sql) => db.exec(sql),
      getFirstSync: (sql, ...params) => db.prepare(sql).get(...params) || null,
      getAllSync: (sql, ...params) => db.prepare(sql).all(...params),
      runSync(sql, ...params) {
        if (
          mockFailMediaCommit &&
          sql.startsWith('INSERT OR REPLACE INTO media')
        ) {
          mockFailMediaCommit = false;
          throw Error('Injected failure after rename');
        }
        return db.prepare(sql).run(...params);
      },
    };
  },
}));

const version = 'a'.repeat(64);
const track = {
  id: '17',
  title: 'Test song',
  artist: 'Test artist',
  stream_url: 'https://example.test/private?mt=secret',
};
const owner = { origin: 'https://first.test', userId: '10' };

async function login(activationId, user = owner, generation = 1) {
  closeOfflineSession();
  const session = { owner: user, activationId, generation };
  await persistOfflineActivation(session);
  expect(
    await openOfflineSession(
      session,
      Date.now() + 60_000,
      () => true,
      jest.fn(),
    ),
  ).toBe(true);
  return getOfflineSession();
}
async function reserve(
  session,
  reason = 'foreground-favorites',
  targetVersion = version,
) {
  const { jobId } = await queueDownload(session, track.id, reason);
  const attempt = await reserveTransfer(session, jobId, {
    trackId: track.id,
    track,
    contentVersion: targetVersion,
    contentLength: 512,
  });
  mockFiles.set(attempt.stagingUri, 512);
  return {
    ...attempt,
    receipt: {
      status: 200,
      bytes: 512,
      sha256: targetVersion,
      stagingPath: attempt.stagingPath,
    },
  };
}

afterEach(() => closeOfflineSession());
afterAll(() => mockDisposeDatabase?.());

test('opens a saved favorite and version-bound lyrics after restoring the same activation', async () => {
  const session = await login('a');
  await saveCollection(session, FAVORITES_COLLECTION, {
    title: 'Favorites',
    tracks: [track, track],
  });
  const transfer = await reserve(session);
  const key = await publishVerifiedDownload(session, transfer);
  expect(key).toEqual({ owner, trackId: track.id, contentVersion: version });
  await saveLyricsResult(session, key, {
    state: 'ready',
    payload: { lyrics: '[00:00]Line' },
  });
  await saveLyricsResult(session, key, { state: 'unknown' });

  closeOfflineSession();
  expect(await acquirePlayable(session, track.id)).toBeNull();
  const restored = { ...session, generation: 2 };
  expect(
    await openOfflineSession(
      restored,
      Date.now() + 60_000,
      () => true,
      jest.fn(),
    ),
  ).toBe(true);
  const snapshot = await readCollection(restored, FAVORITES_COLLECTION);
  expect(snapshot.tracks.map(({ id }) => id)).toEqual([track.id, track.id]);
  expect(JSON.stringify(snapshot)).not.toContain('secret');
  const playable = await acquirePlayable(restored, snapshot.tracks[0].id);
  expect(playable.uri).toMatch(/^file:.*\/media\//);
  expect(await readLyrics(restored, playable.mediaKey)).toMatchObject({
    state: 'ready',
  });
  playable.release();
  mockFiles.delete(playable.uri);
  expect(await acquirePlayable(restored, track.id)).toBeNull();
  expect(await readFavoriteDownloads(restored)).toMatchObject({
    queued: [track.id],
  });
});

test('fences old operations across owners and repeated login to the same account', async () => {
  const first = await login('first');
  const transfer = await reserve(first, 'native');
  const other = await login(
    'other',
    { ...owner, origin: 'https://second.test' },
    2,
  );
  expect(await readCollection(other, FAVORITES_COLLECTION)).toBeNull();
  expect(await publishVerifiedDownload(other, transfer)).toBeNull();
  const sameOwner = await login('again', owner, 3);
  expect(await publishVerifiedDownload(first, transfer)).toBeNull();
  expect(await publishVerifiedDownload(sameOwner, transfer)).toBeNull();
  expect(
    await attachNativeTask(first, transfer.jobId, transfer.operationId, {
      nativeSessionId: 's',
      nativeTaskId: 't',
    }),
  ).toBe(false);
  await revokeOfflineActivation(sameOwner);
  closeOfflineSession();
  expect(
    await openOfflineSession(
      sameOwner,
      Date.now() + 60_000,
      () => true,
      jest.fn(),
    ),
  ).toBe(false);
});

test('validates the receipt and reconciles interrupted native work separately from foreground saves', async () => {
  const session = await login('jobs', { ...owner, userId: '82' });
  const foreground = await reserve(session);
  const native = await reserve(session, 'native', 'b'.repeat(64));
  expect(
    await publishVerifiedDownload(session, {
      ...native,
      receipt: { ...native.receipt, status: 206 },
    }),
  ).toBeNull();
  await saveDownloadSchedule(session, {
    jobId: native.jobId,
    state: 'retry',
    attempt: 1,
    nextAttemptAt: 5,
    handledOperation: native.operationId,
  });
  await reconcileTransfers(session, { backgroundOnly: true });
  expect(mockFiles.has(foreground.stagingUri)).toBe(true);
  expect(mockFiles.has(native.stagingUri)).toBe(false);
  expect(await listDownloadJobs(session)).toEqual([
    expect.objectContaining({
      jobId: native.jobId,
      state: 'retry',
      attempt: 1,
      handledOperation: native.operationId,
    }),
  ]);
  expect(await publishVerifiedDownload(session, native)).toBeNull();
  expect(await publishVerifiedDownload(session, foreground)).toBeNull();
});

test('cancelled scheduling fences a failed publication journal and preserves other saved audio', async () => {
  const session = await login('cancel-native', { ...owner, userId: '83' });
  const foreground = await reserve(session);
  expect(await publishVerifiedDownload(session, foreground)).not.toBeNull();
  const native = await reserve(session, 'native', 'b'.repeat(64));
  mockFailMediaCommit = true;
  await expect(publishVerifiedDownload(session, native)).rejects.toThrow(
    'Injected failure after rename',
  );
  expect(
    await saveDownloadSchedule(session, {
      jobId: native.jobId,
      state: 'cancelled',
      attempt: 0,
      nextAttemptAt: 0,
    }),
  ).toBe(true);
  expect(await publishVerifiedDownload(session, native)).toBeNull();
  await reconcileTransfers(session, { backgroundOnly: true });
  expect(await listDownloadJobs(session)).toEqual([
    expect.objectContaining({
      jobId: native.jobId,
      state: 'cancelled',
      operationId: null,
    }),
  ]);
  const playable = await acquirePlayable(session, track.id, version);
  expect(playable).not.toBeNull();
  playable.release();
});

test('Favorites data reaches native play before ticket, cache proof, or artwork requests', async () => {
  const session = await login('play', { ...owner, userId: 'play' });
  await saveCollection(session, FAVORITES_COLLECTION, {
    title: 'Favorites',
    tracks: [track],
  });
  await publishVerifiedDownload(session, await reserve(session));

  const resolveMedia = jest.fn(async () => ({
    uri: 'https://first.test/api/stream/17',
    headers: {},
    delivery: 'direct',
    usableUntil: Infinity,
    reuseUntil: Infinity,
  }));
  const cache = {
    getCachedUri: jest.fn(() => null),
    prepareTrack: jest.fn(async () => {}),
  };
  const coordinator = new PlaybackCoordinator({
    serverUrl: owner.origin,
    resolveMedia,
    cache,
    scheduler: { addListener: () => () => {}, cancelAll() {} },
  });
  const player = { replace: jest.fn(), play: jest.fn(), pause: jest.fn() };
  const artwork = jest.spyOn(coordinator, 'updateLockScreenMetadata');
  try {
    const snapshot = await readCollection(session, FAVORITES_COLLECTION);
    const direct = await coordinator.play(player, snapshot.tracks[0]);
    expect(direct.isLocal).toBe(true);
    expect(resolveMedia).not.toHaveBeenCalled();
    expect(cache.prepareTrack).not.toHaveBeenCalled();
    expect(artwork).not.toHaveBeenCalled();
    expect(player.replace).toHaveBeenCalledWith({ uri: direct.uri });
    expect(player.play).toHaveBeenCalled();

    mockFiles.delete(direct.uri);
    coordinator.cancelCurrent('dismiss', player);
    const fallback = await coordinator.play(player, snapshot.tracks[0], {
      cacheCurrent: false,
    });
    expect(fallback.isLocal).toBe(false);
    expect(resolveMedia).toHaveBeenCalledTimes(1);
    expect(cache.prepareTrack).toHaveBeenCalledTimes(1);
  } finally {
    coordinator.destroy();
  }
});

test('recovers when the asset was renamed before the SQLite publication committed', async () => {
  const session = await login('interrupted', {
    ...owner,
    userId: 'interrupted',
  });
  const transfer = await reserve(session);
  mockFailMediaCommit = true;
  await expect(publishVerifiedDownload(session, transfer)).rejects.toThrow(
    'Injected failure after rename',
  );
  expect(mockFiles.has(transfer.stagingUri)).toBe(false);
  expect(await acquirePlayable(session, track.id)).toBeNull();

  closeOfflineSession();
  const restored = { ...session, generation: 2 };
  await openOfflineSession(
    restored,
    Date.now() + 60_000,
    () => true,
    jest.fn(),
  );
  await reconcileTransfers(restored, { foregroundOnly: true });
  const playable = await acquirePlayable(restored, track.id);
  expect(playable?.mediaKey.contentVersion).toBe(version);
  playable.release();
});

test('foreground direct GET binds the ticket and publishes only the verified downloaded bytes', async () => {
  const originalAppState = AppState.currentState;
  AppState.currentState = 'active';
  const session = await login('foreground', { ...owner, userId: 'foreground' });
  const song = { ...track, id: '5d280213-cab5-451c-9730-323f459e9a28' };
  const uri = `${owner.origin}/api/stream/${song.id}?mt=a.b.c`;
  const contentVersion =
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const resolver = jest.spyOn(mediaDelivery, 'resolve').mockResolvedValue({
    uri,
    trackId: song.id,
    legacy: false,
    contentVersion,
    contentLength: 3,
    downloadBinding: 'if-match',
  });
  const response = (lastByte) => ({
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: jest
          .fn()
          .mockResolvedValueOnce({
            value: Uint8Array.of(97, 98, lastByte),
            done: false,
          })
          .mockResolvedValueOnce({ done: true }),
        cancel: jest.fn(async () => {}),
      }),
    },
  });
  downloadFetch
    .mockResolvedValueOnce(response(100))
    .mockResolvedValueOnce(response(99));
  try {
    await expect(saveFavoriteOffline(session, song)).resolves.toBeNull();
    expect(await acquirePlayable(session, song.id)).toBeNull();
    await expect(saveFavoriteOffline(session, song)).resolves.toMatchObject({
      contentVersion,
    });
    expect(downloadFetch).toHaveBeenCalledWith(
      uri,
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        headers: {
          'If-Match': `"sha256-${contentVersion}"`,
          'Accept-Encoding': 'identity',
        },
      }),
    );
    const playable = await acquirePlayable(session, song.id);
    expect(playable?.mediaKey.contentVersion).toBe(contentVersion);
    playable.release();
  } finally {
    resolver.mockRestore();
    AppState.currentState = originalAppState;
  }
});

test('cancellation checks durable retention and pending like in the same transaction', async () => {
  const { offlineDatabase } = require('../storage');
  const db = await offlineDatabase();
  await db.execAsync(`CREATE TABLE IF NOT EXISTS retention_reason (owner TEXT, track_id TEXT, kind TEXT, id TEXT, track TEXT, PRIMARY KEY(owner,track_id,kind,id));
    CREATE TABLE IF NOT EXISTS outbox_rating (owner TEXT, track_id TEXT, operation_id TEXT, rating TEXT, revision INTEGER, state TEXT, PRIMARY KEY(owner,track_id));`);
  const session = await login('cancel-guard');
  const ownerId = JSON.stringify([owner.origin, owner.userId]);
  const { jobId } = await queueDownload(session, track.id, 'playlist:a');
  const cancel = () =>
    saveDownloadSchedule(session, {
      jobId,
      state: 'cancelled',
      attempt: 0,
      nextAttemptAt: 0,
    });
  db.runSync(
    'INSERT OR REPLACE INTO retention_reason VALUES (?,?,?,?,?)',
    ownerId,
    track.id,
    'playlist',
    'a',
    null,
  );
  expect(await cancel()).toBe(false);
  db.runSync(
    'DELETE FROM retention_reason WHERE owner=? AND track_id=?',
    ownerId,
    track.id,
  );
  db.runSync(
    'INSERT OR REPLACE INTO outbox_rating VALUES (?,?,?,?,?,?)',
    ownerId,
    track.id,
    'op',
    'like',
    1,
    'pending',
  );
  expect(await cancel()).toBe(false);
  db.runSync(
    'DELETE FROM outbox_rating WHERE owner=? AND track_id=?',
    ownerId,
    track.id,
  );
  expect(await cancel()).toBe(true);
  db.runSync(
    'INSERT OR REPLACE INTO outbox_rating VALUES (?,?,?,?,?,?)',
    ownerId,
    track.id,
    'op2',
    'like',
    2,
    'pending',
  );
  expect(
    (await listDownloadJobs(session)).find((job) => job.jobId === jobId).state,
  ).toBe('cancelled');
});

test('cleanup protects a player lease and durable pending like', async () => {
  const { offlineDatabase } = require('../storage');
  const db = await offlineDatabase();
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS outbox_rating (owner TEXT, track_id TEXT, operation_id TEXT, rating TEXT, revision INTEGER, state TEXT, PRIMARY KEY(owner,track_id));`,
  );
  const user = { origin: 'https://cleanup.test', userId: '99' };
  const ownerId = JSON.stringify([user.origin, user.userId]);
  const session = await login('cleanup', user);
  const transfer = await reserve(session, 'playlist:test');
  await publishVerifiedDownload(session, transfer);
  const playable = await acquirePlayable(session, track.id);
  expect(await cleanupUnretainedMedia(session, track.id)).toBe(false);
  playable.release();
  db.runSync(
    'INSERT INTO outbox_rating VALUES (?,?,?,?,?,?)',
    ownerId,
    track.id,
    'op',
    'like',
    1,
    'pending',
  );
  expect(await cleanupUnretainedMedia(session, track.id)).toBe(false);
  const stillPlayable = await acquirePlayable(session, track.id);
  expect(stillPlayable).not.toBeNull();
  stillPlayable.release();
  db.runSync(
    'DELETE FROM outbox_rating WHERE owner=? AND track_id=?',
    ownerId,
    track.id,
  );
  expect(await cleanupUnretainedMedia(session, track.id)).toBe(true);
  expect(await acquirePlayable(session, track.id)).toBeNull();
});

test('a changed desired version does not count an old file as ready and requeues its ready job', async () => {
  const { offlineDatabase } = require('../storage');
  const db = await offlineDatabase();
  const user = { origin: 'https://version.test', userId: '2' };
  const ownerId = JSON.stringify([user.origin, user.userId]);
  const session = await login('desired-version', user);
  const transfer = await reserve(session, 'playlist:test');
  await publishVerifiedDownload(session, transfer);
  db.runSync(
    'UPDATE track_version SET desired_version=? WHERE owner=? AND track_id=?',
    'b'.repeat(64),
    ownerId,
    track.id,
  );
  expect(await acquirePlayable(session, track.id)).toBeNull();
  const { jobId } = await queueDownload(session, track.id, 'playlist:test');
  expect(
    (await listDownloadJobs(session)).find((job) => job.jobId === jobId).state,
  ).toBe('queued');
});

test('version confirmation fences delayed probes and requeues the ready job', async () => {
  const {
    captureDesiredVersion,
    confirmDesiredVersion,
    readMediaKey,
  } = require('..');
  const { offlineDatabase } = require('../storage');
  const db = await offlineDatabase();
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS retention_reason (owner TEXT, track_id TEXT, kind TEXT, id TEXT, track TEXT, PRIMARY KEY(owner,track_id,kind,id))',
  );
  const user = { origin: 'https://probe.test', userId: 'probe' };
  const session = await login('probe-version', user);
  const transfer = await reserve(session, 'playlist:probe');
  await publishVerifiedDownload(session, transfer);
  db.runSync(
    'INSERT OR REPLACE INTO retention_reason VALUES (?,?,?,?,?)',
    JSON.stringify([user.origin, user.userId]),
    track.id,
    'playlist',
    'probe',
    null,
  );
  const expected = await captureDesiredVersion(session, track.id);
  const lease = await acquirePlayable(session, track.id);
  expect(
    await confirmDesiredVersion(session, track.id, expected, 'b'.repeat(64)),
  ).toBe(true);
  expect(
    await confirmDesiredVersion(session, track.id, expected, 'c'.repeat(64)),
  ).toBe(false);
  expect(await readMediaKey(session, track.id)).toBeNull();
  expect(mockFiles.has(lease.uri)).toBe(true);
  const { jobId } = await queueDownload(session, track.id, 'playlist:probe');
  expect(
    (await listDownloadJobs(session)).find((job) => job.jobId === jobId).state,
  ).toBe('queued');
  lease.release();
});

test('deferred cleanup retries when the player releases its lease', async () => {
  const session = await login('lease-retry', {
    origin: 'https://lease.test',
    userId: '1',
  });
  await publishVerifiedDownload(
    session,
    await reserve(session, 'playlist:lease'),
  );
  const lease = await acquirePlayable(session, track.id);
  expect(await cleanupUnretainedMedia(session, track.id)).toBe(false);
  lease.release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  expect(mockFiles.has(lease.uri)).toBe(false);
});

test.each(['throws', 'returns false', 'is deferred', 'is missing'])('invalidated media keeps its bytes when native unload %s', async (failure) => {
  const session = await login('missing-' + failure, { ...owner, userId: 'missing-' + failure });
  const before = await readStorageBudget(session);
  const key = await publishTrack(session, track);
  const coordinator = new PlaybackCoordinator({
    serverUrl: owner.origin,
    cache: {},
    scheduler: { addListener: () => () => {}, cancelAll() {} },
  });
  const replace = jest.fn();
  const player = { replace, play: jest.fn(), pause: jest.fn() };
  try {
    const { isLocal, uri } = await coordinator.play(player, track);
    expect(isLocal).toBe(true);
    expect(await markMissing(session, key, 'native_source_failed')).toBe(true);
    expect(await acquirePlayable(session, track.id)).toBeNull();
    if (failure === 'throws') replace.mockImplementationOnce(() => { throw Error('native busy'); });
    if (failure === 'returns false') replace.mockReturnValueOnce(false);
    if (failure === 'is deferred') replace.mockRejectedValueOnce(Error('native busy'));
    if (failure === 'is missing') delete player.replace;
    coordinator.cancelCurrent('dismiss', player);
    await retryMediaCleanup(session);
    expect(mockFiles.has(uri)).toBe(true);
    expect((await readStorageBudget(session)).accountedBytes).toBe(before.accountedBytes + 512);

    player.replace = replace;
    coordinator.cancelCurrent('dismiss', player);
    await new Promise(resolve => setImmediate(resolve));
    expect(mockFiles.has(uri)).toBe(false);
    expect((await readStorageBudget(session)).accountedBytes).toBe(before.accountedBytes);
  } finally {
    player.replace = replace;
    coordinator.destroy();
  }
});

test('startup retention reconciliation retires an invalidated file after a failed delete', async () => {
  const session = await login('missing-restart', { ...owner, userId: 'missing-restart' });
  const before = await readStorageBudget(session);
  const key = await publishTrack(session, track);
  const lease = await acquirePlayable(session, track.id);
  const deleteFile = File.prototype.delete;
  const remove = jest.spyOn(File.prototype, 'delete').mockImplementation(function () {
    if (this.uri === lease.uri) throw Error('temporary delete failure');
    return deleteFile.call(this);
  });
  try {
    expect(await markMissing(session, key, 'native_source_failed')).toBe(true);
    lease.release();
    await retryMediaCleanup(session);
    expect(remove.mock.instances.some(file => file.uri === lease.uri)).toBe(true);
    expect(mockFiles.has(lease.uri)).toBe(true);
  } finally {
    lease.release();
    remove.mockRestore();
  }
  closeOfflineSession();
  mockReopenDatabase();
  const restored = await login(session.activationId, session.owner, 2);
  expect(await acquirePlayable(restored, track.id)).toBeNull();
  expect(await reconcileRetention(restored)).toBe(true);
  expect(mockFiles.has(lease.uri)).toBe(false);
  expect((await readStorageBudget(restored)).accountedBytes).toBe(before.accountedBytes);
});

test('deferred cleanup waits for publication and retries after transfer reset', async () => {
  const { resetTransfer } = require('..');
  const session = await login('transfer-retry', {
    origin: 'https://transfer.test',
    userId: '1',
  });
  await publishVerifiedDownload(
    session,
    await reserve(session, 'playlist:transfer'),
  );
  const lease = await acquirePlayable(session, track.id);
  lease.release();
  const next = await reserve(session, 'playlist:transfer', 'b'.repeat(64));
  expect(await cleanupUnretainedMedia(session, track.id)).toBe(false);
  expect(mockFiles.has(lease.uri)).toBe(true);
  await resetTransfer(session, next.jobId, next.operationId);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  expect(mockFiles.has(lease.uri)).toBe(false);
});

test('a durable pending like after cancellation is reconciled on a fresh activation', async () => {
  const { offlineDatabase } = require('../storage');
  const {
    saveOfflineCollection,
    reconcileRetention,
  } = require('../collections');
  const { overlayFavorites } = require('../collections/runtime');
  const downloads = require('../downloads/runtime');
  const enqueue = jest
    .spyOn(downloads, 'enqueueBackgroundDownload')
    .mockResolvedValue({ status: 'queued', jobId: 'new' });
  const db = await offlineDatabase();
  const user = { origin: 'https://like-restart.test', userId: '1' };
  const first = await login('like-before-restart', user);
  const { jobId } = await queueDownload(first, track.id, 'wave');
  expect(
    await saveDownloadSchedule(first, {
      jobId,
      state: 'cancelled',
      attempt: 0,
      nextAttemptAt: 0,
    }),
  ).toBe(true);
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS outbox_rating (owner TEXT, track_id TEXT, operation_id TEXT, rating TEXT, revision INTEGER, state TEXT, PRIMARY KEY(owner,track_id))',
  );
  db.runSync(
    'INSERT OR REPLACE INTO outbox_rating VALUES (?,?,?,?,?,?)',
    JSON.stringify([user.origin, user.userId]),
    track.id,
    'new-like',
    'like',
    1,
    'pending',
  );
  const restored = await login('like-after-restart', user, 2);
  const tracks = overlayFavorites(
    [],
    [{ trackId: track.id, track, rating: 'like', state: 'pending' }],
  );
  expect(
    await saveOfflineCollection(
      restored,
      FAVORITES_COLLECTION,
      { title: 'Favorites', tracks },
      { snapshotTracks: [], replaceSnapshot: true },
    ),
  ).toBe(true);
  await reconcileRetention(restored);
  expect(enqueue).toHaveBeenCalledWith(
    restored,
    expect.objectContaining({ id: track.id }),
    'favorites:favorites',
  );
  enqueue.mockRestore();
});

test('publishing a replacement defers deletion of the old version until its lease ends', async () => {
  const session = await login('replacement-lease', {
    origin: 'https://replacement.test',
    userId: '1',
  });
  await publishVerifiedDownload(
    session,
    await reserve(session, 'playlist:replacement'),
  );
  const old = await acquirePlayable(session, track.id);
  const replacement = await reserve(
    session,
    'playlist:replacement',
    'b'.repeat(64),
  );
  await publishVerifiedDownload(session, replacement);
  await new Promise((resolve) => setImmediate(resolve));
  expect(mockFiles.has(old.uri)).toBe(true);
  old.release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  expect(mockFiles.has(old.uri)).toBe(false);
  const current = await acquirePlayable(session, track.id);
  expect(current.mediaKey.contentVersion).toBe('b'.repeat(64));
  current.release();
});

async function reserveSized(session, dto, contentLength, reason = 'wave:reserve') {
  const { jobId } = await queueDownload(session, dto.id, reason, dto);
  return reserveTransfer(session, jobId, { trackId: dto.id, track: dto, contentVersion: version, contentLength });
}

async function publishTrack(session, dto, bytes = 512, reason) {
  const transfer = await reserveSized(session, dto, bytes, reason);
  mockFiles.set(transfer.stagingUri, bytes);
  return publishVerifiedDownload(session, {
    ...transfer,
    receipt: { status: 200, stagingPath: transfer.stagingPath, bytes, sha256: version },
  });
}

test('aggregate admission serializes two requests for the last bytes and counts partial progress once', async () => {
  const { resetTransfer } = require('..');
  const settings = getSettings();
  const session = await login('budget-race', { origin: 'https://budget.test', userId: '11' });
  const before = await readStorageBudget(session);
  await updateSetting('offlineBudgetBytes', before.accountedBytes + 100);
  try {
    const pair = await Promise.all(['race-a', 'race-b'].map(id => reserveSized(session, { id }, 100)));
    expect(pair.filter(Boolean)).toHaveLength(1);
    const reservation = pair.find(Boolean);
    const admitted = await readStorageBudget(session);
    expect(admitted.accountedBytes).toBe(before.accountedBytes + 100);
    expect(admitted.reservedBytes - before.reservedBytes).toBe(100);

    updateNativeTransferProgress([{ operationId: reservation.operationId, bytesReceived: 40, contentLength: 100 }]);
    const partial = await readStorageBudget(session);
    expect(partial.transferBytes - before.transferBytes).toBe(40);
    expect(partial.reservedBytes - before.reservedBytes).toBe(60);
    expect(partial.accountedBytes).toBe(admitted.accountedBytes);

    mockFiles.set(reservation.stagingUri, 40);
    const staged = await readStorageBudget(session);
    expect(staged.transferBytes).toBe(partial.transferBytes);
    expect(staged.accountedBytes).toBe(admitted.accountedBytes);
    updateNativeTransferProgress([]);
    await resetTransfer(session, reservation.jobId, reservation.operationId);
    expect((await readStorageBudget(session)).accountedBytes).toBe(before.accountedBytes);
  } finally {
    updateNativeTransferProgress([]);
    await updateSetting('offlineBudgetBytes', settings.offlineBudgetBytes);
  }
});

test('physical space and in-process preload reservations constrain admission independently of the user limit', async () => {
  const { reserveCacheTransfer } = require('../budget');
  const { resetTransfer } = require('..');
  const session = await login('disk-limit', { origin: 'https://disk.test', userId: '11' });
  const originalFree = Paths.availableDiskSpace;
  const before = await readStorageBudget(session);
  Paths.availableDiskSpace = originalFree - before.diskAvailableBytes + 100;
  let cached;
  try {
    cached = await reserveCacheTransfer(session, session.owner, 'dedup', version, 75, () => true);
    expect(cached).toBeTruthy();
    cached.recordProgress(20);
    const partial = await readStorageBudget(session);
    expect(partial.transferBytes - before.transferBytes).toBe(20);
    expect(partial.reservedBytes - before.reservedBytes).toBe(55);
    const file = new (require('expo-file-system').File)('file:///ordinary/cache-test.part');
    mockFiles.set(file.uri, 20);
    cached.setFiles(file, new (require('expo-file-system').File)('file:///ordinary/cache-test.mp3'));
    expect((await readStorageBudget(session)).accountedBytes).toBe(partial.accountedBytes);
    mockFiles.delete(file.uri);
    expect(await reserveSized(session, { id: 'dedup' }, 75)).toEqual({ waitingForTransfer: true });
    expect(await reserveSized(session, { id: 'new-track' }, 50)).toBeNull();
    cached.release();
    const admitted = await reserveSized(session, { id: 'new-track' }, 50);
    expect(admitted).toBeTruthy();
    await resetTransfer(session, admitted.jobId, admitted.operationId);
  } finally {
    cached?.release();
    Paths.availableDiskSpace = originalFree;
  }
});

test('limit pressure removes ordinary cache, played and far Wave through retention while preserving shared tracks and leases', async () => {
  const settings = getSettings();
  const session = await login('wave-budget-policy', { origin: 'https://pressure.test', userId: '11' });
  const played = { id: 'played', duration: 120 };
  const far = { id: 'far', duration: 120 };
  const near = { id: 'shared', duration: 120 };
  const current = { id: 'active', duration: 120 };
  for (const dto of [played, far, near, current]) {
    await publishTrack(session, dto);
    await setRetentionReason(session, dto, WAVE_REASON, true);
  }
  await setRetentionReason(session, near, { kind: 'playlist', collectionId: 'saved' }, true);
  const active = await acquirePlayable(session, current.id);
  const lease = await acquirePlayable(session, played.id);
  await saveWaveQueue(session, { current, future: [near, far], history: [played] });
  const ordinary = new Map([['file:///cache/ordinary', 200]]);
  const order = [];
  setBudgetCache({
    files: () => ordinary,
    evict: () => {
      if (ordinary.size) order.push('cache');
      ordinary.clear();
    },
  });
  const stop = startOfflineWave();
  try {
    const before = await readStorageBudget(session);
    await updateSetting('offlineBudgetBytes', before.accountedBytes - 200 - 3 * 512);
    await enforceStorageBudget(session);
    expect(order[0]).toBe('cache');
    expect(await readMediaKey(session, far.id)).toBeNull();
    expect(await readMediaKey(session, near.id)).not.toBeNull();
    expect(await readMediaKey(session, current.id)).not.toBeNull();
    expect(await readMediaKey(session, played.id)).not.toBeNull();
    expect(await listRetentionReasons(session, played.id)).toEqual([]);
    expect((await readStorageBudget(session)).pauseReason).toBe('space');
    const next = { id: 'waiting' };
    const { jobId } = await queueDownload(session, next.id, 'playlist:saved');
    await saveDownloadSchedule(session, { jobId, state: 'space', attempt: 0, nextAttemptAt: 1000 });
    expect((await readStorageBudget(session)).waitingForSpace).toBe(1);

    lease.release();
    await new Promise(resolve => setImmediate(resolve));
    expect(await readMediaKey(session, played.id)).toBeNull();
    await updateSetting('offlineBudgetBytes', before.accountedBytes + 1000);
    expect((await readStorageBudget(session)).overLimitBytes).toBe(0);
    const reopened = await reserveSized(session, next, 50, 'playlist:saved');
    expect(reopened).toHaveProperty('operationId');
    await require('..').resetTransfer(session, reopened.jobId, reopened.operationId);
  } finally {
    stop();
    setBudgetCache(undefined);
    active.release();
    lease.release();
    await updateSetting('offlineBudgetBytes', settings.offlineBudgetBytes);
  }
});

test('collection readiness batches repeated ids and read-only checks leave cleanup idle', async () => {
  const session = await login('batch-ready', { origin: 'https://batch.test', userId: '1' });
  await publishTrack(session, track);
  await new Promise(resolve => setImmediate(resolve));
  const db = await offlineDatabase();
  const reads = jest.spyOn(db, 'getAllSync');
  try {
    const ids = [track.id, ...Array.from({length: 32}, (_, i) => `missing-${i}`), track.id];
    expect(await readPlayableIds(session, ids)).toEqual(new Set([track.id]));
    expect(reads.mock.calls.filter(([sql]) => sql.includes('FROM media m'))).toHaveLength(2);
    expect(await readMediaKey(session, track.id)).toMatchObject({ trackId: track.id });
    await new Promise(resolve => setImmediate(resolve));
    expect(reads.mock.calls.some(([sql]) => sql.includes('media_cleanup'))).toBe(false);
  } finally {
    reads.mockRestore();
  }
});

test('Wave cold restore reopens SQLite, retains exact queue position and excludes S4 pending dislike and recent repeats', async () => {
  const session = await login('wave-cold', { origin: 'https://wave.test', userId: '11' });
  const played = { id: 'past', title: 'Past', duration: 102 };
  const current = { id: 'current', duration: 180 };
  const unread = { id: 'pending-file', duration: 170 };
  const ready = { id: 'upcoming', duration: 150 };
  const disliked = { id: '7a9c3226-3d42-4b07-90e5-143f8dd4d698', duration: 165 };
  const fresh = { id: 'library', duration: 160 };
  for (const dto of [played, current, ready, disliked, fresh]) {
    await publishTrack(session, dto);
  }
  const rated = await setLocalRating(session, disliked, 'dislike');
  expect(rated.state).toBe('pending');
  await saveWaveQueue(session, { current, future: [unread, disliked, ready], history: [played] });
  closeOfflineSession();
  await new Promise(resolve => setImmediate(resolve));
  mockReopenDatabase();
  const restored = await login(session.activationId, session.owner, 2);
  const snapshot = await readWaveQueue(restored);
  expect(snapshot.current.id).toBe(current.id);
  expect(snapshot.future.map(dto => dto.id)).toEqual([unread.id, disliked.id, ready.id]);
  expect(snapshot.history.map(dto => dto.id)).toEqual([played.id]);
  const status = await readOfflineWaveStatus(restored);
  expect(status).toMatchObject({ readySeconds: 150, readyMinutes: 2.5, targetMinutes: 60, upcomingCount: 2 });
  const local = await selectLocalWaveTracks(restored, snapshot);
  expect(local.reserveIds.has(ready.id)).toBe(true);
  expect(local.tracks.map(dto => dto.id)).toEqual([ready.id, fresh.id, played.id]);
  const alternate = await login('wave-other', { ...session.owner, userId: '22' }, 3);
  expect(await readWaveQueue(alternate)).toBeNull();
  expect(await readOfflineWaveStatus(restored)).toBeNull();
  expect(await saveWaveQueue(restored, snapshot)).toBe(false);
  expect(await selectLocalWaveTracks(alternate, snapshot)).toEqual({ tracks: [], reserveIds: new Set() });
});

test('fresh offline Wave uses verified tracks and local ratings while keeping the download plan through restart', async () => {
  const session = await login('wave-new-queue', { origin: 'https://new-wave.test', userId: '11' });
  const last = { id: 'last', artist: 'A', duration: 180 };
  const a = { id: '4842d018-b4e4-4217-8fba-3ec1c6b36693', artist: 'A', duration: 180 };
  const b = { id: '636bc145-7693-48fc-b6e7-8d44efb72b43', artist: 'B', duration: 180 };
  const c = { id: 'another-a', artist: 'A', duration: 180 };
  const disliked = { id: '7a9c3226-3d42-4b07-90e5-143f8dd4d698', duration: 180 };
  const pending = { id: 'pending-file', duration: 180 };
  for (const dto of [last, a, b, c, disliked]) await publishTrack(session, dto);
  await setLocalRating(session, a, 'like');
  await setLocalRating(session, b, 'like');
  await setLocalRating(session, disliked, 'dislike');
  await saveWaveQueue(session, { current: last, future: [a, c, disliked, pending], history: [] });
  // Simulate an installation whose existing snapshot predates the separate reserve.
  (await offlineDatabase()).runSync('DELETE FROM wave_reserve');
  const local = await selectLocalWaveTracks(session, { history: [last] });
  expect(local.tracks.map(dto => dto.id)).toEqual([b.id, a.id, c.id, last.id]);
  await saveWaveQueue(session, {
    current: b, future: [a, c, last], history: [last],
  }, { updateReserve: false });

  closeOfflineSession();
  await new Promise(resolve => setImmediate(resolve));
  mockReopenDatabase();
  const restored = await login(session.activationId, session.owner, 2);
  const snapshot = await readWaveQueue(restored);
  expect(snapshot.current.id).toBe(b.id);
  expect(snapshot.localFuture).toBe(true);
  expect(snapshot.future.map(dto => dto.id)).toEqual([a.id, c.id, last.id]);
  expect(snapshot.reserve.map(dto => dto.id)).toEqual([a.id, c.id, disliked.id, pending.id]);
  const newWave = await selectLocalWaveTracks(restored, { history: [...snapshot.history, snapshot.current] });
  expect(newWave.tracks.map(dto => dto.id)).toEqual([a.id, c.id, last.id, b.id]);
});

test('storage admission releases abandoned activations only after their native operation is gone', async () => {
  const { reapInactiveTransfers } = require('..');
  const old = await login('stale-transfer', { origin: 'https://retired.test', userId: '11' });
  const transfer = await reserveSized(old, { id: 'partial' }, 750);
  mockFiles.set(transfer.stagingUri, 100);
  const current = await login('current-transfer', { origin: 'https://new.test', userId: '12' });
  await reapInactiveTransfers(current, [transfer.operationId]);
  expect(mockFiles.has(transfer.stagingUri)).toBe(true);
  const before = await readStorageBudget(current);
  await reapInactiveTransfers(current, []);
  expect((await readStorageBudget(current)).accountedBytes).toBe(before.accountedBytes - 750);
  expect(mockFiles.has(transfer.stagingUri)).toBe(false);
});

test('near Wave songs get the first slot and collection downloads get a bounded turn', async () => {
  const { createWaveJobOrder } = require('../wave');
  const session = await login('fair-order', { origin: 'https://fair.test', userId: '11' });
  const [first, second, far] = ['wave-1', 'wave-2', 'wave-3'].map(id => ({ id, duration: 120 }));
  await saveWaveQueue(session, { current: { id: 'wave-current' }, future: [first, second, far], history: [] });
  for (const dto of [first, second, far]) await setRetentionReason(session, dto, WAVE_REASON, true);
  const queued = (trackId, reason = 'wave:reserve') => ({ trackId, reason, nextAttemptAt: 0 });
  const collection = Array.from({ length: 16 }, (_, i) => queued(`playlist-${i}`, 'playlist:large'));
  const candidates = [...collection, queued(far.id), queued(second.id), queued(first.id)];
  const order = createWaveJobOrder();
  expect((await order(session, candidates, 1))[0].trackId).toBe(first.id);
  expect((await order(session, candidates, 1))[0].trackId).toBe(first.id);
  expect((await order(session, candidates, 1))[0].trackId).toBe(first.id);
  expect((await order(session, candidates, 1))[0].trackId).toBe(collection[0].trackId);
});

test('storage breakdown charges unique audio, persisted UTF-8 lyrics and local cover bytes', async () => {
  const { offlineCoverFile } = require('../artworkFiles');
  const session = await login('budget-breakdown', { origin: 'https://items.test', userId: '11' });
  const dto = { id: 'single-file', duration: 116 };
  const before = await readStorageBudget(session);
  const key = await publishTrack(session, dto, 200);
  await setRetentionReason(session, dto, { kind: 'playlist', collectionId: 'selected' }, true);
  await setRetentionReason(session, dto, WAVE_REASON, true);
  const lyric = { state: 'ready', payload: { lyrics: 'строка' } };
  await saveLyricsResult(session, key, lyric);
  mockFiles.set(offlineCoverFile(session.owner, dto.id).uri, 37);
  const after = await readStorageBudget(session);
  expect(after.mediaBytes - before.mediaBytes).toBe(200);
  expect(after.coverBytes - before.coverBytes).toBe(37);
  expect(after.lyricsBytes - before.lyricsBytes).toBe(Buffer.byteLength(JSON.stringify(lyric), 'utf-8'));
  expect(after.usedBytes - before.usedBytes).toBe(237 + after.lyricsBytes - before.lyricsBytes);
});

test('offline Wave follows saved recommendation links and rebuilds from a new start', async () => {
  const api = require('../../shared/api/api');
  const { refreshWavePlan } = require('../wavePlan');
  const session = await login('wave-links', { origin: 'https://wave-links.test', userId: '17' });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (const id of ids) await publishTrack(session, { id });
  const fetch = jest.spyOn(api, 'authFetch').mockResolvedValue({
    ok: true,
    json: async () => ({
      starts: [['a', 1], ['b', 0.9]], next: { a: ['d'], d: ['c'], b: ['c'] }, blocked: ['e'],
    }),
  });
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  try {
    const signal = new AbortController().signal;
    await refreshWavePlan(session, signal);
    expect(fetch.mock.lastCall[1].body.track_ids).toEqual(ids);
    await refreshWavePlan(session, signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    mockReopenDatabase();
    const first = await selectLocalWaveTracks(session, {});
    expect(first.tracks.map(track => track.id)).toEqual(['a', 'd', 'c', 'b']);
    const second = await selectLocalWaveTracks(session, { history: [first.tracks[0]] });
    expect(second.tracks.map(track => track.id)).toEqual(['b', 'c', 'd', 'a']);
    const replay = await selectLocalWaveTracks(session, { history: ['c', 'a', 'b', 'd'].map(id => ({ id })) });
    expect(replay.tracks[0].id).toBe('a');
    fetch.mockRejectedValueOnce(new Error('unavailable'));
    await expect(refreshWavePlan(session, signal, true)).rejects.toThrow('unavailable');
    const continued = await selectLocalWaveTracks(session, {
      current: first.tracks[0], future: first.tracks.slice(1), exclude: [{ id: 'c' }],
    });
    expect(continued.tracks.map(track => track.id)).toEqual(['d', 'b']);
  } finally {
    fetch.mockRestore();
    random.mockRestore();
  }
});
