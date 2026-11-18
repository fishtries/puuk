import { createLyricsSync } from '../runtime';

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function setup() {
  const session = { owner: { origin: 'server', userId: '1' }, activationId: 'a', generation: 1 };
  const key = { owner: session.owner, trackId: 'track', contentVersion: 'a'.repeat(64) };
  let current = session;
  let local = 'unknown';
  let online = true;
  let index, network, app;
  const refresh = jest.fn(async (s, k, { signal }) => {
    if (!online || signal.aborted || current !== s) return { state: 'unknown' };
    local = 'ready';
    return { state: local };
  });
  const start = createLyricsSync({
    getSession: () => current, isCurrent: s => s === current,
    listUnknown: jest.fn(async () => local === 'unknown' ? [key] : []), refresh,
    subscribeIndex: fn => { index = fn; return () => {}; },
    subscribeNetwork: fn => { network = fn; return () => {}; },
    getNetwork: () => ({ isConnected: online }),
    subscribeAppState: fn => { app = fn; return () => {}; },
  });
  return { session, key, refresh, start, index: e => index(e), network: value => { online = value; network({ isConnected: value }); },
    app: state => app(state), local: () => local, changeOwner: () => { current = null; } };
}

test('publication failure is recovered on reconnect without opening the player', async () => {
  const t = setup(); const stop = t.start(); await flush();
  // A new publication fails after the audio is ready.
  stop();
  const u = setup(); u.network; // publication happens before the first scan settles
  const cleanup = u.start();
  u.network(false); u.index({ type: 'published', session: u.session, mediaKey: u.key });
  await flush(); expect(u.local()).toBe('unknown');
  u.network(true); await flush(); expect(u.local()).toBe('ready');
  u.network(false); expect(u.local()).toBe('ready'); cleanup();
});

test('restart scans unknown media and a closed session fences delayed work', async () => {
  const t = setup(); const stop = t.start(); await flush(); expect(t.local()).toBe('ready'); stop();
  const u = setup(); let complete;
  u.refresh.mockImplementation((s, k, { signal }) => new Promise(resolve => { complete = () => resolve({ state: signal.aborted ? 'unknown' : 'ready' }); }));
  const cleanup = u.start(); await flush();
  const signal = u.refresh.mock.calls[0][2].signal;
  u.changeOwner(); u.index({ type: 'closed', session: u.session });
  expect(signal.aborted).toBe(true); complete(); await flush();
  expect(u.local()).toBe('unknown'); cleanup();
});

test('an unknown track does not prevent other tracks from being prepared on reconnect', async () => {
  const session = { owner: { origin: 'server', userId: '1' }, activationId: 'a', generation: 1 };
  const keys = ['a', 'b'].map(trackId => ({ owner: session.owner, trackId, contentVersion: 'a'.repeat(64) }));
  let network;
  const refresh = jest.fn(async (s, key) => ({ state: key.trackId === 'a' ? 'unknown' : 'ready' }));
  const stop = createLyricsSync({
    getSession: () => session, isCurrent: s => s === session,
    listUnknown: async (s, after) => keys.filter(key => key.trackId > after), refresh,
    subscribeIndex: () => () => {}, subscribeNetwork: fn => { network = fn; return () => {}; },
    getNetwork: () => ({ isConnected: false }), subscribeAppState: () => () => {},
  })();
  network({ isConnected: true }); await flush();
  expect(refresh.mock.calls.map(call => call[1].trackId)).toEqual(['a', 'b']);
  network({ isConnected: false }); network({ isConnected: true }); await flush();
  expect(refresh.mock.calls.map(call => call[1].trackId)).toEqual(['a', 'b', 'a', 'b']);
  stop();
});

test('publication bursts share one request slot and deduplicate in-flight keys', async () => {
  const session = { owner: { origin: 'server', userId: '1' }, activationId: 'a', generation: 1 };
  let index; let resolve; let concurrent = 0; let peak = 0;
  const refresh = jest.fn(() => {
    concurrent += 1; peak = Math.max(peak, concurrent);
    return new Promise(done => { resolve = () => { concurrent -= 1; done({ state: 'ready' }); }; });
  });
  const stop = createLyricsSync({
    getSession: () => session, isCurrent: s => s === session, listUnknown: async () => [], refresh,
    subscribeIndex: fn => { index = fn; return () => {}; }, subscribeNetwork: () => () => {},
    getNetwork: () => ({}), subscribeAppState: () => () => {},
  })();
  await flush();
  const key = trackId => ({ owner: session.owner, trackId, contentVersion: 'a'.repeat(64) });
  index({ type: 'published', session, mediaKey: key('a') }); await flush();
  for (let i = 0; i < 100; i += 1) index({ type: 'published', session, mediaKey: key('a') });
  index({ type: 'published', session, mediaKey: key('b') });
  expect(refresh).toHaveBeenCalledTimes(1); resolve(); await flush();
  expect(refresh.mock.calls.map(call => call[1].trackId)).toEqual(['a', 'b']);
  expect(peak).toBe(1); resolve(); await flush(); stop();
});

test('publication failure is retried through the provider and remains readable offline', async () => {
  const { createLyricsProvider } = require('../provider');
  const session = { owner: { origin: 'server', userId: '1' }, activationId: 'a', generation: 1 };
  const key = { owner: session.owner, trackId: 'track', contentVersion: 'a'.repeat(64) };
  let saved; let index; let network; let connected = true; let ready = false;
  const fetchLyrics = jest.fn(async () => {
    if (!connected || !ready) throw new Error('network lost');
    return { lyrics: 'Saved text' };
  });
  const provider = createLyricsProvider({
    readMediaKey: async () => key, readLyrics: async () => saved,
    saveLyricsResult: async (s, k, result) => { saved = result; },
    isOfflineSessionCurrent: s => s === session, fetchLyrics,
    fetchContentVersion: async () => key.contentVersion, getAuthGeneration: () => 1,
  });
  const stop = createLyricsSync({
    getSession: () => session, isCurrent: s => s === session,
    listUnknown: async (s, after) => !saved && !after ? [key] : [],
    refresh: provider.refreshLyrics,
    subscribeIndex: fn => { index = fn; return () => {}; },
    subscribeNetwork: fn => { network = fn; return () => {}; },
    getNetwork: () => ({ isConnected: false }), subscribeAppState: () => () => {},
  })();
  network({ isConnected: true });
  index({ type: 'published', session, mediaKey: key }); await flush();
  expect(saved).toBeUndefined();
  connected = false; network({ isConnected: false });
  ready = true; connected = true; network({ isConnected: true }); await flush();
  expect(saved).toMatchObject({ state: 'ready', payload: { lyrics: 'Saved text' } });
  connected = false; network({ isConnected: false });
  const calls = fetchLyrics.mock.calls.length;
  await expect(provider.readSelectedLyrics(session, key.trackId)).resolves.toMatchObject({ state: 'ready', payload: { lyrics: 'Saved text' } });
  expect(fetchLyrics).toHaveBeenCalledTimes(calls);
  stop();
});

test('bounded scans resume past persistent unknown results on a later reconnect', async () => {
  const session = { owner: { origin: 'server', userId: '1' }, activationId: 'a', generation: 1 };
  const keys = Array.from({ length: 55 }, (_, i) => ({ owner: session.owner, trackId: String(i).padStart(2, '0'), contentVersion: 'a'.repeat(64) }));
  let network;
  const refresh = jest.fn(async () => ({ state: 'unknown' }));
  const stop = createLyricsSync({
    getSession: () => session, isCurrent: s => s === session,
    listUnknown: async (s, after, limit) => keys.filter(key => key.trackId > after).slice(0, limit), refresh,
    subscribeIndex: () => () => {}, subscribeNetwork: fn => { network = fn; return () => {}; },
    getNetwork: () => ({ isConnected: false }), subscribeAppState: () => () => {},
  })();
  network({ isConnected: true }); for (let i = 0; i < 10; i += 1) await flush();
  expect(refresh).toHaveBeenCalledTimes(50);
  network({ isConnected: false }); network({ isConnected: true }); await flush();
  expect(refresh.mock.calls.slice(50).map(call => call[1].trackId)).toEqual(['50', '51', '52', '53', '54']);
  stop();
});
