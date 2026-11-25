import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const mediaUrl = new URL('../../api/media.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) { return next(specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier) ? `${specifier}.ts` : specifier, context); },
  load(url, context, next) {
    const result = next(url, context);
    if (!url.includes('/app/web/src/')) return result;
    let source = String(result.source).replace(/import \{([^}]+)\} from ('[^']*\/types\/[^']+')/g, 'import type {$1} from $2');
    if (url === mediaUrl) source = source.replace("(import.meta as any).env?.VITE_CDN_DELIVERY_ENABLED === 'true'", 'true');
    return { ...result, source };
  },
});
const A = '00000000-0000-4000-a000-000000000001';
const B = '00000000-0000-4000-a000-000000000002';
const hash = 'a'.repeat(64);
let now = 1000;
const realNow = performance.now;
let token: string | null = 'synthetic-account-A';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => key === 'puuk_token' ? token : values.get(key) ?? null, setItem: (key: string, value: string) => { if (key === 'puuk_token') token = value; else values.set(key, value); }, removeItem: (key: string) => { if (key === 'puuk_token') token = null; else values.delete(key); } } });
class FakeAudio extends EventTarget {
  src = ''; currentTime = 0; duration = 1000; paused = true; volume = 1; crossOrigin = ''; preload = ''; error: { code: number; message: string } | null = null;
  loads: Array<{ url: string; cors: string }> = [];
  behaviors: string[] = [];
  plays = 0;
  get currentSrc() { return this.src; }
  removeAttribute() { this.src = ''; this.currentTime = 0; }
  load() {
    if (!this.src) return;
    this.loads.push({ url: this.src, cors: this.crossOrigin });
    const behavior = this.behaviors.shift() ?? 'ready';
    queueMicrotask(() => {
      if (behavior === 'ready') this.dispatchEvent(new Event('canplay'));
      else if (behavior === 'error' || behavior === 'decode') { this.error = { code: behavior === 'decode' ? 3 : 2, message: 'DO_NOT_REPORT_CANARY' }; this.dispatchEvent(new Event('error')); }
    });
  }
  async play() { this.plays++; this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  fire(type: string) { this.dispatchEvent(new Event(type)); }
}
let contextSuspended = false;
const audio = new FakeAudio();
globalThis.Audio = function () { return audio as unknown as HTMLAudioElement; } as unknown as typeof Audio;
Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://web.puuk.fun/', origin: 'https://web.puuk.fun' }, addEventListener() {}, AudioContext: class {
  get state() { return contextSuspended ? 'suspended' : 'running'; }
  resume() { return contextSuspended ? new Promise<void>(() => {}) : Promise.resolve(); }
  currentTime = 0; destination = {};
  createGain() { return { gain: { cancelScheduledValues() {}, setTargetAtTime() {}, setValueAtTime() {} }, connect() {} }; }
  createAnalyser() { return { connect() {}, frequencyBinCount: 4 }; }
  createMediaElementSource() { return { connect() {} }; }
} } });
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const { usePlayerStore: store } = await import('../../store/usePlayerStore.ts');
const { audioEngine } = await import('../AudioEngine.ts');
const media = await import('../../api/media.ts');
const client = await import('../../api/client.ts');
const { useAuthStore: auth } = await import('../../store/useAuthStore.ts');
let tickets: Array<{ body: any; signal: AbortSignal | null | undefined }>;
let historyCalls: number;
let fetchTicket: (body: any, init: RequestInit) => Response | Promise<Response>;
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function ticket(id = A, delivery = 'cdn') {
  return { url: delivery === 'cdn' ? `https://media.puuk.fun/cdn/audio/${id}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800` : `/api/stream/${id}?mt=synthetic-media`, expires_in: 1800, expires_at: 1800001800, server_time: 1800000000, delivery, content_version: hash, content_length: 100, download_binding: delivery === 'cdn' ? 'immutable-path' : 'if-match', delivery_epoch: 'test-v1', cache_for: 30 };
}
const track = (id = A) => ({ id, share_id: id, title: 'Synthetic track', artist: 'Synthetic artist', duration: 1000, loudness_status: 'analyzed', normalization_gain_db: -4 });
async function settle() { for (let n=0;n<15;n++) await new Promise(resolve => setImmediate(resolve)); }
beforeEach(() => {
  token = 'synthetic-account-A';
  contextSuspended = false;
  client.advanceApiSession();
  store.getState().resetUserData();
  media.resetAudioTicketCache();
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  now = 1000;
  tickets = []; historyCalls = 0; audio.loads = []; audio.behaviors = []; audio.plays = 0; audio.error = null;
  store.setState({ repeatMode: 'off', isShuffled: false, isLoudnessNormalizationEnabled: true });
  fetchTicket = body => json(ticket(body.track_id));
  globalThis.fetch = (async (url, init = {}) => {
    if (String(url).includes('/api/media-ticket')) { const body = JSON.parse(String(init.body)); tickets.push({ body, signal: init.signal }); return fetchTicket(body, init); }
    if (String(url).endsWith('/history') && init.method === 'POST') historyCalls++;
    return json({});
  }) as typeof fetch;
});
afterEach(() => { store.getState().resetUserData(); media.resetAudioTicketCache(); client.setUnauthorizedHandler(null); Object.defineProperty(performance, 'now', { configurable: true, value: realNow }); });

describe('store owns one bounded delivery recovery episode', () => {
  it('plays, pauses, seeks, resumes, repeats and advances through the same resolver', async () => {
    await store.getState().playTrack(track(), [track(), track(B)], 'collection');
    assert.equal(store.getState().status, 'playing'); assert.equal(tickets.length, 1);
    store.getState().seek(42); assert.equal(audio.currentTime, 42);
    store.getState().pause(); assert.equal(audio.paused, true);
    store.getState().resume(); await settle(); assert.equal(audio.paused, false); assert.equal(tickets.length, 1);
    store.setState({ repeatMode: 'one' }); audio.fire('ended'); await settle();
    assert.equal(audio.currentTime, 0); assert.equal(tickets.length, 1); assert.equal(store.getState().currentTrack?.id, A);
    await store.getState().nextTrack(); await settle();
    assert.equal(store.getState().currentTrack?.id, B); assert.equal(tickets.length, 2);
    assert.ok(audio.loads.every(load => load.cors === 'anonymous'));
    assert.ok(audio.loads.every(load => !load.url.includes('synthetic-account')));
  });
  it('spends one refresh then one authorized direct fallback; preserves queue, position, normalization and listen identity', async () => {
    await store.getState().playTrack(track(), [track(), track(B)], 'collection');
    store.getState().seek(42);
    audio.behaviors = ['error', 'ready'];
    fetchTicket = body => json(ticket(body.track_id, body.delivery === 'direct' ? 'direct' : 'cdn'));
    audio.error = { code: 2, message: 'synthetic' }; audio.fire('error'); await settle();
    assert.deepEqual(tickets.map(item => item.body.delivery), ['cdn', 'cdn', 'direct']);
    assert.equal(audio.loads.length, 3); assert.equal(audio.currentTime, 42);
    assert.deepEqual(store.getState().queue.map(item => item.id), [A,B]);
    assert.equal(audioEngine.getNormalizationGainDb(), -4);
    assert.equal(historyCalls, 1, 'source replacement must not count a new logical listen');
    assert.equal(store.getState().status, 'playing');
  });
  it('exhausts after three source attempts and requires explicit Retry; repeated error events cannot reset the ledger', async () => {
    audio.behaviors = ['error','error','error'];
    fetchTicket = body => json(ticket(body.track_id, body.delivery === 'direct' ? 'direct' : 'cdn'));
    await store.getState().playTrack(track(), [track()]);
    assert.equal(tickets.length, 3); assert.equal(audio.loads.length, 3); assert.equal(store.getState().status, 'error');
    audio.fire('error'); audio.fire('waiting'); await settle(); assert.equal(tickets.length, 3);
    store.getState().togglePlay(); await settle(); assert.equal(tickets.length, 4); assert.equal(store.getState().status, 'playing');
  });
  it('direct-selected sources get one refresh and no redundant direct fallback', async () => {
    fetchTicket = body => json(ticket(body.track_id, 'direct'));
    audio.behaviors = ['error','error'];
    await store.getState().playTrack(track());
    assert.equal(tickets.length, 2); assert.equal(audio.loads.length, 2); assert.equal(store.getState().status, 'error');
  });
  it('decode failures are terminal without mode switching', async () => {
    audio.behaviors = ['decode'];
    await store.getState().playTrack(track());
    assert.equal(tickets.length, 1); assert.equal(store.getState().status, 'error');
  });
  for (const status of [401,403,404,410,422,429,500,503]) it(`ticket ${status} never authorizes automatic fallback`, async () => {
    audio.behaviors = ['error'];
    let n = 0;
    fetchTicket = body => ++n === 1 ? json(ticket(body.track_id)) : json({ detail: 'track failure DO_NOT_REPORT_CANARY' }, status);
    await store.getState().playTrack(track());
    assert.equal(tickets.length, 2); assert.equal(audio.loads.length, 1); assert.equal(store.getState().status, 'error');
  });
  it('confirmed ticket 401 runs existing auth cleanup before any late source can appear', async () => {
    client.setUnauthorizedHandler(() => auth.getState().logout());
    fetchTicket = () => json({ detail: 'invalid session' }, 401);
    await store.getState().playTrack(track());
    assert.equal(token, null); assert.equal(store.getState().currentTrack, null); assert.deepEqual(store.getState().queue, []); assert.equal(audio.src, '');
    assert.equal(tickets.length, 1);
  });
  it('allows one legacy negotiation only, consumes refresh slot and surfaces unsupported web endpoint', async () => {
    fetchTicket = () => json({ detail: 'Not Found' }, 404);
    await store.getState().playTrack(track());
    assert.equal(tickets.length, 2); assert.deepEqual(tickets[1].body, { track_id: A }); assert.equal(audio.loads.length, 0); assert.equal(store.getState().status, 'error');
  });
  it('does not negotiate track 404 or a generic validation failure', async () => {
    fetchTicket = () => json({ detail: 'track_unavailable' }, 404);
    await store.getState().playTrack(track()); assert.equal(tickets.length, 1);
  });
  it('successful legacy negotiation remembers the negative capability for at most five minutes', async () => {
    let n = 0;
    fetchTicket = body => ++n === 1 ? json({ detail: [{ loc: ['body','delivery'] }] }, 422) : json({ url: `/api/stream/${body.track_id}?mt=legacy`, expires_in: 600 });
    await store.getState().playTrack(track()); assert.equal(tickets.length, 2);
    await store.getState().playTrack(track(B)); assert.deepEqual(tickets[2].body, { track_id: B });
    now += 300_001;
    await store.getState().playTrack(track()); assert.equal(tickets[3].body.delivery, 'cdn');
  });
  it('pause beyond lifetime reauthorizes at resume, seek and repeat; advancing time never replaces healthy audio', async () => {
    await store.getState().playTrack(track()); store.getState().seek(41);
    now += 1900_000; await settle(); assert.equal(audio.loads.length, 1);
    store.getState().pause(); store.getState().resume(); await settle(); assert.equal(tickets.length, 2); assert.equal(audio.currentTime, 41);
    now += 1900_000; store.getState().pause(); store.getState().seek(80); await settle();
    assert.equal(tickets.length, 3); assert.equal(audio.currentTime, 80); assert.equal(audio.paused, true);
    now += 1900_000; store.setState({ repeatMode: 'one' }); audio.fire('ended'); await settle();
    assert.equal(tickets.length, 4); assert.equal(audio.currentTime, 0); assert.equal(audio.paused, false);
  });
  it('foreground permission clear preserves healthy playback and refreshes on the next seek boundary', async () => {
    await store.getState().playTrack(track());
    media.resetAudioTicketCache(); await settle(); assert.equal(audio.loads.length, 1); assert.equal(audio.paused, false);
    store.getState().seek(64); await settle(); assert.equal(tickets.length, 2); assert.equal(audio.currentTime, 64);
  });
  it('pause cancels pending refresh; late completion cannot play and resume uses a fresh attempt', async () => {
    await store.getState().playTrack(track()); store.getState().seek(51);
    let finish!: (response: Response) => void;
    fetchTicket = () => new Promise(resolve => { finish = resolve; });
    audio.error = { code: 2, message: 'synthetic' }; audio.fire('error'); await settle();
    store.getState().pause(); assert.equal(tickets[1].signal?.aborted, true);
    finish(json(ticket())); await settle(); assert.equal(audio.paused, true); assert.equal(audio.loads.length, 1); assert.equal(store.getState().status, 'paused');
    fetchTicket = body => json(ticket(body.track_id)); store.getState().resume(); await settle(); assert.equal(audio.currentTime, 51); assert.equal(audio.paused, false);
  });
  it('a late refresh A cannot replace a selected B, even if aborted fetch ignores cancellation', async () => {
    await store.getState().playTrack(track());
    let finish!: (response: Response) => void;
    fetchTicket = () => new Promise(resolve => { finish = resolve; }); audio.error = { code: 2, message: 'synthetic' }; audio.fire('error'); await settle();
    fetchTicket = body => json(ticket(body.track_id)); await store.getState().playTrack(track(B), [track(B)]);
    finish(json(ticket())); await settle();
    assert.equal(store.getState().currentTrack?.id, B); assert.equal(audio.loads.at(-1)?.url.includes(B), true); assert.equal(audio.loads.length, 2);
  });
  it('a late rejected play promise for A cannot pause or recover B', async t => {
    await store.getState().playTrack(track());
    store.getState().pause();
    let rejectA!: (error: Error) => void;
    const pending = t.mock.method(audioEngine, 'play', () => new Promise<void>((_, reject) => { rejectA = reject; }));
    store.getState().resume();
    pending.mock.restore();
    await store.getState().playTrack(track(B));
    rejectA(Object.assign(new Error('synthetic policy denial'), { name: 'NotAllowedError' }));
    await settle();
    assert.equal(store.getState().currentTrack?.id, B); assert.equal(store.getState().status, 'playing'); assert.equal(tickets.length, 2);
  });
  it('logout unloads and aborts before a pending initial ticket or account B can use A data', async () => {
    let finish!: (response: Response) => void;
    fetchTicket = () => new Promise(resolve => { finish = resolve; });
    const initial = store.getState().playTrack(track()); await settle();
    auth.getState().logout(); assert.equal(tickets[0].signal?.aborted, true); assert.equal(audio.src, ''); assert.equal(store.getState().currentTrack, null);
    token = 'synthetic-account-B'; client.advanceApiSession();
    fetchTicket = body => json(ticket(body.track_id)); await store.getState().playTrack(track(B));
    finish(json(ticket())); await initial; await settle();
    assert.equal(store.getState().currentTrack?.id, B); assert.equal(audio.loads.length, 1);
  });
  it('source timeout unloads each attempt, never exceeds three, and total episode is at most 30 seconds', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    audio.behaviors = ['stall','stall','stall'];
    fetchTicket = body => new Promise(resolve => setTimeout(() => resolve(json(ticket(body.track_id, body.delivery === 'direct' ? 'direct' : 'cdn'))), 2900));
    const playing = store.getState().playTrack(track());
    const start = now;
    for (let n=0;n<3;n++) {
      now += 2900; t.mock.timers.tick(2900); await settle();
      const time = n === 2 ? 7000 : 7000;
      now += time; t.mock.timers.tick(time); await settle();
    }
    await playing;
    assert.equal(tickets.length, 3); assert.equal(audio.loads.length, 3); assert.equal(audio.src, ''); assert.equal(store.getState().status, 'error');
    assert.ok(now - start <= 30_000);
    t.mock.timers.reset();
  });
  it('loads audio in parallel with a suspended AudioContext and cannot later unload a newer selection', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    contextSuspended = true;
    const activate = t.mock.method(audioEngine, 'activateAudioContext');
    const first = store.getState().playTrack(track());
    assert.equal(activate.mock.callCount(), 1, 'activation starts in the tap handler');
    await settle();
    assert.equal(audio.loads.length, 1);
    assert.equal(audio.plays, 0);
    now += 7000; t.mock.timers.tick(7000); await settle();
    assert.equal(tickets.length, 2, 'source-context wait consumes the same refresh slot');
    contextSuspended = false;
    await store.getState().playTrack(track(B)); await first;
    now += 7000; t.mock.timers.tick(7000); await settle();
    assert.equal(store.getState().currentTrack?.id, B); assert.equal(audio.src.includes(B), true); assert.equal(store.getState().status, 'playing');
    t.mock.timers.reset();
  });
  it('stalled ticket times out in three seconds without an audio attempt or retry', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    fetchTicket = () => new Promise(() => {});
    const playing = store.getState().playTrack(track());
    now += 3000; t.mock.timers.tick(3000); await settle(); await playing;
    assert.equal(tickets.length, 1); assert.equal(audio.loads.length, 0); assert.equal(store.getState().status, 'error');
    t.mock.timers.reset();
  });
});
