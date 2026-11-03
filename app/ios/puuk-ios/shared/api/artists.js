import { normalizeTrack } from '../domain/trackAdapter';
import { normalizeAlbum } from '../domain/artistCredits';
/**
 * Artist API Client & Types for Puuk iOS.
 * Contract: docs/ARTISTS_SECTION_CONTRACT.md (sections 3 & 4)
 * - GET /api/artists?q=
 * - GET /api/artists/{artistId} => { artist, popular_tracks, albums }
 * - PUT /api/artists/{artistId}/artwork (multipart field 'file', admin only)
 * - DELETE /api/artists/{artistId}/artwork (admin only)
 * - POST /api/tracks/{trackId}/play-start (exactly one bounded retry, no user-visible error)
 * - Media/artwork auth is handled via headers, NEVER in URLs (no ?token= in URLs)
 */

import {
  authFetch,
  SERVER_URL,
  ApiError,
  classifyError,
  parseApiErrorMessage,
} from './api';

/**
 * @typedef {Object} Artist
 * @property {string} id
 * @property {string} name
 * @property {number} track_count
 * @property {number} album_count
 * @property {number} [artwork_version]
 * @property {string|null} [artwork_url]
 */

/**
 * @typedef {Object} ArtistDetail
 * @property {Artist} artist
 * @property {Array<Object>} popular_tracks - Top tracks (at most 10) with play_count
 * @property {Array<Object>} albums - Complete albums list
 */

/**
 * @typedef {Object} PlayStartResult
 * @property {'recorded'|'duplicate'|'ignored'} status
 * @property {string} track_id
 */

/**
 * @typedef {Object} ArtworkUpdateResult
 * @property {string} status
 * @property {string} artist_id
 * @property {number} artwork_version
 */

/**
 * @typedef {Object} ArtworkDeleteResult
 * @property {string} status
 * @property {string} artist_id
 */

/**
 * Strips any auth token parameter from a URL string to guarantee auth is never in URLs.
 *
 * @param {string} url
 * @returns {string}
 */
export function stripTokenFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url
    .replace(/([?&])token=[^&#]*(&|$)/g, (match, prefix, suffix) => {
      return suffix === '&' ? prefix : '';
    })
    .replace(/[?&]$/, '');
}

/**
 * Normalizes an artist artwork URL per Section 4 of ARTISTS_SECTION_CONTRACT:
 * - Redirects /api/artists/ to the active SERVER_URL
 * - Guarantees no auth token is ever in the URL
 * - Does not fallback to track cover (/api/cover/ is rejected per Section 4.5)
 *
 * @param {string} rawUrl
 * @param {Object} [options]
 * @returns {string|null}
 */
export function normalizeArtworkUrl(rawUrl, options = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  // Contract 4.5: Track covers are NEVER artist artwork
  if (trimmed.includes('/api/cover/')) {
    return null;
  }

  const serverUrl = (options.serverUrl || SERVER_URL || '').replace(/\/+$/, '');
  const apiIndex = trimmed.indexOf('/api/artists/');
  let targetUri = trimmed;
  if (apiIndex !== -1) {
    const path = trimmed.slice(apiIndex);
    targetUri = `${serverUrl}${path}`;
  } else if (trimmed.startsWith('/')) {
    targetUri = `${serverUrl}${trimmed}`;
  }

  const cleaned = stripTokenFromUrl(targetUri);
  return cleaned || null;
}

/**
 * Returns an absolute artwork URL with cache-busting version in query.
 * Auth is handled via Authorization headers, NEVER in URL query params.
 *
 * @param {string|Artist} artistOrId
 * @param {number|string|Object} [versionOrOptions]
 * @param {Object} [maybeOptions]
 * @returns {string}
 */
export function getArtistArtworkUrl(artistOrId, versionOrOptions = {}, maybeOptions = {}) {
  let artistId;
  let version = null;
  let options = {};

  if (typeof artistOrId === 'object' && artistOrId !== null) {
    artistId = artistOrId.id;
    version = artistOrId.artwork_version ?? null;
    options = typeof versionOrOptions === 'object' && versionOrOptions !== null ? versionOrOptions : maybeOptions;
  } else {
    artistId = artistOrId;
    if (typeof versionOrOptions === 'object' && versionOrOptions !== null) {
      options = versionOrOptions;
    } else {
      version = versionOrOptions;
      options = maybeOptions || {};
    }
  }

  if (!artistId || (typeof artistId !== 'string' && typeof artistId !== 'number')) {
    return '';
  }

  const cleanId = String(artistId).trim();
  if (!cleanId) return '';

  const serverUrl = (options.serverUrl || SERVER_URL || '').replace(/\/+$/, '');
  const url = `${serverUrl}/api/artists/${encodeURIComponent(cleanId)}/artwork`;

  const params = [];
  if (version !== undefined && version !== null && version !== '') {
    params.push(`v=${encodeURIComponent(String(version))}`);
  }

  // Auth is NEVER in the URL (no ?token=)
  return params.length > 0 ? `${url}?${params.join('&')}` : url;
}

/**
 * Resolves artwork URL for an artist summary or detail object.
 * Adheres strictly to Section 4.5: only manual artwork, never falls back to track covers.
 *
 * @param {Artist|string} artistOrId
 * @param {Object} [options]
 * @returns {string}
 */
export function resolveArtistArtworkUrl(artistOrId, options = {}) {
  if (!artistOrId) return '';
  if (typeof artistOrId === 'string' || typeof artistOrId === 'number') {
    return getArtistArtworkUrl(artistOrId, options?.version, options);
  }

  if (typeof artistOrId === 'object') {
    if (artistOrId.artwork_version > 0) {
      return getArtistArtworkUrl(artistOrId.id, artistOrId.artwork_version, options);
    }
    if (artistOrId.artwork_url) {
      const normalized = normalizeArtworkUrl(artistOrId.artwork_url, options);
      return normalized || '';
    }
  }

  return '';
}

/**
 * Normalizes an artist object to guarantee predictable contract DTO structure.
 *
 * @param {Object} artist
 * @param {Object} [options]
 * @returns {Artist|null}
 */
export function normalizeArtistDTO(artist, options = {}) {
  if (!artist || typeof artist !== 'object') return null;

  const id = artist.id != null ? String(artist.id).trim() : '';
  const name = artist.name != null ? String(artist.name) : '';
  const trackCount = typeof artist.track_count === 'number' ? artist.track_count : 0;
  const albumCount = typeof artist.album_count === 'number' ? artist.album_count : 0;
  const artworkVersion = typeof artist.artwork_version === 'number' ? artist.artwork_version : 0;

  let artworkUrl = null;
  if (artworkVersion > 0) {
    artworkUrl = getArtistArtworkUrl(id, artworkVersion, options);
  } else if (artist.artwork_url) {
    artworkUrl = normalizeArtworkUrl(artist.artwork_url, options);
  }

  return {
    ...artist,
    id,
    name,
    track_count: trackCount,
    album_count: albumCount,
    artwork_version: artworkVersion,
    artwork_url: artworkUrl,
  };
}

/**
 * Helper to parse JSON responses from authFetch and map non-2xx status to ApiError.
 *
 * @param {Response} response
 * @param {string} endpoint
 * @param {string} fallbackMsg
 * @returns {Promise<any>}
 */
async function parseJsonResponse(response, endpoint, fallbackMsg) {
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const message = parseApiErrorMessage(errData, fallbackMsg);
    throw new ApiError(message, {
      status: response.status,
      endpoint,
      type: classifyError(null, response.status),
      code: errData?.code,
    });
  }
  return await response.json().catch(() => null);
}

/**
 * Fetches the list of artists, optionally filtered by search query (GET /api/artists?q=).
 *
 * @param {string|Object} [queryOrOptions]
 * @param {Object} [maybeOptions]
 * @returns {Promise<Array<Artist>>}
 */
export async function getArtists(queryOrOptions = {}, maybeOptions = {}) {
  let query = '';
  let options = {};

  if (typeof queryOrOptions === 'string') {
    query = queryOrOptions.trim();
    options = maybeOptions || {};
  } else if (queryOrOptions && typeof queryOrOptions === 'object') {
    query = (queryOrOptions.q || queryOrOptions.query || '').trim();
    const { q: _q, query: _query, ...rest } = queryOrOptions;
    options = { ...rest, ...maybeOptions };
  }

  const endpoint = query ? `/api/artists?q=${encodeURIComponent(query)}` : '/api/artists';
  const res = await authFetch(endpoint, {
    method: 'GET',
    ...options,
  });

  const rawData = await parseJsonResponse(res, endpoint, 'Failed to fetch artists');
  if (!Array.isArray(rawData)) {
    return [];
  }
  return rawData.map((item) => normalizeArtistDTO(item, options));
}

/**
 * Fetches detail for a single artist: profile, popular tracks, and albums (GET /api/artists/{artistId}).
 *
 * @param {string} artistId
 * @param {Object} [options]
 * @returns {Promise<ArtistDetail>}
 */
export async function getArtist(artistId, options = {}) {
  if (!artistId || (typeof artistId !== 'string' && typeof artistId !== 'number')) {
    throw new ApiError('Artist ID is required', { type: 'client', status: 400 });
  }

  const cleanArtistId = String(artistId).trim();
  if (!cleanArtistId) {
    throw new ApiError('Artist ID is required', { type: 'client', status: 400 });
  }

  const endpoint = `/api/artists/${encodeURIComponent(cleanArtistId)}`;
  const res = await authFetch(endpoint, {
    method: 'GET',
    ...options,
  });

  const rawData = await parseJsonResponse(res, endpoint, 'Failed to fetch artist details');
  if (!rawData || typeof rawData !== 'object') {
    return rawData;
  }

  return {
    ...rawData,
    artist: normalizeArtistDTO(rawData.artist, options),
    popular_tracks: Array.isArray(rawData.popular_tracks) ? rawData.popular_tracks.map((track) => normalizeTrack(track, options)).filter(Boolean) : [],
    albums: Array.isArray(rawData.albums) ? rawData.albums.map(normalizeAlbum).filter(Boolean) : [],
  };
}

/**
 * Uploads/updates artist artwork (admin only, PUT /api/artists/{artistId}/artwork).
 * Multipart request using field 'file'. Does NOT set JSON Content-Type.
 *
 * @param {string} artistId
 * @param {FormData|Object|Blob} file
 * @param {Object} [options]
 * @returns {Promise<ArtworkUpdateResult>}
 */
export async function updateArtistArtwork(artistId, file, options = {}) {
  if (!artistId || (typeof artistId !== 'string' && typeof artistId !== 'number')) {
    throw new ApiError('Artist ID is required', { type: 'client', status: 400 });
  }

  const cleanArtistId = String(artistId).trim();
  if (!cleanArtistId) {
    throw new ApiError('Artist ID is required', { type: 'client', status: 400 });
  }

  if (!file) {
    throw new ApiError('File is required to update artwork', { type: 'client', status: 400 });
  }

  const endpoint = `/api/artists/${encodeURIComponent(cleanArtistId)}/artwork`;

  let formData;
  if (typeof FormData !== 'undefined' && file instanceof FormData) {
    formData = file;
  } else {
    formData = new FormData();
    if (typeof file === 'object' && file.uri) {
      formData.append('file', {
        uri: file.uri,
        name: file.name || 'artwork.jpg',
        type: file.type || 'image/jpeg',
      });
    } else {
      formData.append('file', file);
    }
  }

  const { headers = {}, ...fetchOptions } = options;
  const filteredHeaders = { ...headers };
  delete filteredHeaders['Content-Type'];
  delete filteredHeaders['content-type'];

  const res = await authFetch(endpoint, {
    method: 'PUT',
    body: formData,
    headers: filteredHeaders,
    ...fetchOptions,
  });

  return parseJsonResponse(res, endpoint, 'Failed to update artist artwork');
}

/**
 * Deletes artist artwork (admin only, DELETE /api/artists/{artistId}/artwork).
 *
 * @param {string} artistId
 * @param {Object} [options]
 * @returns {Promise<ArtworkDeleteResult>}
 */
export async function deleteArtistArtwork(artistId, options = {}) {
  if (!artistId || (typeof artistId !== 'string' && typeof artistId !== 'number')) {
    throw new ApiError('Artist ID is required', { type: 'client', status: 400 });
  }

  const cleanArtistId = String(artistId).trim();
  if (!cleanArtistId) {
    throw new ApiError('Artist ID is required', { type: 'client', status: 400 });
  }

  const endpoint = `/api/artists/${encodeURIComponent(cleanArtistId)}/artwork`;
  const res = await authFetch(endpoint, {
    method: 'DELETE',
    ...options,
  });

  return parseJsonResponse(res, endpoint, 'Failed to delete artist artwork');
}

/**
 * Records confirmed playback start idempotently for a track (POST /api/tracks/{trackId}/play-start).
 * Contract:
 * - Exactly one bounded retry (defaults to retry: 1 on transient errors, clamped to at most 1).
 * - Errors are thrown to caller so they can be handled/hidden (no user-visible error).
 *
 * @param {string|number} trackId
 * @param {Object} [options]
 * @returns {Promise<PlayStartResult>}
 */
export async function recordPlayStart(trackId, options = {}) {
  if (!trackId || (typeof trackId !== 'string' && typeof trackId !== 'number')) {
    throw new ApiError('Track ID is required', { type: 'client', status: 400 });
  }

  const cleanTrackId = String(trackId).trim();
  if (!cleanTrackId) {
    throw new ApiError('Track ID is required', { type: 'client', status: 400 });
  }

  const { retry: userRetry, retries: userRetries, ...restOptions } = options;
  const requestedRetry = userRetry ?? userRetries;
  // Bounded retry per Contract EV-17 & Section 3.4: exactly one retry on transient failure
  const retry = typeof requestedRetry === 'number' ? Math.min(Math.max(0, requestedRetry), 1) : 1;

  const endpoint = `/api/tracks/${encodeURIComponent(cleanTrackId)}/play-start`;
  const res = await authFetch(endpoint, {
    method: 'POST',
    retry,
    ...restOptions,
  });

  return parseJsonResponse(res, endpoint, 'Failed to record play start');
}

// Aliases for convenience and consistency with existing codebase
export const fetchArtists = getArtists;
export const fetchArtist = getArtist;
export const getArtistDetail = getArtist;
export const putArtistArtwork = updateArtistArtwork;
export const uploadArtistArtwork = updateArtistArtwork;
export const removeArtistArtwork = deleteArtistArtwork;
export const logPlayStart = recordPlayStart;
