import { fetchCatalogWithCache } from './apiCache';
import { SERVER_URL } from './api';
import { normalizeTrack } from '../domain/trackAdapter';

export const RECENTLY_LISTENED_CACHE_KEY = 'recently-listened-v1-limit-100';
export const RECENTLY_LISTENED_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Normalizes an array of raw history items into valid track objects.
 * Invalid items (e.g. missing or invalid ID) are discarded.
 *
 * @param {Array<Object>|null|undefined} rawTracks
 * @param {string} [serverUrl]
 * @returns {Array<Object>}
 */
export function normalizeHistoryTracks(rawTracks, serverUrl) {
  if (!Array.isArray(rawTracks)) return [];
  return rawTracks
    .map((item) => normalizeTrack(item, { serverUrl }))
    .filter(Boolean);
}

/**
 * Fetches up to 100 recent tracks from /api/history?limit=100 with 1-hour cache.
 * Uses fetchCatalogWithCache with strict Array.isArray validation to prevent corrupted or
 * non-array API responses from overwriting valid cached data.
 *
 * @param {Object} [options]
 * @param {number|string|null} [options.userId]
 * @param {string} [options.serverUrl]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.forceRefresh]
 * @param {Function} [options.onData]
 * @param {Function} [options.onCachedData]
 * @param {Function} [options.onFreshData]
 * @param {Function} [options.onError]
 * @returns {Promise<{ data: Array<Object>, fromCache: boolean, isStale: boolean, error?: Error }>}
 */
export async function fetchRecentlyListened(options = {}) {
  const serverUrl = options.serverUrl || SERVER_URL || '';
  const endpoint = '/api/history?limit=100';

  const mapNormalized = (data) => normalizeHistoryTracks(data, serverUrl);

  const result = await fetchCatalogWithCache(endpoint, {
    key: RECENTLY_LISTENED_CACHE_KEY,
    serverUrl,
    userId: options.userId,
    ttlMs: RECENTLY_LISTENED_TTL_MS,
    signal: options.signal,
    forceRefresh: Boolean(options.forceRefresh),
    validate: (data) => Array.isArray(data),
    onData: (data, meta) => {
      if (typeof options.onData === 'function') {
        options.onData(mapNormalized(data), meta);
      }
    },
    onCachedData: (data) => {
      if (typeof options.onCachedData === 'function') {
        options.onCachedData(mapNormalized(data));
      }
    },
    onFreshData: (data) => {
      if (typeof options.onFreshData === 'function') {
        options.onFreshData(mapNormalized(data));
      }
    },
    onError: options.onError,
  });

  return {
    ...result,
    data: mapNormalized(result?.data),
  };
}
