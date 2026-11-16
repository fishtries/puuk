import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';

const mediaUrl = new URL('../media.ts', import.meta.url).href;
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url === mediaUrl) return { ...result, source: String(result.source).replace("(import.meta as any).env?.VITE_CDN_DELIVERY_ENABLED === 'true'", 'true') };
  return result;
} });
let token: string | null = 'synthetic-session';
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => token } });
const media = await import('../media.ts');
const client = await import('../client.ts');
const A = '00000000-0000-4000-a000-000000000001';
const B = '00000000-0000-4000-a000-000000000002';
const hash = 'a'.repeat(64);
let now = 1000;
const originalNow = performance.now;
let requests: Array<{ url: string; init: RequestInit; body: any }>;
let reply: (body: any, init: RequestInit) => Promise<Response> | Response;
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function modern(id = A, delivery = 'cdn'): Record<string, any> {
  return { url: delivery === 'cdn' ? `https://media.puuk.fun/cdn/audio/${id}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800` : `/api/stream/${id}?mt=synthetic-media`, expires_in: delivery === 'cdn' ? 1800 : 600, expires_at: delivery === 'cdn' ? 1800001800 : 1800000600, delivery, server_time: 1800000000, content_version: hash, content_length: 100, download_binding: delivery === 'cdn' ? 'immutable-path' : 'if-match', delivery_epoch: 'test-v1', cache_for: 30 };
}
beforeEach(() => {
  token = 'synthetic-session';
  client.advanceApiSession();
  media.resetAudioTicketCache();
  now = 1000;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  requests = [];
  reply = body => json(modern(body.track_id));
  globalThis.fetch = (async (url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url: String(url), init, body });
    return reply(body, init);
  }) as typeof fetch;
});
afterEach(() => { media.resetAudioTicketCache(); Object.defineProperty(performance, 'now', { configurable: true, value: originalNow }); });

describe('media delivery boundary', () => {
  it('negotiates only build capability, scopes account credentials, uses no-store and no redirects', async () => {
    const source = await media.resolveAudioDelivery(A);
    assert.equal(source.delivery, 'cdn');
    assert.deepEqual(requests[0].body, { track_id: A, delivery: 'cdn' });
    assert.equal(new Headers(requests[0].init.headers).get('Authorization'), `Bearer ${token}`);
    assert.equal(requests[0].init.credentials, 'omit');
    assert.equal(requests[0].init.redirect, 'error');
    assert.equal(requests[0].init.cache, 'no-store');
    assert.equal(requests.length, 1, 'no audio body fetch');
    assert.ok(!source.url.includes(token!));
    assert.equal(source.usableUntil, 1771000);
    assert.equal(source.reuseUntil, 31000);
  });
  it('flag off omits capability even when a caller tries CDN (separate untouched module process)', () => {
    const script = `globalThis.localStorage={getItem:()=> 'synthetic-access'}; let body; globalThis.fetch=async (_url,init)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({url:'/api/stream/${A}?mt=synthetic-media',expires_in:600}));}; const m=await import(${JSON.stringify(mediaUrl)});await m.resolveAudioDelivery('${A}',{mode:'cdn'}); if(m.CDN_DELIVERY_ENABLED || body.delivery!==undefined)process.exit(2);`;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
  it('deduplicates pending requests and reuses for strictly less than 30 seconds', async () => {
    let finish!: (value: Response) => void;
    reply = () => new Promise(resolve => { finish = resolve; });
    const first = media.resolveAudioDelivery(A);
    const second = media.resolveAudioDelivery(A);
    assert.equal(first, second);
    finish(json(modern()));
    const source = await first;
    now += 29999;
    assert.equal(await media.resolveAudioDelivery(A), source);
    reply = body => json(modern(body.track_id));
    now += 1;
    await media.resolveAudioDelivery(A);
    assert.equal(requests.length, 2);
  });
  it('computes deadlines from request start and never extends them for client wall clock rollback', async () => {
    reply = () => { now += 2500; return json(modern()); };
    const source = await media.resolveAudioDelivery(A);
    assert.equal(source.reuseUntil, 31000);
    const originalDate = Date.now;
    Date.now = () => 1;
    try { now = 31001; await media.resolveAudioDelivery(A); assert.equal(requests.length, 2); } finally { Date.now = originalDate; }
  });
  it('a monotonic reset invalidates the active descriptor on its very first boundary check', async () => {
    const source = await media.resolveAudioDelivery(A);
    assert.equal(media.isAudioDeliveryUsable(source), true);
    now -= 1;
    assert.equal(media.isAudioDeliveryUsable(source), false);
    await media.resolveAudioDelivery(A);
    assert.equal(requests.length, 2);
  });
  it('accepts old direct fields, ignores wall expiry, and honors actual direct without forcing CDN', async () => {
    reply = () => json({ url: `/api/stream/${A}?mt=legacy`, expires_in: 600, expires_at: 1 });
    const legacy = await media.resolveAudioDelivery(A);
    assert.equal(legacy.delivery, 'direct');
    assert.equal(legacy.usableUntil, 571000);
    media.resetAudioTicketCache();
    reply = () => json(modern(A, 'direct'));
    assert.equal((await media.resolveAudioDelivery(A)).delivery, 'direct');
    assert.equal(requests.length, 2);
  });
  const invalidUrls = [
    `https://evil.test/cdn/audio/${A}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800`,
    `http://media.puuk.fun/cdn/audio/${A}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800`,
    `https://media.puuk.fun:443/cdn/audio/${A}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800`,
    `https://u@media.puuk.fun/cdn/audio/${A}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800`,
    `https://media.puuk.fun/cdn/audio/${B}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800`,
    `https://media.puuk.fun/cdn/audio/${A}/${hash}/?md5=${'A'.repeat(22)}&expires=1800001800`,
    `https://media.puuk.fun/cdn/audio/${A}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800&md5=other`,
    `https://media.puuk.fun/cdn/audio/${A}/${hash}?md5=${'A'.repeat(22)}&expires=01800001800`,
    `https://media.puuk.fun/cdn/audio/${A}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800&token=CANARY`,
    `https://media.puuk.fun/cdn/audio/${A}/${hash}?md5=${'A'.repeat(22)}&expires=1800001800#CANARY`,
    `https://media.puuk.fun/cdn/audio/${A}/../${hash}?md5=${'A'.repeat(22)}&expires=1800001800`,
    `https://media.puuk.fun/cdn/audio/${A}/${hash}?%6dd5=${'A'.repeat(22)}&expires=1800001800`,
  ];
  for (const [index, url] of invalidUrls.entries()) it(`rejects noncanonical capability URL case ${index + 1} without echoing it`, async () => {
    reply = () => json({ ...modern(), url });
    await assert.rejects(media.resolveAudioDelivery(A), error => error instanceof media.MediaDeliveryError && error.code === 'invalid_response' && !error.message.includes('CANARY') && !error.message.includes(url));
    assert.equal(requests.length, 1);
  });
  for (const patch of [{ expires_in: '1800' }, { expires_in: 1801 }, { expires_in: -1 }, { expires_at: 1800001802 }, { server_time: NaN }, { cache_for: 31 }, { content_version: 'b'.repeat(64) }, { download_binding: null }, { content_length: 0 }, { delivery_epoch: 'CANARY?token=bad' }]) it(`rejects malformed descriptor ${Object.keys(patch)[0]} (${JSON.stringify(patch).length})`, async () => {
    reply = () => json({ ...modern(), ...patch });
    await assert.rejects(media.resolveAudioDelivery(A), { code: 'invalid_response' });
  });
  for (const url of [`//evil.test/api/stream/${A}?mt=CANARY`, `/api/stream/${B}?mt=CANARY`, `/api/stream/${A}?mt=CANARY&token=bad`, `/api/stream/${A}?mt=synthetic-session`, `/api/stream/${A}?mt=percent%2Ejwt`, `https://web.puuk.fun:443/api/stream/${A}?mt=CANARY`]) it('rejects untrusted/noncanonical direct URL', async () => {
    reply = () => json({ url, expires_in: 600 });
    await assert.rejects(media.resolveAudioDelivery(A), { code: 'invalid_response' });
  });
  it('caps LRU at 200, updates recency and evicts obsolete epoch/version entries', async () => {
    for (let n = 1; n <= 200; n++) await media.resolveAudioDelivery(`00000000-0000-4000-a000-${n.toString(16).padStart(12, '0')}`);
    await media.resolveAudioDelivery(A);
    await media.resolveAudioDelivery('00000000-0000-4000-a000-000000000201');
    assert.equal(requests.length, 201);
    await media.resolveAudioDelivery(A); assert.equal(requests.length, 201);
    await media.resolveAudioDelivery(B); assert.equal(requests.length, 202);
    reply = () => json({ ...modern(), delivery_epoch: 'test-v2' });
    await media.resolveAudioDelivery(A, { force: true });
    assert.equal((await media.resolveAudioDelivery(A)).deliveryEpoch, 'test-v2');
  });
  it('sheds a ninth pending request and bounds time even when fetch ignores abort', async () => {
    reply = () => new Promise(() => {});
    const eight = Array.from({ length: 8 }, (_, n) => media.resolveAudioDelivery(`00000000-0000-4000-a000-${(n+1).toString(16).padStart(12, '0')}`, { timeoutMs: 15 }));
    await assert.rejects(media.resolveAudioDelivery('00000000-0000-4000-a000-000000000009'), { code: 'busy' });
    assert.equal(requests.length, 8);
    const settled = await Promise.allSettled(eight);
    assert.ok(settled.every(result => result.status === 'rejected' && result.reason.code === 'timeout'));
  });
  it('aborts and fences logout/account change during JSON decoding; no late cache admission', async () => {
    let decode!: (value: unknown) => void;
    reply = () => ({ ok: true, status: 200, json: () => new Promise(resolve => { decode = resolve; }) }) as unknown as Response;
    const first = media.resolveAudioDelivery(A);
    await new Promise(resolve => setImmediate(resolve));
    token = 'account-B'; client.advanceApiSession();
    decode(modern());
    await assert.rejects(first, { code: 'cancelled' });
    reply = () => json(modern(A, 'direct'));
    assert.equal((await media.resolveAudioDelivery(A)).delivery, 'direct');
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[1].init.headers).get('Authorization'), 'Bearer account-B');
  });
  it('never retries terminal API/transport failures, and negotiation is only definitive', async () => {
    for (const status of [401,403,404,410,422,429,500,503]) {
      reply = () => json({ detail: { code: 'track_unavailable', message: 'CANARY' } }, status);
      await assert.rejects(media.resolveAudioDelivery(A), error => error instanceof media.MediaDeliveryError && !error.canNegotiate && !error.message.includes('CANARY'));
    }
    assert.equal(requests.length, 8);
    reply = () => json({ detail: 'Not Found' }, 404);
    await assert.rejects(media.resolveAudioDelivery(A), { code: 'unsupported', canNegotiate: true });
    reply = () => json({ detail: [{ loc: ['body', 'delivery'] }] }, 422);
    await assert.rejects(media.resolveAudioDelivery(A), { canNegotiate: true });
    reply = () => { throw new Error('https://bad.test/?token=CANARY'); };
    await assert.rejects(media.resolveAudioDelivery(A), error => error instanceof Error && !error.message.includes('CANARY'));
  });
  it('refuses malformed IDs before fetch and rejects receipt after its conservative lifetime', async () => {
    await assert.rejects(media.resolveAudioDelivery('../CANARY'), { code: 'invalid_response' });
    assert.equal(requests.length, 0);
    reply = () => { now += 31_000; return json({ url: `/api/stream/${A}?mt=short`, expires_in: 60 }); };
    await assert.rejects(media.resolveAudioDelivery(A), { code: 'invalid_response' });
  });
  it('never attaches credentials to another origin/protocol-relative URL', async () => {
    await assert.rejects(client.authorizedFetch('https://media.puuk.fun/anything'));
    await assert.rejects(client.apiClient('//evil.test/api/tracks'));
    assert.equal(requests.length, 0);
  });
});
