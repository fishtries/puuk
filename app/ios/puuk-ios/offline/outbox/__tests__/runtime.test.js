import { authFetch } from '../../../shared/api/api';
import { saveCollection } from '../..';
import {
  captureFavoritesSnapshotGuard,
  getLocalDislikeIds,
  getRatingOverlay,
  projectFavoriteTracks,
  setLocalRating,
  startOutboxSync,
} from '../runtime';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const ownerA = {
  owner: { origin: 'https://puuk.test', userId: 1 },
  activationId: 'a',
  generation: 1,
};
const ownerB = {
  owner: { ...ownerA.owner, userId: 2 },
  activationId: 'b',
  generation: 2,
};
let mockActive;
let mockNetwork;
let mockDb;
let mockId;
const mockSessionListeners = new Set();
const mockNetworkListeners = new Set();
const mockChanges = [];

jest.mock('../../session', () => ({
  createOfflineId: () => `rating-${++mockId}`,
  getOfflineSession: () => mockActive,
  isOfflineSessionCurrent: (session) => !!session && session === mockActive,
  ownerKey: ({ origin, userId }) => JSON.stringify([origin, userId]),
  subscribeOfflineIndex: (listener) => {
    mockSessionListeners.add(listener);
    return () => mockSessionListeners.delete(listener);
  },
  notifyOfflineIndex: (event) => {
    mockChanges.push(event);
    mockSessionListeners.forEach((listener) => listener(event));
  },
}));
jest.mock('../../../utils/networkPolicy', () => ({
  getCurrentNetworkPolicy: () => ({ isConnected: mockNetwork }),
  subscribeNetworkPolicy: (listener) => {
    mockNetworkListeners.add(listener);
    return () => mockNetworkListeners.delete(listener);
  },
}));
jest.mock('../../storage', () => ({
  offlineDatabase: async () => ({
    runSync: (statement, ...args) => mockDb.prepare(statement).run(...args),
    getFirstSync: (statement, ...args) =>
      mockDb.prepare(statement).get(...args),
    getAllSync: (statement, ...args) => mockDb.prepare(statement).all(...args),
    withTransactionSync: (work) => {
      mockDb.exec('BEGIN');
      try {
        work();
        mockDb.exec('COMMIT');
      } catch (error) {
        mockDb.exec('ROLLBACK');
        throw error;
      }
    },
  }),
}));
jest.mock('../../../shared/api/api', () => ({ authFetch: jest.fn() }));
jest.mock('../..', () => ({
  displayTrack: (track) => ({ id: track.id, title: track.title }),
  FAVORITES_COLLECTION: { kind: 'favorites', collectionId: 'favorites' },
  saveCollection: jest.fn(),
}));

function activate(session) {
  const previous = mockActive;
  mockActive = null;
  mockSessionListeners.forEach((listener) =>
    listener({ type: 'closed', session: previous }),
  );
  const { origin, userId } = session.owner;
  mockDb
    .prepare('INSERT OR REPLACE INTO activation VALUES (1,?,?)')
    .run(JSON.stringify([origin, userId]), session.activationId);
  mockActive = session;
  mockSessionListeners.forEach((listener) =>
    listener({ type: 'opened', session }),
  );
}

function reconnect() {
  mockNetwork = true;
  mockNetworkListeners.forEach((listener) => listener({ isConnected: true }));
}

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

const response = (data) => ({ ok: true, status: 200, json: async () => data });
let stop;
beforeAll(() => {
  mockDb = new DatabaseSync(':memory:');
  mockDb.exec(
    'CREATE TABLE activation (singleton INTEGER PRIMARY KEY, owner TEXT, activation_id TEXT)',
  );
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockNetwork = false;
  mockId ||= 0;
  mockChanges.length = 0;
  saveCollection.mockResolvedValue(true);
  activate(ownerA);
});

afterEach(() => {
  stop?.();
  stop = null;
  mockDb.exec(
    'DELETE FROM outbox_entry; DELETE FROM outbox_rating; DELETE FROM outbox_rating_projection; DELETE FROM outbox_rating_snapshot',
  );
  jest.useRealTimers();
});

afterAll(() => mockDb.close());

test('a single-track rating check returns only its active overlay', async () => {
  await setLocalRating(ownerA, { id: 'one' }, 'like');
  await setLocalRating(ownerA, { id: 'two' }, 'dislike');
  expect(await getRatingOverlay(ownerA, 'two')).toEqual([expect.objectContaining({
    trackId: 'two', rating: 'dislike',
  })]);
  expect(await getRatingOverlay(ownerA, 'three')).toEqual([]);
});

test('startup reads the durable overlay and reconnect drains before publishing the refresh', async () => {
  const track = { id: 'one', title: 'Favorite' };
  const local = await setLocalRating(ownerA, track, 'like');
  const isSnapshotCurrent = captureFavoritesSnapshotGuard(ownerA);
  stop = startOutboxSync();
  await flush();
  expect(authFetch).not.toHaveBeenCalled();
  expect(mockChanges).toContainEqual(
    expect.objectContaining({
      type: 'rating-overlay',
      overlay: [expect.objectContaining({ rating: 'like', track })],
    }),
  );
  expect(await projectFavoriteTracks(ownerA, [])).toEqual([
    { ...track, is_liked: true },
  ]);

  authFetch.mockImplementation(async (url, { method, body }) =>
    method === 'PUT'
      ? response({ ...body, status: 'ok', track_id: 'one', applied: true })
      : response(url.endsWith('/favorites') ? [track] : ['other']),
  );
  reconnect();
  await flush();
  expect(
    authFetch.mock.calls.map(([url]) => url.replace(ownerA.owner.origin, '')),
  ).toEqual(['/api/tracks/one/rating', '/api/favorites', '/api/dislikes']);
  expect(authFetch.mock.calls[0][1].body.operation_id).toBe(local.operationId);
  expect(saveCollection).toHaveBeenCalledWith(ownerA, expect.anything(), {
    title: 'Favorites',
    tracks: [track],
  });
  expect(mockChanges.slice(-3).map(({ type }) => type)).toEqual([
    'outbox-settled',
    'ratings-refreshed',
    'interactions-drained',
  ]);
  expect(await getRatingOverlay(ownerA)).toEqual([]);
  expect(isSnapshotCurrent()).toBe(false);
  expect(await getLocalDislikeIds(ownerA)).toEqual(new Set(['other']));
});

test('a new rating during a GET survives the stale snapshot and schedules another drain', async () => {
  const track = { id: 'one', title: 'Favorite' };
  await setLocalRating(ownerA, track, 'like');
  let favoriteResponse;
  let serverRating = 'neutral';
  authFetch.mockImplementation(async (url, { method, body }) => {
    if (method === 'PUT') {
      serverRating = body.rating;
      return response({
        ...body,
        status: 'ok',
        track_id: 'one',
        applied: true,
      });
    }
    if (url.endsWith('/dislikes'))
      return response(serverRating === 'dislike' ? ['one'] : []);
    if (!favoriteResponse)
      return new Promise((resolve) => {
        favoriteResponse = resolve;
      });
    return response([]);
  });
  stop = startOutboxSync();
  reconnect();
  await flush();
  const local = await setLocalRating(ownerA, track, 'dislike');
  expect(await projectFavoriteTracks(ownerA, [track])).toEqual([]);
  favoriteResponse(response([track]));
  await flush();
  const refreshes = mockChanges.filter(
    ({ type }) => type === 'ratings-refreshed',
  );
  expect(refreshes[0].overlay).toMatchObject([
    { operationId: local.operationId, state: 'pending', rating: 'dislike' },
  ]);
  expect(refreshes[1]).toMatchObject({
    favorites: [],
    dislikes: ['one'],
    overlay: [],
  });
  expect(serverRating).toBe('dislike');
});

test('an owner switch cancels the old request, keeps its overlay private and honors durable activation', async () => {
  const track = { id: 'one', title: 'Favorite' };
  await setLocalRating(ownerA, track, 'like');
  let oldResponse;
  authFetch.mockImplementation(async (_url, { method, body }) => {
    if (method !== 'PUT') return response([]);
    return new Promise((resolve) => {
      oldResponse = () =>
        resolve(
          response({ ...body, status: 'ok', track_id: 'one', applied: true }),
        );
    });
  });
  stop = startOutboxSync();
  reconnect();
  await flush();
  const oldSignal = authFetch.mock.calls[0][1].signal;
  activate(ownerB);
  await flush();
  expect(oldSignal.aborted).toBe(true);
  oldResponse();
  await flush();
  expect(await getRatingOverlay(ownerB)).toEqual([]);
  await expect(getRatingOverlay(ownerA)).rejects.toThrow('session changed');
  expect(
    mockChanges.filter(
      ({ type, session }) => type === 'ratings-refreshed' && session === ownerA,
    ),
  ).toEqual([]);
  mockDb.exec("UPDATE activation SET activation_id='revoked'");
  await expect(setLocalRating(ownerB, track, 'like')).rejects.toThrow(
    'activation changed',
  );
});
