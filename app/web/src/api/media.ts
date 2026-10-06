import { API_BASE_URL, apiClient, authorizedFetch, isTrustedApiOrigin } from './client';

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

  const response = await authorizedFetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  rememberObjectUrl(sourceUrl, objectUrl);
  return objectUrl;
}

export interface MediaTicketResponse {
  url: string;
  expires_in: number;
  expires_at?: number;
}

const TICKET_CACHE_LIMIT = 200;
const TICKET_EXPIRY_MARGIN_MS = 5_000;

interface CachedTicket {
  url: string;
  expiresAtMs: number;
  authToken: string | null;
}

const ticketByTrackId = new Map<string, CachedTicket>();

function ticketExpiresAtMs(ticket: MediaTicketResponse): number {
  if (typeof ticket.expires_at === 'number' && Number.isFinite(ticket.expires_at)) {
    return ticket.expires_at * 1000;
  }
  return Date.now() + Math.max(0, ticket.expires_in) * 1000;
}

function rememberTicket(trackId: string, entry: CachedTicket): void {
  ticketByTrackId.delete(trackId);
  ticketByTrackId.set(trackId, entry);

  while (ticketByTrackId.size > TICKET_CACHE_LIMIT) {
    const oldest = ticketByTrackId.keys().next().value;
    if (oldest === undefined) break;
    ticketByTrackId.delete(oldest);
  }
}

export function invalidateAudioTicket(trackId: string): void {
  ticketByTrackId.delete(trackId);
}

export function resetAudioTicketCache(): void {
  ticketByTrackId.clear();
}

/**
 * Потоковый URL аудио с media-тикетом. Билет запрашивается по Bearer
 * (обычный apiClient-вызов), сам <audio> играет прямой URL /api/stream/{id}?mt=...
 * — браузер начинает воспроизведение на первых чанках и тянет остальное
 * по Range, не дожидаясь полного файла.
 *
 * Тикеты кэшируются по track_id до истечения срока (expires_at от сервера):
 * повторное включение того же трека не порождает лишний запрос media-ticket.
 */
export async function resolveAuthorizedAudioUrl(trackId: string): Promise<string> {
  const authToken = localStorage.getItem('puuk_token');
  const cached = ticketByTrackId.get(trackId);
  if (cached) {
    if (
      cached.authToken === authToken &&
      cached.expiresAtMs - Date.now() > TICKET_EXPIRY_MARGIN_MS
    ) {
      // LRU: освежаем позицию, чтобы живые тикеты не вытеснялись
      ticketByTrackId.delete(trackId);
      ticketByTrackId.set(trackId, cached);
      return cached.url;
    }
    ticketByTrackId.delete(trackId);
  }

  const ticket = await apiClient<MediaTicketResponse>('/api/media-ticket', {
    method: 'POST',
    body: JSON.stringify({ track_id: trackId }),
  });
  if (!ticket?.url) {
    throw new Error('Media ticket response has no url');
  }
  const url = ticket.url.startsWith('/') ? `${API_BASE_URL}${ticket.url}` : ticket.url;
  rememberTicket(trackId, { url, expiresAtMs: ticketExpiresAtMs(ticket), authToken });
  return url;
}
