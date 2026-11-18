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

jest.mock('../../collections', () => ({
  listSavedCollections: async () => [],
  saveOfflineCollection: async () => true,
  reconcileRetention: async () => {},
}));
jest.mock('../../downloads/runtime', () => ({
  subscribeBackgroundDownloadStatus: () => () => {},
}));
jest.mock('../../collections/versionProbe', () => ({ probeReadyVersions: () => {} }));

test('integrated reconnect holds Favorites GET until the PUT completes', async () => {
  const { startCollectionSync } = require('../../collections/runtime');
  require('../..').getOfflineSession = () => mockActive;
  require('../..').isOfflineSessionCurrent = session => session === mockActive;
  require('../..').readCollection = async () => null;
  require('../..').subscribeOfflineIndex = listener => {
    mockSessionListeners.add(listener);
    return () => mockSessionListeners.delete(listener);
  };
  await setLocalRating(ownerA, { id: 'one', title: 'One' }, 'like');
  stop = startOutboxSync();
  const stopCollections = startCollectionSync();
  try {
    authFetch.mockResolvedValue(response([]));
    await flush();
    authFetch.mockClear();
    let releasePut;
    authFetch.mockImplementation((url, { method, body }) => (
      method === 'PUT'
        ? new Promise(resolve => { releasePut = () => resolve(response({ ...body, status: 'ok', track_id: 'one', applied: true })); })
        : Promise.resolve(response([]))
    ));
    reconnect();
    await flush();
    const before = authFetch.mock.calls.map(([url, options]) => [url, options.method || 'GET']);
    releasePut();
    await flush();
    expect(before.filter(([url, method]) => url.endsWith('/favorites') && method === 'GET')).toEqual([]);
    expect(authFetch.mock.calls.some(([url, options]) => url.endsWith('/favorites') && (!options.method || options.method === 'GET'))).toBe(true);
  } finally {
    stopCollections();
  }
});

jest.mock('../../../shared/storage/settings', () => ({
  getSettings: () => ({}), addSettingsListener: () => () => {},
}));
jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');
jest.mock('../../foreground', () => ({ saveFavoriteOffline: async () => {} }));

test('opening Favorites waits for the in-flight rating attempt before reading', async () => {
  jest.useRealTimers();
  const React = require('react');
  const TestRenderer = require('react-test-renderer');
  const { act } = TestRenderer;
  const PlaylistScreen = require('../../../features/playlists/PlaylistScreen').default;
  const index = require('../..');
  index.getOfflineSession = () => mockActive;
  index.isOfflineSessionCurrent = session => session === mockActive;
  index.readCollection = async () => null;
  index.readFavoriteDownloads = async () => ({ ready: [] });
  index.subscribeOfflineIndex = () => () => {};
  require('../../collections').collectionProgress = async () => null;
  const track = { id: 'one', title: 'One' };
  await setLocalRating(ownerA, track, 'like');
  stop = startOutboxSync();
  let releasePut;
  authFetch.mockImplementation((url, { method, body } = {}) =>
    method === 'PUT'
      ? new Promise(resolve => {
          releasePut = () => resolve(response({ ...body, status: 'ok', track_id: 'one', applied: true }));
        })
      : Promise.resolve(response([])),
  );
  reconnect();
  await flush();
  expect(typeof releasePut).toBe('function');
  const favoritesReads = () => authFetch.mock.calls.filter(([url, options]) =>
    url === '/api/favorites' && (options?.method || 'GET') === 'GET',
  );
  expect(favoritesReads()).toHaveLength(0);
  let renderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(PlaylistScreen, {
        route: { params: { playlistId: 'favorites', playlistName: 'Favorites' } },
        navigation: { goBack() {} }, onPlayTrackList() {},
      }));
    });
    expect(favoritesReads()).toHaveLength(0);
    await act(async () => { releasePut(); await flush(); });
    expect(favoritesReads()).toHaveLength(1);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    releasePut();
    await flush();
  }
});

test('Library shows the saved overlay while the in-flight rating attempt blocks Favorites GET', async () => {
  jest.useRealTimers();
  const React = require('react');
  const TestRenderer = require('react-test-renderer');
  const { act } = TestRenderer;
  const LibraryScreen = require('../../../features/library/LibraryScreen').default;
  const index = require('../..');
  index.getOfflineSession = () => mockActive;
  index.isOfflineSessionCurrent = session => session === mockActive;
  index.readCollection = async () => ({ tracks: [{ id: 'saved', title: 'Saved song' }] });
  index.subscribeOfflineIndex = () => () => {};
  await setLocalRating(ownerA, { id: 'one', title: 'Local song' }, 'like');
  stop = startOutboxSync();
  let releasePut;
  authFetch.mockImplementation((url, { method, body } = {}) => method === 'PUT'
    ? new Promise(resolve => { releasePut = () => resolve(response({ ...body, status: 'ok', track_id: 'one', applied: true })); })
    : Promise.resolve(response([])));
  reconnect();
  await flush();
  let renderer;
  const favoritesReads = () => authFetch.mock.calls.filter(([url, options]) => url === '/api/favorites' && (options?.method || 'GET') === 'GET');
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(LibraryScreen, { currentUser: { id: 1 }, navigation: { navigate() {} } })); });
    expect(renderer.root.findAll(node => node.type === 'Text' && Array.isArray(node.props.children) && node.props.children.join('') === '2 tracks')).toHaveLength(1);
    expect(favoritesReads()).toHaveLength(0);
    await act(async () => { releasePut(); await flush(); });
    expect(favoritesReads()).toHaveLength(1);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    releasePut();
    await flush();
  }
});

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: { createAnimatedComponent: Comp => Comp, View },
    FadeInDown: { delay: () => ({ duration: () => ({}) }) },
    FadeInRight: { delay: () => ({ duration: () => ({}) }) },
    LinearTransition: { springify: () => ({}) } };
});

test.each(['Playlist', 'Library'])('%s does not issue a Favorites read after the session changes during the attempt', async screen => {
  jest.useRealTimers();
  const React = require('react');
  const TestRenderer = require('react-test-renderer');
  const { act } = TestRenderer;
  const Screen = screen === 'Playlist'
    ? require('../../../features/playlists/PlaylistScreen').default
    : require('../../../features/library/LibraryScreen').default;
  const index = require('../..');
  index.getOfflineSession = () => mockActive;
  index.isOfflineSessionCurrent = session => session === mockActive;
  index.readCollection = async () => null;
  index.readFavoriteDownloads = async () => ({ ready: [] });
  index.subscribeOfflineIndex = () => () => {};
  require('../../collections').collectionProgress = async () => null;
  await setLocalRating(ownerA, { id: 'one', title: 'One' }, 'like');
  stop = startOutboxSync();
  let releasePut;
  authFetch.mockImplementation((url, { method, body } = {}) => method === 'PUT'
    ? new Promise(resolve => { releasePut = () => resolve(response({ ...body, status: 'ok', track_id: 'one', applied: true })); })
    : Promise.resolve(response([])));
  reconnect();
  await flush();
  const props = screen === 'Playlist'
    ? { route: { params: { playlistId: 'favorites', playlistName: 'Favorites' } }, navigation: { goBack() {} }, onPlayTrackList() {} }
    : { currentUser: { id: 1 }, navigation: { navigate() {} } };
  let renderer;
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(Screen, props)); });
    activate(ownerB);
    await act(async () => { releasePut(); await flush(); });
    expect(authFetch.mock.calls.filter(([url]) => url === '/api/favorites')).toHaveLength(0);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    releasePut();
    await flush();
  }
});

test('Favorites reads after a failed attempt and retains the pending local overlay', async () => {
  jest.useRealTimers();
  const React = require('react');
  const TestRenderer = require('react-test-renderer');
  const { act } = TestRenderer;
  const { FlatList } = require('react-native');
  const PlaylistScreen = require('../../../features/playlists/PlaylistScreen').default;
  const index = require('../..');
  index.getOfflineSession = () => mockActive;
  index.isOfflineSessionCurrent = session => session === mockActive;
  index.readCollection = async () => null;
  index.readFavoriteDownloads = async () => ({ ready: [] });
  index.subscribeOfflineIndex = () => () => {};
  require('../../collections').collectionProgress = async () => null;
  await setLocalRating(ownerA, { id: 'one', title: 'One' }, 'like');
  stop = startOutboxSync();
  let releasePut;
  authFetch.mockImplementation((url, { method } = {}) => method === 'PUT'
    ? new Promise(resolve => { releasePut = () => resolve({ ok: false, status: 503 }); })
    : Promise.resolve(response([])));
  reconnect();
  await flush();
  let renderer;
  try {
    await act(async () => { renderer = TestRenderer.create(React.createElement(PlaylistScreen, { route: { params: { playlistId: 'favorites', playlistName: 'Favorites' } }, navigation: { goBack() {} }, onPlayTrackList() {} })); });
    expect(authFetch.mock.calls.filter(([url]) => url === '/api/favorites')).toHaveLength(0);
    await act(async () => { releasePut(); await flush(); });
    expect(authFetch.mock.calls.filter(([url]) => url === '/api/favorites')).toHaveLength(1);
    expect(renderer.root.findByType(FlatList).props.data.map(track => track.id)).toEqual(['one']);
    expect(await getRatingOverlay(ownerA)).toEqual(expect.arrayContaining([expect.objectContaining({ rating: 'like' })]));
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    releasePut();
    await flush();
  }
});
