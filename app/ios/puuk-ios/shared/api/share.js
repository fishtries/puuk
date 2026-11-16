import { authFetch, ApiError, getAuthSessionGeneration, SERVER_URL } from './api';
import { parseShareUrl, formatShareUrl, extractEntityShareId } from '../../utils/shareLinks';
import { boundedMediaOperation } from './media';
export const SHARE_API_TIMEOUT_MS = 5000;
export class ShareApiError extends ApiError {
  constructor(code, status = null) {
    super('Не удалось открыть ссылку', { code, status, type: status === 401 ? 'auth' : status === 404 ? 'notFound' : status === 410 ? 'gone' : code });
    this.name = 'ShareApiError'; this.isGone = status === 410; this.isNotFound = status === 404; this.isForbidden = status === 403;
  }
}
const fields = {
  track: ['id', 'share_id', 'title', 'artist', 'artists', 'album', 'album_id', 'album_share_id', 'duration', 'coverArt', 'cover_version', 'normalization_gain_db', 'loudness_status', 'loudness_lufs', 'true_peak_db', 'content_version', 'is_liked', 'track_number', 'disc_number'],
  album: ['id', 'share_id', 'title', 'artist', 'artists', 'album_artist', 'year', 'coverArt', 'track_count', 'duration'],
  artist: ['id', 'share_id', 'name', 'track_count', 'album_count', 'artwork', 'artwork_url', 'coverArt'],
};
function cleanEntity(entity, type) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) throw new ShareApiError('invalid_response');
  const id = extractEntityShareId(entity, type);
  if (entity.share_id !== id || (type !== 'album' && entity.id !== id) || (type === 'album' && (typeof entity.id === 'string' || Number.isSafeInteger(entity.id)) && String(entity.id) !== id)) throw new ShareApiError('invalid_response');
  const result = {};
  for (const key of fields[type]) {
    const value = entity[key];
    if (key === 'artists' && Array.isArray(value)) result[key] = value.map(e => cleanEntity(e, 'artist'));
    else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      if (typeof value === 'string' && /(?:[?&](?:mt|md5|expires|token)=|Bearer\s)/i.test(value)) throw new ShareApiError('invalid_response');
      result[key] = value;
    }
  }
  return result;
}
export function validateShareResponse(data, type, id) {
  if (!data || data.type !== type || data.requested_id !== id || typeof data.canonical_id !== 'string' ||
    data.canonical_path !== formatShareUrl(type, data.canonical_id).slice('https://web.puuk.fun'.length) ||
    extractEntityShareId(data.entity, type) !== data.canonical_id || !Array.isArray(data.tracks) || !Array.isArray(data.albums) ||
    data.tracks.length > (type === 'artist' ? 10 : type === 'track' ? 1 : 5000) || data.albums.length > (type === 'artist' ? 1000 : 0)) throw new ShareApiError('invalid_response');
  if (type === 'track' && (data.tracks.length !== 1 || extractEntityShareId(data.tracks[0], 'track') !== data.canonical_id)) throw new ShareApiError('invalid_response');
  return { type, requested_id: id, canonical_id: data.canonical_id, canonical_path: data.canonical_path,
    entity: cleanEntity(data.entity, type), tracks: data.tracks.map(t => cleanEntity(t, 'track')), albums: data.albums.map(a => cleanEntity(a, 'album')) };
}
export async function fetchShareEntity(type, id, options = {}) {
  try { if (typeof id !== 'string') throw new Error(); formatShareUrl(type, id); } catch { throw new ShareApiError('invalid_id'); }
  const generation = getAuthSessionGeneration(), server = SERVER_URL;
  try {
    return await boundedMediaOperation(async signal => {
      const response = await authFetch(`/api/share/${type}/${id}`, { method: 'GET', retry: 0, timeout: 5000, signal, cache: 'no-store', redirect: 'error', credentials: 'omit' });
      if (response.status === 401) throw new ShareApiError('http_error', 401);
      if (generation !== getAuthSessionGeneration() || server !== SERVER_URL || signal.aborted) throw new ShareApiError('abort');
      if (!response.ok) throw new ShareApiError('http_error', response.status);
      if (response.redirected || (response.url && response.url !== `${server}/api/share/${type}/${id}`)) throw new ShareApiError('invalid_response');
      const data = await response.json();
      if (generation !== getAuthSessionGeneration() || server !== SERVER_URL || signal.aborted) throw new ShareApiError('abort');
      return validateShareResponse(data, type, id);
    }, { signal: options.signal, timeout: Math.min(Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 5000, 5000) });
  } catch (e) {
    if (e instanceof ShareApiError) throw e;
    throw new ShareApiError(['abort', 'timeout'].includes(e?.code) ? e.code : 'invalid_response');
  }
}
export function resolveShareUrl(url, options) {
  const parsed = parseShareUrl(url);
  if (!parsed) return Promise.reject(new ShareApiError('invalid_url'));
  return fetchShareEntity(parsed.type, parsed.id, options);
}
