import { API_BASE_URL, authorizedFetch, isTrustedApiOrigin, captureApiSession, assertApiSessionCurrent, onApiSessionChange, type ApiSession } from './client.ts';
import { isValidTrackId } from '../utils/shareLinks.ts';

// Обложки (небольшие файлы) качаются авторизованным fetch в blob: URL.
// Аудио так не грузится: blob ждёт ВЕСЬ файл, и 30-минутный трек блокировал
// переключение на десятки секунд. Аудио стримится напрямую — /api/stream/{id}
// с короткоживущим media-тикетом (JWT, привязанный к треку, TTL 10 мин),
// потому что <audio> не умеет отправлять Authorization-заголовок.
const CACHE_LIMIT = 120;

const objectUrlBySource = new Map<string, string>();
const sourceByObjectUrl = new Map<string, string>();

export function resolveMediaSource(objectUrl: string): string {
  return sourceByObjectUrl.get(objectUrl) ?? objectUrl;
}

function revokeObjectUrl(objectUrl: string): void {
  const source = sourceByObjectUrl.get(objectUrl);
  if (source !== undefined) {
    sourceByObjectUrl.delete(objectUrl);
    if (objectUrlBySource.get(source) === objectUrl) {
      objectUrlBySource.delete(source);
    }
  }
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(objectUrl);
  }
}

function rememberObjectUrl(sourceUrl: string, objectUrl: string): void {
  objectUrlBySource.set(sourceUrl, objectUrl);
  sourceByObjectUrl.set(objectUrl, sourceUrl);

  while (objectUrlBySource.size > CACHE_LIMIT) {
    const oldest = objectUrlBySource.keys().next().value;
    if (oldest === undefined) break;
    const oldestObjectUrl = objectUrlBySource.get(oldest);
    if (oldestObjectUrl !== undefined) {
      revokeObjectUrl(oldestObjectUrl);
    } else {
      break;
    }
  }
}

function isForeignCdnUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && !isTrustedApiOrigin(url);
}

export async function fetchAuthorizedBlobUrl(sourceUrl: string): Promise<string> {
  if (!sourceUrl) {
    throw new Error('Empty media URL');
  }
  if (sourceUrl.startsWith('blob:') || isForeignCdnUrl(sourceUrl)) {
    return sourceUrl;
  }

  const cached = objectUrlBySource.get(sourceUrl);
  if (cached) {
    // LRU: освежаем позицию, чтобы живые обложки не вытеснялись
    objectUrlBySource.delete(sourceUrl);
    objectUrlBySource.set(sourceUrl, cached);
    return cached;
  }

  const session = captureApiSession();
  const response = await authorizedFetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const blob = await response.blob();
  assertApiSessionCurrent(session);
  const objectUrl = URL.createObjectURL(blob);
  rememberObjectUrl(sourceUrl, objectUrl);
  return objectUrl;
}

/** Public build capability only; absence/anything except literal true stays direct. */
export const CDN_DELIVERY_ENABLED = (import.meta as any).env?.VITE_CDN_DELIVERY_ENABLED === 'true';
export type DeliveryMode = 'direct' | 'cdn';
export interface AudioDelivery {
  url: string;
  delivery: DeliveryMode;
  contentVersion: string | null;
  deliveryEpoch: string;
  usableUntil: number;
  reuseUntil: number;
  permissionGeneration: number;
  session: ApiSession;
}
export class MediaDeliveryError extends Error {
  readonly code: 'invalid_response' | 'unavailable' | 'unauthorized' | 'network' | 'timeout' | 'cancelled' | 'busy' | 'unsupported';
  readonly status: number;
  readonly canNegotiate: boolean;
  constructor(code: 'invalid_response' | 'unavailable' | 'unauthorized' | 'network' | 'timeout' | 'cancelled' | 'busy' | 'unsupported', status = 0, canNegotiate = false) {
    super(code === 'unsupported' ? 'Обновите сервер' : code === 'unavailable' ? 'Трек недоступен' : code === 'unauthorized' ? 'Требуется вход' : code === 'invalid_response' ? 'Некорректный ответ сервера' : 'Не удалось загрузить аудио. Повторите попытку');
    this.name = 'MediaDeliveryError';
    this.code = code; this.status = status; this.canNegotiate = canNegotiate;
  }
}
interface DeliveryOptions {
  mode?: DeliveryMode;
  force?: boolean;
  legacy?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  contentVersion?: string | null;
}
const tickets = new Map<string, AudioDelivery>();
const pending = new Map<string, { controller: AbortController; promise: Promise<AudioDelivery> }>();
let permissionGeneration = 0;
let lastMonotonic = 0;
let legacyUntil = 0;
export function deliveryNow(): number {
  const now = performance.now();
  if (now < lastMonotonic) resetAudioTicketCache();
  lastMonotonic = now;
  return now;
}
export function isAudioDeliveryUsable(source: AudioDelivery): boolean {
  const now = deliveryNow(); // A monotonic reset invalidates permissions before comparison.
  return source.permissionGeneration === permissionGeneration && now < source.usableUntil;
}
export function invalidateAudioTicket(trackId: string): void {
  for (const [key] of tickets) if (key.split('|')[2] === trackId) tickets.delete(key);
}
export function resetAudioTicketCache(): void {
  permissionGeneration += 1;
  tickets.clear();
  for (const entry of pending.values()) entry.controller.abort();
  pending.clear();
}
onApiSessionChange(() => { legacyUntil = 0; resetAudioTicketCache(); for (const url of sourceByObjectUrl.keys()) revokeObjectUrl(url); });
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { legacyUntil = 0; resetAudioTicketCache(); }
});
function invalid(): never { throw new MediaDeliveryError('invalid_response'); }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }
function validateTicket(raw: unknown, trackId: string, mode: DeliveryMode, start: number, session: ApiSession, permission: number): AudioDelivery {
  if (!raw || typeof raw !== 'object') return invalid();
  const t = raw as Record<string, unknown>;
  const modern = t.delivery !== undefined;
  if (typeof t.url !== 'string' || !integer(t.expires_in) || t.expires_in <= 0 || t.expires_in > (modern ? 1800 : 86400)) return invalid();
  if (t.expires_at !== undefined && (!integer(t.expires_at) || t.expires_at <= 0)) return invalid();
  let ttl = t.expires_in;
  let lease = 30;
  let version: string | null = null;
  let epoch = 'legacy';
  const delivery = modern ? t.delivery : 'direct';
  if (delivery !== 'direct' && delivery !== 'cdn') return invalid();
  if (delivery === 'cdn' && mode !== 'cdn') return invalid();
  if (modern) {
    if (!integer(t.server_time) || !integer(t.expires_at) || t.server_time <= 0 || Math.abs(t.expires_at - t.server_time - ttl) > 1 || !integer(t.cache_for) || t.cache_for < 0 || t.cache_for > 30 || typeof t.delivery_epoch !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(t.delivery_epoch)) return invalid();
    ttl = Math.min(ttl, t.expires_at - t.server_time);
    lease = t.cache_for;
    epoch = t.delivery_epoch;
    if (t.content_version !== null && (typeof t.content_version !== 'string' || !/^[a-f0-9]{64}$/.test(t.content_version))) return invalid();
    version = t.content_version as string | null;
    if (version === null) {
      if (delivery !== 'direct' || t.content_length !== null || t.download_binding !== null) return invalid();
    } else if (!integer(t.content_length) || t.content_length <= 0 || t.download_binding !== (delivery === 'cdn' ? 'immutable-path' : 'if-match')) return invalid();
  }
  const url = t.url;
  if (/[\\\s%#]/.test(url) || url.length > 8192) return invalid();
  if (delivery === 'cdn') {
    if (!version) return invalid();
    const prefix = `https://media.puuk.fun/cdn/audio/${trackId}/${version}?`;
    if (!url.startsWith(prefix)) return invalid();
    const query = url.slice(prefix.length);
    if (!/^(?:md5=[A-Za-z0-9_-]{22}&expires=[1-9][0-9]{0,9}|expires=[1-9][0-9]{0,9}&md5=[A-Za-z0-9_-]{22})$/.test(query)) return invalid();
    if (new URLSearchParams(query).get('expires') !== String(t.expires_at)) return invalid();
  } else {
    const path = `/api/stream/${trackId}?mt=`;
    const origin = session.origin;
    const relative = url.startsWith(path) ? url : url.startsWith(`${origin}${path}`) ? url.slice(origin.length) : '';
    if (!relative.startsWith(path) || !/^[A-Za-z0-9_.-]+$/.test(relative.slice(path.length)) || relative.slice(path.length) === session.token) return invalid();
  }
  const usableUntil = start + Math.max(0, ttl - 30) * 1000;
  if (deliveryNow() >= usableUntil) return invalid();
  return { url: url.startsWith('/') ? `${API_BASE_URL}${url}` : url, delivery, contentVersion: version, deliveryEpoch: epoch, usableUntil, reuseUntil: Math.min(usableUntil, start + lease * 1000), permissionGeneration: permission, session };
}
/** One HTTP attempt. Compatibility/recovery attempts belong exclusively to the player store. */
export function resolveAudioDelivery(trackId: string, options: DeliveryOptions = {}): Promise<AudioDelivery> {
  const session = captureApiSession();
  if (!isValidTrackId(trackId)) return Promise.reject(new MediaDeliveryError('invalid_response'));
  if (!session.token) return Promise.reject(new MediaDeliveryError('unauthorized', 401));
  const mode = options.mode === 'direct' ? 'direct' : CDN_DELIVERY_ENABLED ? 'cdn' : 'direct';
  const start = deliveryNow();
  const legacy = options.legacy || legacyUntil > start;
  const baseKey = `${session.origin}|${session.generation}|${trackId}|${mode}|${legacy ? 'legacy' : 'v1'}`;
  if (!options.force) {
    for (const [key, ticket] of tickets) if (key.startsWith(`${baseKey}|`) && ticket.reuseUntil > start && (options.contentVersion == null || ticket.contentVersion === options.contentVersion)) {
      tickets.delete(key); tickets.set(key, ticket);
      return Promise.resolve(ticket);
    }
  }
  const existing = pending.get(baseKey);
  if (existing && !existing.controller.signal.aborted) return existing.promise;
  if (existing) pending.delete(baseKey);
  if (pending.size >= 8) return Promise.reject(new MediaDeliveryError('busy'));
  const controller = new AbortController();
  const permission = permissionGeneration;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Math.min(3000, options.timeoutMs ?? 3000)));
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const cancelled = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(new MediaDeliveryError(timedOut ? 'timeout' : 'cancelled'));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const operation = async (): Promise<AudioDelivery> => {
    const response = await authorizedFetch('/api/media-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track_id: trackId, ...(!legacy && (CDN_DELIVERY_ENABLED || options.mode === 'direct') ? { delivery: mode } : {}) }), cache: 'no-store', signal: controller.signal });
    assertApiSessionCurrent(session);
    if (controller.signal.aborted || permission !== permissionGeneration) throw new MediaDeliveryError('cancelled');
    if (!response.ok) {
      let unsupported = response.status === 405;
      if (response.status === 404 || response.status === 422) {
        const body = await response.json().catch(() => null);
        assertApiSessionCurrent(session);
        unsupported = response.status === 404 ? body?.detail === 'Not Found' : Array.isArray(body?.detail) && body.detail.some((item: any) => Array.isArray(item.loc) && item.loc.at(-1) === 'delivery');
      }
      if (unsupported) throw new MediaDeliveryError('unsupported', response.status, !legacy);
      throw new MediaDeliveryError(response.status === 401 ? 'unauthorized' : [403,404,410].includes(response.status) ? 'unavailable' : 'network', response.status);
    }
    const raw = await response.json();
    assertApiSessionCurrent(session);
    if (controller.signal.aborted || permission !== permissionGeneration) throw new MediaDeliveryError('cancelled');
    const result = validateTicket(raw, trackId, mode, start, session, permission);
    for (const [key, ticket] of tickets) if (key.split('|')[2] === trackId && (ticket.contentVersion !== result.contentVersion || ticket.deliveryEpoch !== result.deliveryEpoch)) tickets.delete(key);
    const key = `${baseKey}|${result.contentVersion ?? ''}|${result.deliveryEpoch}`;
    tickets.set(key, result);
    while (tickets.size > 200) tickets.delete(tickets.keys().next().value!);
    if (legacy) legacyUntil = deliveryNow() + 300_000;
    return result;
  };
  const promise = Promise.race([operation(), cancelled]).catch((error: unknown) => {
    if (error instanceof MediaDeliveryError) throw error;
    throw new MediaDeliveryError(controller.signal.aborted ? 'cancelled' : 'network');
  }).finally(() => {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    if (pending.get(baseKey)?.promise === promise) pending.delete(baseKey);
  });
  pending.set(baseKey, { controller, promise });
  return promise;
}
export async function resolveAuthorizedAudioUrl(trackId: string): Promise<string> {
  return (await resolveAudioDelivery(trackId)).url;
}
