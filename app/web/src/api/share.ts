/**
 * Authenticated Share Resolver Client.
 * Conforms to CDN & Share Links Contract v1 (§7.3).
 *
 * Endpoint: GET /api/share/{type}/{id}
 * - Authenticated with current session Bearer token.
 * - Cache-Control: no-store (and fetch cache: 'no-store').
 * - Finite 5-second client-side timeout.
 * - Explicit cancellation and generation fencing after awaits.
 * - No automatic retry storms (retry handled by senior UI).
 * - Bounded errors: 401 (auth), 403/404/410/422 (terminal), 5xx/timeout/network (retryable).
 */

import { authorizedFetch, captureApiSession, assertApiSessionCurrent } from './client.ts';
import { parseShareTarget, isValidTrackId, isValidAlbumId, isValidArtistId, type ShareEntityType } from '../utils/shareLinks.ts';
import type { Track, Album } from '../types/track.ts';

export type { ShareEntityType };

export interface ArtistSummaryDTO {
  id: string;
  name: string;
  track_count?: number;
  album_count?: number;
  artwork?: string | null;
  artwork_url?: string | null;
  coverArt?: string | null;
  share_id?: string;
}

export type TrackDTO = Track;
export type AlbumDTO = Album;

export type ShareEntityPayload = TrackDTO | AlbumDTO | ArtistSummaryDTO;

export interface ShareEntityResponse<T extends ShareEntityPayload = ShareEntityPayload> {
  type: ShareEntityType;
  requested_id: string;
  canonical_id: string;
  canonical_path: string; // Formatter-compatible own-origin path only (e.g. /track/<id>)
  entity: T;
  tracks: TrackDTO[];    // track: [entity]; album: ordered tracks; artist: popular tracks
  albums: AlbumDTO[];    // artist discography; otherwise []
}

export type ShareApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'gone'
  | 'entity_too_large'
  | 'timeout'
  | 'network_error'
  | 'server_error'
  | 'invalid_request'
  | 'invalid_response'
  | 'unsupported';

export interface ShareApiErrorOptions {
  status: number;
  message: string;
  code: ShareApiErrorCode;
  isTerminal?: boolean;
  isRetryable?: boolean;
  isAuth?: boolean;
}

export class ShareApiError extends Error {
  readonly status: number;
  readonly code: ShareApiErrorCode;
  readonly isTerminal: boolean;
  readonly isRetryable: boolean;
  readonly isAuth: boolean;

  constructor(options: ShareApiErrorOptions) {
    super(options.message);
    this.name = 'ShareApiError';
    this.status = options.status;
    this.code = options.code;
    this.isTerminal = Boolean(options.isTerminal);
    this.isRetryable = Boolean(options.isRetryable);
    this.isAuth = Boolean(options.isAuth);
  }
}

export interface FetchShareEntityOptions {
  signal?: AbortSignal;
  timeoutMs?: number; // Defaults to 5000ms per contract §7.3
}

function invalidResponse(): never {
  throw new ShareApiError({ status: 502, code: 'invalid_response', message: 'Некорректный ответ сервера', isTerminal: true });
}
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function safeCatalog(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') return !/[?&](?:mt|md5|token)=/i.test(value);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, child]) => !/^(?:stream_url|sourceUri|headers|authorization|file_path|provenance)$/i.test(key) && safeCatalog(child, depth + 1));
}
function validIdentity(entity: any, type: ShareEntityType, expected?: string): boolean {
  if (!record(entity) || typeof entity.share_id !== 'string') return false;
  const parsed = parseShareTarget(`/${type}/${entity.share_id}`);
  if (!parsed || parsed.hasTrailingSlash || (expected && entity.share_id !== expected)) return false;
  // Legacy album number can be imprecise. The required lossless share_id is authoritative.
  if (type === 'album' && typeof entity.id === 'number') {
    if (!Number.isInteger(entity.id) || entity.id <= 0 || entity.id !== Number(entity.share_id)) return false;
  } else if (String(entity.id) !== entity.share_id) return false;
  return true;
}
function validArtists(artists: unknown): boolean {
  return artists === undefined || (Array.isArray(artists) && artists.every(artist => validIdentity(artist, 'artist') && isValidArtistId(artist.id) && typeof artist.name === 'string'));
}
function validTrack(entity: any, expected?: string): boolean {
  return validIdentity(entity, 'track', expected) && isValidTrackId(entity.id) && typeof entity.title === 'string' && typeof entity.artist === 'string' && typeof entity.duration === 'number' && Number.isFinite(entity.duration) && entity.duration >= 0 && (entity.content_version === null || (typeof entity.content_version === 'string' && /^[a-f0-9]{64}$/.test(entity.content_version))) && (entity.album_share_id === null || (typeof entity.album_share_id === 'string' && isValidAlbumId(entity.album_share_id))) && validArtists(entity.artists) && validArtists(entity.album_artists);
}
function validAlbum(entity: any, expected?: string): boolean {
  return validIdentity(entity, 'album', expected) && typeof entity.title === 'string' && typeof entity.artist === 'string' && validArtists(entity.artists);
}
function validateResponse(data: unknown, type: ShareEntityType, id: string): ShareEntityResponse {
  if (!record(data) || data.type !== type || data.requested_id !== id || typeof data.canonical_id !== 'string' || data.canonical_path !== `/${type}/${data.canonical_id}` || !Array.isArray(data.tracks) || !Array.isArray(data.albums) || !safeCatalog(data)) return invalidResponse();
  const parsed = parseShareTarget(data.canonical_path);
  if (!parsed || parsed.hasTrailingSlash || parsed.type !== type || parsed.id !== data.canonical_id) return invalidResponse();
  if (!data.tracks.every((track: unknown) => validTrack(track)) || !data.albums.every((album: unknown) => validAlbum(album))) return invalidResponse();
  if (type === 'track') {
    if (!validTrack(data.entity, data.canonical_id) || data.tracks.length !== 1 || data.tracks[0].share_id !== data.canonical_id || data.albums.length) return invalidResponse();
  } else if (type === 'album') {
    if (!validAlbum(data.entity, data.canonical_id) || data.tracks.length > 5000 || data.albums.length) return invalidResponse();
  } else if (!validIdentity(data.entity, 'artist', data.canonical_id) || typeof data.entity.name !== 'string' || data.tracks.length > 10 || data.albums.length > 1000) return invalidResponse();
  return data as unknown as ShareEntityResponse;
}
/** One bounded authenticated lookup, including body decoding; abort is also a publication fence. */
export async function fetchShareEntity<T extends ShareEntityPayload = ShareEntityPayload>(type: ShareEntityType, id: string, options: FetchShareEntityOptions = {}): Promise<ShareEntityResponse<T>> {
  const parsed = parseShareTarget(`/${type}/${id}`);
  if (!parsed || parsed.hasTrailingSlash) throw new ShareApiError({ status: 400, code: 'invalid_request', message: 'Некорректная ссылка', isTerminal: true });
  const session = captureApiSession();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, Math.min(5000, options.timeoutMs ?? 5000)));
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const cancelled = new Promise<never>((_, reject) => {
    const fail = () => reject(new ShareApiError({ status: 0, code: timedOut ? 'timeout' : 'network_error', message: timedOut ? 'Не удалось загрузить. Повторите попытку' : 'Запрос отменён', isRetryable: timedOut }));
    if (controller.signal.aborted) fail(); else controller.signal.addEventListener('abort', fail, { once: true });
  });
  const guard = () => {
    assertApiSessionCurrent(session);
    if (controller.signal.aborted) throw new Error('cancelled');
  };
  const operation = async () => {
    guard();
    const response = await authorizedFetch(`/api/share/${type}/${id}`, { cache: 'no-store', headers: { 'Cache-Control': 'no-store' }, signal: controller.signal });
    guard();
    if (response.status === 200) {
      const data = await response.json().catch(() => invalidResponse());
      guard();
      return validateResponse(data, type, id) as ShareEntityResponse<T>;
    }
    const status = response.status;
    if (status === 401) throw new ShareApiError({ status, code: 'unauthorized', message: 'Требуется вход', isAuth: true });
    if ([403,404,410,422].includes(status)) {
      if (status === 404) {
        const body = await response.json().catch(() => null);
        guard();
        if (body?.detail === 'Not Found') throw new ShareApiError({ status, code: 'unsupported', message: 'Обновите сервер', isTerminal: true });
      }
      throw new ShareApiError({ status, code: status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 410 ? 'gone' : 'entity_too_large', message: status === 403 ? 'Нет доступа' : status === 422 ? 'Слишком большая коллекция' : 'Недоступно', isTerminal: true });
    }
    if (status === 405) throw new ShareApiError({ status, code: 'unsupported', message: 'Обновите сервер', isTerminal: true });
    throw new ShareApiError({ status, code: 'server_error', message: 'Не удалось загрузить. Повторите попытку', isRetryable: true });
  };
  try { return await Promise.race([operation(), cancelled]); }
  catch (error) {
    if (error instanceof ShareApiError) throw error;
    throw new ShareApiError({ status: 0, code: 'network_error', message: 'Не удалось загрузить. Повторите попытку', isRetryable: !controller.signal.aborted });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
