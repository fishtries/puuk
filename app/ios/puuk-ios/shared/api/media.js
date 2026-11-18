import { jwtExpiry } from '../../offline/session';
import {
  authFetch, SERVER_URL, getAuthSessionGeneration, getAuthToken,
  getCachedUser, getCachedAuthToken, addSessionListener,
} from './api';

export const CDN_DELIVERY_ENABLED = process.env.EXPO_PUBLIC_CDN_DELIVERY_ENABLED === 'true';
export const MEDIA_ORIGIN = 'https://media.puuk.fun';
export const MAX_CACHE_BYTES = 500 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
export const monotonicNow = () => globalThis.performance.now();
export class MediaDeliveryError extends Error {
  constructor(code, status = null) {
    super('Не удалось получить аудио');
    this.name = 'MediaDeliveryError';
    this.code = code;
    this.status = status;
    this.type = status === 401 ? 'auth' : ['invalid_ticket', 'invalid_url'].includes(code) ? 'security' : code;
    this.terminal = [401, 403, 404, 410].includes(status) || this.type === 'security';
  }
}

export function mediaSession() {
  const user = getCachedUser();
  return { origin: new URL(SERVER_URL).origin, userId: user?.id == null ? null : String(user.id), generation: getAuthSessionGeneration() };
}
export function hasOfflineSession() {
  return jwtExpiry(getCachedAuthToken(), mediaSession().userId) > Date.now();
}
const sessionKey = (s) => `${s.origin}|${s.userId}|${s.generation}`;
export const isMediaSessionCurrent = (s) => sessionKey(s) === sessionKey(mediaSession());

// Own timeout includes SecureStore, transport AND JSON decoding. A canceled
// transport may finish later; callers must still fence publication after awaits.
export async function boundedMediaOperation(work, { signal, timeout = 3000 } = {}) {
  const controller = new AbortController();
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(new MediaDeliveryError('abort')); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new MediaDeliveryError('timeout')); }, Math.max(1, timeout));
  });
  try { return await Promise.race([Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new MediaDeliveryError('abort');
    return work(controller.signal);
  }), stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

export function validateMediaUrl(raw, { origin, trackId, delivery, contentVersion }) {
  if (typeof raw !== 'string' || /[\\\x00-\x20%#]/.test(raw) || raw.includes('//', raw.indexOf('://') + 3)) throw new MediaDeliveryError('invalid_url');
  const base = delivery === 'cdn' ? MEDIA_ORIGIN : origin;
  // Inspect raw grammar before URL normalization can erase dot segments/ports.
  const path = delivery === 'cdn' ? `/cdn/audio/${trackId}/${contentVersion}` : `/api/stream/${trackId}`;
  let relative = raw;
  if (!raw.startsWith('/')) {
    if (!raw.startsWith(`${base}/`)) throw new MediaDeliveryError('invalid_url');
    relative = raw.slice(base.length);
  } else if (delivery === 'cdn') throw new MediaDeliveryError('invalid_url');
  const [rawPath, query, extra] = relative.split('?');
  if (rawPath !== path || extra !== undefined) throw new MediaDeliveryError('invalid_url');
  if (delivery === 'cdn') {
    if (!query || query.length > 128) throw new MediaDeliveryError('invalid_url');
    const pairs = query.split('&');
    if (pairs.length !== 2 || new Set(pairs.map(p => p.split('=')[0])).size !== 2 ||
      !pairs.every(p => /^(md5=[A-Za-z0-9_-]{22}|expires=[1-9][0-9]{0,9})$/.test(p))) throw new MediaDeliveryError('invalid_url');
  } else if (!query || !/^mt=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(query)) throw new MediaDeliveryError('invalid_url');
  const uri = `${base}${relative}`;
  const parsed = new URL(uri);
  if (parsed.origin !== base || parsed.username || parsed.password) throw new MediaDeliveryError('invalid_url');
  return uri;
}

export function validateMediaTicket(dto, { trackId, session, startedAt, now, requested = 'direct' }) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || now < startedAt) throw new MediaDeliveryError('invalid_ticket');
  const legacy = dto && dto.delivery === undefined;
  if (!dto || !UUID.test(trackId) || !Number.isInteger(dto.expires_in) || dto.expires_in <= 0 ||
    dto.expires_in > (legacy ? 86400 : 1800) || (!Number.isSafeInteger(dto.expires_at) || dto.expires_at <= 0 || dto.expires_at > 9999999999)) throw new MediaDeliveryError('invalid_ticket');
  const delivery = legacy ? 'direct' : dto.delivery;
  if (!['direct', 'cdn'].includes(delivery) || (requested === 'direct' && delivery !== 'direct')) throw new MediaDeliveryError('invalid_ticket');
  if (!legacy && ((!Number.isSafeInteger(dto.server_time) || dto.server_time <= 0) || Math.abs(dto.expires_at - dto.server_time - dto.expires_in) > 1 ||
    !Number.isInteger(dto.cache_for) || dto.cache_for < 0 || dto.cache_for > 30 ||
    typeof dto.delivery_epoch !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(dto.delivery_epoch))) throw new MediaDeliveryError('invalid_ticket');
  const version = legacy ? null : dto.content_version;
  const length = legacy ? null : dto.content_length;
  const binding = legacy ? null : dto.download_binding;
  const declared = HASH.test(version) && Number.isSafeInteger(length) && length > 0;
  if (!legacy && !(version === null && length === null && binding === null) &&
    !(declared && binding === (delivery === 'cdn' ? 'immutable-path' : 'if-match'))) throw new MediaDeliveryError('invalid_ticket');
  if (delivery === 'cdn' && !declared) throw new MediaDeliveryError('invalid_ticket');
  const usableUntil = startedAt + Math.max(0, Math.min(dto.expires_in, legacy ? dto.expires_in : dto.expires_at - dto.server_time) - 30) * 1000;
  if (now >= usableUntil) throw new MediaDeliveryError('invalid_ticket');
  const uri = validateMediaUrl(dto.url, { origin: session.origin, trackId, delivery, contentVersion: version });
  if (delivery === 'cdn' && Number(new URL(uri).searchParams.get('expires')) !== dto.expires_at) throw new MediaDeliveryError('invalid_ticket');
  return Object.freeze({ uri, headers: {}, delivery, contentVersion: version, contentLength: length,
    downloadBinding: binding, trackId, session, generation: session.generation, usableUntil,
    reuseUntil: Math.min(usableUntil, startedAt + Math.min(legacy ? 30 : dto.cache_for, 30) * 1000),
    deliveryEpoch: legacy ? 'legacy' : dto.delivery_epoch, cacheable: declared && length <= MAX_CACHE_BYTES, legacy });
}

export class MediaDelivery {
  constructor({ fetch = authFetch, clock = monotonicNow, session = mediaSession, enabled = CDN_DELIVERY_ENABLED, token = getAuthToken } = {}) {
    this.fetch = fetch; this.clock = clock; this.session = session; this.enabled = enabled; this.token = token;
    this.running = new Set(); this.cache = new Map(); this.pending = new Map(); this.negative = new Map(); this.epoch = 0; this.lastClock = -Infinity;
  }
  invalidate() {
    this.epoch++;
    this.cache.clear(); this.negative.clear();
    for (const entry of this.pending.values()) entry.controller.abort();
  }
  resolve(track, { mode = this.enabled ? 'cdn' : 'direct', force = false, signal, priority = 'current', timeout = 3000, consumeNegotiation = () => false } = {}) {
    const trackId = String(track?.id ?? track?.track_id ?? track);
    if (!UUID.test(trackId)) return Promise.reject(new MediaDeliveryError('invalid_ticket'));
    const s = this.session(), now = this.clock();
    if (!Number.isFinite(now)) { this.invalidate(); return Promise.reject(new MediaDeliveryError('invalid_ticket')); }
    if (now < this.lastClock) this.invalidate();
    this.lastClock = now;
    const key = `${sessionKey(s)}|${trackId}|${track?.content_version || ''}|${mode}`;
    const hit = this.cache.get(key);
    if (!force && hit && now < hit.reuseUntil) { this.cache.delete(key); this.cache.set(key, hit); return Promise.resolve({ ...hit, headers: {} }); }
    const existing = this.pending.get(key);
    if (existing && !existing.controller.signal.aborted) {
      if (priority === 'current' && existing.priority !== 'current') existing.controller.abort();
      else return existing.promise;
    }
    // Reserve a lane for current playback; canceled lanes remain occupied until settlement.
    if (priority === 'current') for (const e of this.pending.values()) if (e.priority !== 'current') e.controller.abort();
    if (this.running.size >= (priority === 'current' ? 8 : 7)) return Promise.reject(new MediaDeliveryError('busy'));
    const controller = new AbortController(), epoch = this.epoch;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const current = () => !controller.signal.aborted && this.epoch === epoch && sessionKey(this.session()) === sessionKey(s);
    const entry = { controller, priority, promise: null };
    this.running.add(entry);

    entry.promise = boundedMediaOperation(requestSignal => {
      entry.started = true;
      const work = (async () => {
      const startedAt = this.clock();
      const unsupported = this.negative.get(s.origin);
      if (unsupported && startedAt < unsupported) {
        const token = await this.token();
        if (!current() || requestSignal.aborted || !token) throw new MediaDeliveryError('abort');
        return { uri: `${s.origin}/api/stream/${trackId}`, headers: { Authorization: `Bearer ${token}` }, delivery: 'direct',
          trackId, session: s, generation: s.generation, usableUntil: startedAt + 30000, reuseUntil: startedAt, cacheable: false, legacy: true };
      }
      let response = await this.fetch('/api/media-ticket', { method: 'POST', body: { track_id: trackId, delivery: mode },
        retry: 0, timeout: Math.min(timeout, 3000), signal: requestSignal, cache: 'no-store', redirect: 'error', credentials: 'omit' });
      if (!current()) throw new MediaDeliveryError('abort');
      if (!response.ok) {
        // Track 404 is terminal. Only an explicit route/schema error proves incompatibility.
        let detail;
        if ([404, 405, 422].includes(response.status)) { try { detail = await response.json(); } catch {} }
        const absent = response.status === 405 || (response.status === 404 && detail?.detail === 'Not Found');
        const unsupportedDelivery = response.status === 422 && Array.isArray(detail?.detail) && detail.detail.some(e => e.loc?.join('.') === 'body.delivery' && /extra|unexpected|unsupported/.test(e.type || ''));
        if ((absent || unsupportedDelivery) && consumeNegotiation()) {
          if (absent) {
            this.negative.set(s.origin, this.clock() + 300000);
            while (this.negative.size > 8) this.negative.delete(this.negative.keys().next().value);
            const token = await this.token();
            if (!current() || requestSignal.aborted || !token) throw new MediaDeliveryError('abort');
            return { uri: `${s.origin}/api/stream/${trackId}`, headers: { Authorization: `Bearer ${token}` }, delivery: 'direct', trackId,
              session: s, generation: s.generation, usableUntil: startedAt + 30000, reuseUntil: startedAt, cacheable: false, legacy: true };
          }
          response = await this.fetch('/api/media-ticket', { method: 'POST', body: { track_id: trackId }, retry: 0,
            timeout: Math.min(timeout, 3000), signal: requestSignal, cache: 'no-store', redirect: 'error', credentials: 'omit' });
        }
        if (!response.ok) throw new MediaDeliveryError('ticket_error', response.status);
      }
      const dto = await response.json();
      if (!current() || requestSignal.aborted) throw new MediaDeliveryError('abort');
      if (response.redirected || (response.url && response.url !== `${s.origin}/api/media-ticket`)) throw new MediaDeliveryError('invalid_url');
      const value = validateMediaTicket(dto, { trackId, session: s, startedAt, now: this.clock(), requested: mode });
      for (const [k, v] of this.cache) if (v.trackId === trackId && (v.contentVersion !== value.contentVersion || v.deliveryEpoch !== value.deliveryEpoch)) this.cache.delete(k);
      this.cache.set(key, value);
      while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
      return { ...value, headers: {} };
      })();
      work.finally(() => { this.running.delete(entry); }).catch(() => {});
      return work;
    }, { signal: controller.signal, timeout: Math.min(3000, timeout) }).catch(e => {
      // Never retain raw native/fetch errors, which may contain permission URLs.
      if (e instanceof MediaDeliveryError) throw e;
      throw new MediaDeliveryError(e?.type === 'abort' ? 'abort' : e?.type === 'timeout' ? 'timeout' : 'network');
    }).finally(() => { if (controller.signal.aborted && !entry.started) this.running.delete(entry); signal?.removeEventListener('abort', cancel); if (this.pending.get(key) === entry) this.pending.delete(key); });
    this.pending.set(key, entry);
    return entry.promise;
  }
}
export const mediaDelivery = new MediaDelivery();
if (typeof addSessionListener === 'function') addSessionListener(() => mediaDelivery.invalidate());
