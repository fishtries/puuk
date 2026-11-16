import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) { return next(specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier) ? `${specifier}.ts` : specifier, context); },
  load(url, context, next) {
    const result = next(url, context);
    return !url.includes('/app/web/src/') ? result : { ...result, source: String(result.source).replace(/import \{([^}]+)\} from ('[^']*\/types\/[^']+')/g, 'import type {$1} from $2') };
  },
});
const A = '00000000-0000-4000-a000-000000000001';
const B = '00000000-0000-4000-a000-000000000002';
const artistId = 'art_0123456789abcdef0123456789abcdef';
class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
}
const storage = new MemoryStorage();
const tab = new MemoryStorage();
let path = '/';
const history: Array<{ kind: string; path: string }> = [];
const listeners = new Map<string, (event: any) => void>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  sessionStorage: tab,
  location: { get pathname() { return path.split(/[?#]/)[0]; }, get search() { return path.includes('?') ? '?' + path.split('?')[1].split('#')[0] : ''; }, get hash() { return path.includes('#') ? '#' + path.split('#')[1] : ''; }, href: 'https://web.puuk.fun/', origin: 'https://web.puuk.fun' },
  history: { pushState(_state: unknown, _title: string, value: string) { path = value; history.push({ kind: 'push', path }); }, replaceState(_state: unknown, _title: string, value: string) { path = value; history.push({ kind: 'replace', path }); } },
  addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener); },
} });
class SilentAudio extends EventTarget {
  src = ''; paused = true; currentTime = 0; duration = 180; volume = 1; preload = ''; crossOrigin = '';
  get currentSrc() { return this.src; }
  removeAttribute() { this.src = ''; }
  load() {}
  pause() { this.paused = true; }
  async play() { this.paused = false; }
}
globalThis.Audio = function () { return new SilentAudio() as unknown as HTMLAudioElement; } as unknown as typeof Audio;
const share = await import('../useShareNavigationStore.ts');
const api = await import('../../api/share.ts');
const client = await import('../../api/client.ts');
const { usePlayerStore: player } = await import('../usePlayerStore.ts');
const { useAuthStore: auth } = await import('../useAuthStore.ts');
const links = await import('../../utils/shareLinks.ts');
const nav = share.useShareNavigationStore;
function track(id = A) { return { id, share_id: id, title: 'Synthetic track', artist: 'Synthetic artist', artists: [{ id: artistId, share_id: artistId, name: 'Synthetic artist' }], album_id: 42, album_share_id: '42', duration: 180, content_version: null }; }
function payload(type = 'track', id = A, canonical = id): any {
  const entity = type === 'track' ? track(canonical) : type === 'album' ? { id: canonical, share_id: canonical, title: 'Synthetic album', artist: 'Synthetic artist' } : { id: canonical, share_id: canonical, name: 'Synthetic artist', track_count: 0, album_count: 0 };
  return { type, requested_id: id, canonical_id: canonical, canonical_path: `/${type}/${canonical}`, entity, tracks: type === 'track' ? [entity] : [], albums: [] };
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
let requestCount: number;
let response: (url: string, init: RequestInit) => Response | Promise<Response>;
let audioMutations: number;
let unsubscribe: () => void;
beforeEach(() => {
  storage.clear(); storage.setItem('puuk_token', 'synthetic-session'); tab.clear();
  client.advanceApiSession(); nav.getState().reset();
  player.setState({ currentTrack: track(B), queue: [track(B)], currentTrackIndex: 0, status: 'paused', currentTime: 27 });
  requestCount = 0; path = '/'; history.length = 0;
  response = () => json(payload());
  globalThis.fetch = (async (url, init = {}) => { requestCount++; return response(String(url), init); }) as typeof fetch;
  audioMutations = 0;
  unsubscribe = player.subscribe((state, previous) => { if (state.currentTrack !== previous.currentTrack || state.queue !== previous.queue || state.status !== previous.status || state.currentTime !== previous.currentTime) audioMutations++; });
});
afterEach(() => { unsubscribe(); nav.getState().reset(); client.setUnauthorizedHandler(null); });

describe('permanent links compose with existing auth and playback', () => {
  it('reload/direct entry, alias, popstate and successful display never touch real player state', async () => {
    path = `/track/${A}/`; nav.getState().initFromLocation();
    await nav.getState().resolveCurrentTarget();
    assert.equal(path, `/track/${A}`); assert.equal(tab.length, 0); assert.equal(audioMutations, 0);
    response = () => json(payload('album','41','42'));
    nav.getState().navigateToTarget({ type: 'album', id: '41' }); await nav.getState().resolveCurrentTarget();
    assert.equal(path, '/album/42'); assert.equal(history.at(-1)?.kind, 'replace');
    const pushes = history.filter(item => item.kind === 'push').length;
    response = () => json(payload()); nav.getState().handlePopState(`/track/${A}`); await nav.getState().resolveCurrentTarget();
    assert.equal(history.filter(item => item.kind === 'push').length, pushes);
    assert.equal(audioMutations, 0); assert.equal(player.getState().currentTrack?.id, B); assert.equal(player.getState().currentTime, 27);
  });
  it('password and Telegram OTP completion restore one tab target without autoplay', async () => {
    for (const method of ['password','otp']) {
      storage.removeItem('puuk_token'); client.advanceApiSession(); nav.getState().reset();
      path = `/track/${A}`; nav.getState().initFromLocation();
      response = (url, init) => {
        if (url.includes('/api/auth/')) {
          assert.equal(init.method, 'POST');
          assert.ok(url.endsWith(method === 'password' ? '/login' : '/verify-code'));
          return json({ access_token: 'synthetic-new-session', user: { id: 9001, username: 'fixture' } });
        }
        return json(payload());
      };
      if (method === 'password') await auth.getState().login({ username: 'fixture', password: 'synthetic' });
      else await auth.getState().loginWithTelegramCode('123456');
      assert.equal(tab.length, 1); assert.equal(nav.getState().resolvedEntity, null);
      await nav.getState().resolveCurrentTarget();
      assert.equal(nav.getState().resolvedEntity?.canonical_id, A); assert.equal(tab.length, 0);
      assert.equal(player.getState().currentTrack, null); assert.deepEqual(player.getState().queue, []); assert.equal(player.getState().status, 'idle');
    }
    assert.equal(requestCount, 4);
  });
  it('login cancellation fences a delayed auth response and leaves root unauthenticated', async () => {
    let finish!: (value: Response) => void;
    response = () => new Promise(resolve => { finish = resolve; });
    path = `/track/${A}`; nav.getState().initFromLocation();
    const login = auth.getState().loginWithTelegramCode('123456');
    auth.getState().logout(); nav.getState().cancelNavigation();
    finish(json({ access_token: 'late-session', user: { id: 9001 } })); await login;
    assert.equal(auth.getState().user, null); assert.equal(storage.getItem('puuk_token'), null); assert.equal(path, '/'); assert.equal(tab.length, 0);
  });
  it('rejects any future age including 1ms; expiry/corrupt age and explicit navigation away clear tab pending', () => {
    for (const savedAt of [1001, 1000 + 60000, -1, '1000', null]) {
      tab.setItem(share.PENDING_SHARE_STORAGE_KEY, JSON.stringify({ type: 'track', id: A, savedAt }));
      assert.equal(share.readPendingDestination(tab, 1000), null); assert.equal(tab.length, 0);
    }
    share.writePendingDestination({ type: 'track', id: A }, tab, 1000);
    assert.ok(share.readPendingDestination(tab, 1000 + share.PENDING_SHARE_MAX_AGE_MS));
    assert.equal(share.readPendingDestination(tab, 1001 + share.PENDING_SHARE_MAX_AGE_MS), null);
    nav.getState().navigateToTarget({ type: 'track', id: A }); nav.getState().handlePopState('/'); assert.equal(tab.length, 0);
  });
  it('does not accept query/fragment destinations and never stores their raw URL', () => {
    for (const suffix of ['?returnTo=https://evil.test','?token=CANARY','#CANARY']) {
      path = `/track/${A}${suffix}`; assert.equal(nav.getState().initFromLocation(), null); assert.equal(tab.length, 0);
    }
    assert.equal(links.parseShareTarget(`https://web.puuk.fun/album/9223372036854775807`)?.id, '9223372036854775807');
    assert.equal(links.entityShareId('album', { id: Number('9223372036854775807'), share_id: '9223372036854775807' }), '9223372036854775807');
    assert.equal(links.entityShareId('album', { id: Number('9223372036854775807') }), null);
    assert.equal(links.isCanonicalShareTarget({ type: 'track', id: `${A}/` }), false);
  });
  it('deduplicates resolution and aborts superseded navigation even when the old fetch ignores abort', async () => {
    let finish!: (value: Response) => void;
    let signal!: AbortSignal;
    response = (_url, init) => { signal = init.signal!; return new Promise(resolve => { finish = resolve; }); };
    nav.getState().navigateToTarget({ type: 'track', id: A });
    const first = nav.getState().resolveCurrentTarget(); assert.equal(nav.getState().resolveCurrentTarget(), first); assert.equal(requestCount, 1);
    nav.getState().navigateToTarget({ type: 'track', id: B }); assert.equal(signal.aborted, true);
    response = () => json(payload('track',B)); await nav.getState().resolveCurrentTarget();
    finish(json(payload())); await first;
    assert.equal(nav.getState().resolvedEntity?.canonical_id, B); assert.equal(requestCount, 2); assert.equal(audioMutations, 0);
  });
  it('auth switch during body decode clears protected share state; late decoded A cannot commit to B', async () => {
    let decode!: (value: unknown) => void;
    response = () => ({ status: 200, json: () => new Promise(resolve => { decode = resolve; }) }) as unknown as Response;
    nav.getState().navigateToTarget({ type: 'track', id: A });
    const first = nav.getState().resolveCurrentTarget(); await new Promise(resolve => setImmediate(resolve));
    storage.setItem('puuk_token','account-B'); client.advanceApiSession();
    decode(payload()); await first;
    assert.equal(nav.getState().resolvedEntity, null); assert.equal(nav.getState().isResolving, false); assert.equal(nav.getState().pendingDestination?.id, A);
    response = () => json(payload()); await nav.getState().resolveCurrentTarget(); assert.equal(nav.getState().resolvedEntity?.canonical_id, A);
  });
  it('cancellation and timeout bound body decoding and ignored abort mocks, no late publication', async () => {
    response = () => new Promise(() => {});
    await assert.rejects(api.fetchShareEntity('track',A,{ timeoutMs: 10 }), { code: 'timeout', isRetryable: true });
    const controller = new AbortController(); controller.abort();
    const count = requestCount;
    await assert.rejects(api.fetchShareEntity('track',A,{ signal: controller.signal }), { isRetryable: false });
    assert.equal(requestCount, count);
    let decode!: (value: unknown) => void;
    response = () => ({ status: 200, json: () => new Promise(resolve => { decode = resolve; }) }) as unknown as Response;
    const pending = api.fetchShareEntity('track',A,{ timeoutMs: 10 });
    await assert.rejects(pending, { code: 'timeout' }); decode(payload());
  });
  it('401 retains pending for login; 5xx retry is explicit; terminal and old-server states are safe', async () => {
    nav.getState().navigateToTarget({ type: 'track', id: A });
    response = () => json({ detail: 'CANARY' },401); await nav.getState().resolveCurrentTarget();
    assert.equal(nav.getState().error?.kind,'auth'); assert.equal(tab.length,1);
    response = () => json({ detail: 'CANARY' },503); await nav.getState().resolveCurrentTarget();
    assert.equal(nav.getState().error?.kind,'retryable'); assert.equal(requestCount,2); assert.equal(tab.length,1);
    response = () => json(payload()); await nav.getState().resolveCurrentTarget(); assert.equal(requestCount,3); assert.equal(tab.length,0);
    nav.getState().navigateToTarget({ type: 'album', id: '1' });
    response = () => json({ detail: 'Not Found' },404); await nav.getState().resolveCurrentTarget();
    assert.equal(nav.getState().error?.message,'Обновите сервер'); assert.equal(tab.length,0); assert.equal(audioMutations,0);
  });
  const invalid = [
    (p: any) => { p.requested_id = B; },
    (p: any) => { p.canonical_id = B; },
    (p: any) => { p.canonical_path = '/album/42'; },
    (p: any) => { p.canonical_path = `https://web.puuk.fun/track/${A}`; },
    (p: any) => { p.canonical_path += '/'; },
    (p: any) => { p.entity.id = B; },
    (p: any) => { p.entity.share_id = B; },
    (p: any) => { delete p.entity.share_id; },
    (p: any) => { p.entity.duration = '180'; },
    (p: any) => { p.entity.artists[0].share_id = artistId + 'a'; },
    (p: any) => { p.entity.album_artists = [{id:artistId,share_id:artistId+'a',name:'broken credit'}]; },
    (p: any) => { p.entity.stream_url = 'https://bad.test/?token=CANARY'; },
    (p: any) => { p.entity.file_path = '/private/CANARY'; },
    (p: any) => { p.entity.title = 'https://bad.test/?md5=CANARY'; },
    (p: any) => { p.tracks = []; },
    (p: any) => { p.albums = [{ id: '1', share_id: '1', title: 'unexpected', artist: 'x' }]; },
  ];
  for (const [index, mutate] of invalid.entries()) it(`rejects server identity/DTO violation ${index+1} without echoing permission/path`, async () => {
    const data = structuredClone(payload()); mutate(data); response = () => json(data);
    await assert.rejects(api.fetchShareEntity('track',A), error => error instanceof api.ShareApiError && error.code === 'invalid_response' && error.isTerminal && !error.message.includes('CANARY'));
    assert.equal(requestCount,1); assert.equal(audioMutations,0);
  });
  it('accepts an imprecise legacy album number only with its lossless identity; bounded artist empty profiles remain usable', async () => {
    const large = '9223372036854775807';
    const album = payload('album',large); album.entity.id = Number(large);
    response = () => json(album);
    assert.equal((await api.fetchShareEntity('album',large)).entity.share_id,large);
    album.entity.id = Number(large) * 2;
    await assert.rejects(api.fetchShareEntity('album',large),{code:'invalid_response'});
    const artist = payload('artist',artistId); response = () => json(artist);
    assert.equal((await api.fetchShareEntity('artist',artistId)).tracks.length,0);
    artist.tracks = Array.from({length:11},()=>track());
    await assert.rejects(api.fetchShareEntity('artist',artistId),{code:'invalid_response'});
  });
  it('sanitizes malformed JSON, request IDs, transport errors and server details', async () => {
    response = () => { throw new Error('https://bad.test/?token=CANARY'); };
    await assert.rejects(api.fetchShareEntity('track',A), error => error instanceof Error && !error.message.includes('CANARY'));
    await assert.rejects(api.fetchShareEntity('track','?token=CANARY'), error => error instanceof Error && !error.message.includes('CANARY'));
    response = () => ({ status: 200, json: async () => { throw new Error('CANARY'); } }) as unknown as Response;
    await assert.rejects(api.fetchShareEntity('track',A),{code:'invalid_response'});
  });
  it('cross-tab storage logout unloads the existing player and clears share metadata', async () => {
    nav.getState().navigateToTarget({type:'track',id:A}); await nav.getState().resolveCurrentTarget();
    storage.removeItem('puuk_token'); listeners.get('storage')!({key:'puuk_token'});
    assert.equal(player.getState().currentTrack,null); assert.deepEqual(player.getState().queue,[]); assert.equal(nav.getState().resolvedEntity,null);
  });
});
