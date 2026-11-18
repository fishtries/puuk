import {
  saveOfflineCollection,
  removeOfflineCollection,
  setRetentionReason,
  listRetentionReasons,
  collectionProgress,
} from '..';
import {
  enqueueBackgroundDownload,
  cancelBackgroundDownload,
} from '../../downloads/runtime';
import { overlayFavorites } from '../runtime';

let mockDb,
  mockCurrent = true,
  mockJobs = [],
  mockReady = new Set();
jest.mock('../../storage', () => ({ offlineDatabase: async () => mockDb }));
jest.mock('../../session', () => ({
  ownerKey: (o) => JSON.stringify([o.origin, o.userId]),
  notifyOfflineIndex: jest.fn(),
}));
jest.mock('../../downloads/runtime', () => ({
  enqueueBackgroundDownload: jest.fn(async () => ({ status: 'queued' })),
  cancelBackgroundDownload: jest.fn(async () => true),
}));
jest.mock('../..', () => ({
  isOfflineSessionCurrent: () => mockCurrent,
  displayTrack: (track) =>
    track && track.id != null ? { id: track.id, title: track.title } : null,
  listDownloadJobs: async () => mockJobs,
  cleanupUnretainedMedia: jest.fn(async () => true),
  retryMediaCleanup: jest.fn(async () => {}),
  readMediaKey: async (_session, id) =>
    mockReady.has(String(id)) ? { trackId: id } : null,
}));
jest.mock('../../outbox/runtime', () => ({
  getRatingOverlay: jest.fn(),
  captureFavoritesSnapshotGuard: () => () => true,
}));
const session = {
  owner: { origin: 'https://test', userId: '1' },
  activationId: 'a',
};
const a = { kind: 'playlist', collectionId: 'a' },
  b = { kind: 'album', collectionId: 'b' };
const one = { id: '1', title: 'one' },
  two = { id: '2', title: 'two' };
beforeEach(() => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE activation(singleton INTEGER, owner TEXT, activation_id TEXT); CREATE TABLE collection(owner TEXT, kind TEXT, id TEXT, title TEXT, tracks TEXT, updated_at INTEGER, PRIMARY KEY(owner,kind,id));',
  );
  db.prepare('INSERT INTO activation VALUES (1, ?, ?)').run(
    JSON.stringify(['https://test', '1']),
    'a',
  );
  mockDb = {
    execSync: (sql) => db.exec(sql),
    getFirstSync: (sql, ...args) => db.prepare(sql).get(...args),
    getAllSync: (sql, ...args) => db.prepare(sql).all(...args),
    runSync: (sql, ...args) => db.prepare(sql).run(...args),
    withTransactionSync: (work) => {
      db.exec('BEGIN');
      try {
        work();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  mockCurrent = true;
  mockJobs = [];
  mockReady = new Set();
  jest.clearAllMocks();
});
test('persists ordered repeated tracks, accepts empty success, and rejects invalid response', async () => {
  await saveOfflineCollection(session, a, {
    title: 'A',
    tracks: [one, two, one],
  });
  const read = () =>
    JSON.parse(mockDb.getFirstSync('SELECT tracks FROM collection').tracks).map(
      (t) => t.id,
    );
  expect(read()).toEqual(['1', '2', '1']);
  expect(
    await saveOfflineCollection(session, a, { title: 'A', tracks: [one, {}] }),
  ).toBe(false);
  expect(read()).toEqual(['1', '2', '1']);
  await saveOfflineCollection(session, a, { title: 'A', tracks: [] });
  expect(read()).toEqual([]);
});
test('shared collection and like reasons protect job when one collection is removed', async () => {
  await saveOfflineCollection(session, a, { title: 'A', tracks: [one] });
  await saveOfflineCollection(session, b, { title: 'B', tracks: [one] });
  await setRetentionReason(
    session,
    one,
    { kind: 'like', collectionId: 'local' },
    true,
  );
  mockJobs = [{ trackId: '1', jobId: 'job', state: 'transferring' }];
  await removeOfflineCollection(session, a);
  await removeOfflineCollection(session, b);
  expect(await listRetentionReasons(session, '1')).toEqual([
    { kind: 'like', collectionId: 'local' },
  ]);
  expect(cancelBackgroundDownload).not.toHaveBeenCalled();
  await setRetentionReason(
    session,
    one,
    { kind: 'like', collectionId: 'local' },
    false,
  );
  expect(cancelBackgroundDownload).toHaveBeenCalledWith(session, 'job');
});
test('counts ready immediately after restart and fences changed owner', async () => {
  mockReady.add('1');
  mockJobs = [{ trackId: '2', state: 'transferring' }];
  expect(await collectionProgress(session, [one, two, one])).toMatchObject({
    ready: 2,
    total: 3,
  });
  mockCurrent = false;
  expect(
    await saveOfflineCollection(session, a, { title: 'A', tracks: [one] }),
  ).toBe(false);
  expect(enqueueBackgroundDownload).not.toHaveBeenCalled();
});
test('pending overlay preserves duplicates and does not lose local likes', () => {
  expect(
    overlayFavorites(
      [one, two, one],
      [
        { trackId: '2', rating: 'neutral', state: 'pending' },
        { trackId: '3', rating: 'like', state: 'pending', track: { id: '3' } },
      ],
    ).map((t) => t.id),
  ).toEqual(['1', '1', '3']);
});

test('stale collection response cannot replace a newer snapshot or resurrect a removed selection', async () => {
  await saveOfflineCollection(session, a, { title: 'first', tracks: [one] });
  const oldRevision = mockDb.getFirstSync(
    'SELECT updated_at FROM collection',
  ).updated_at;
  await saveOfflineCollection(session, a, { title: 'new', tracks: [two] });
  expect(
    await saveOfflineCollection(
      session,
      a,
      { title: 'late', tracks: [] },
      {
        expectedUpdatedAt: oldRevision,
        replaceSnapshot: true,
        requireSaved: true,
      },
    ),
  ).toBe(false);
  expect(
    JSON.parse(mockDb.getFirstSync('SELECT tracks FROM collection').tracks)[0]
      .id,
  ).toBe('2');
  await removeOfflineCollection(session, a);
  expect(
    await saveOfflineCollection(
      session,
      a,
      { title: 'late', tracks: [one] },
      {
        expectedUpdatedAt: null,
        replaceSnapshot: true,
        requireSaved: true,
      },
    ),
  ).toBe(false);
});
