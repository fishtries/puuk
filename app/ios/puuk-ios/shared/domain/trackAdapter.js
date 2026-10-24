/**
 * Core Track Data Contract adapter (Stage 8).
 * Provides pure functions for track identifier extraction, equality comparison,
 * and canonical track normalization.
 */

function isValidIdValue(val) {
  if (val === undefined || val === null) return false;
  if (typeof val === 'number') return !Number.isNaN(val);
  if (typeof val === 'string') return val.trim().length > 0;
  return false;
}

/**
 * Extracts the canonical identifier from a track object or raw identifier.
 * Accepts valid strings and numbers (including numeric 0).
 * Rejects null, undefined, empty/whitespace strings, and NaN.
 * Prefers canonical `id` over legacy `track_id`; treats blank/whitespace `id`
 * as absent so fallback to `track_id` can occur.
 *
 * @param {Object|string|number|null|undefined} track
 * @returns {string|number|null}
 */
export function getTrackId(track) {
  if (track === null || track === undefined) return null;
  let rawId;
  if (typeof track === 'object') {
    rawId = isValidIdValue(track.id) ? track.id : track.track_id;
  } else if (typeof track === 'string' || typeof track === 'number') {
    rawId = track;
  } else {
    return null;
  }

  if (rawId === undefined || rawId === null) return null;
  if (typeof rawId === 'number') {
    return Number.isNaN(rawId) ? null : rawId;
  }
  if (typeof rawId === 'string') {
    const trimmed = rawId.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/**
 * Determines whether two tracks (or track identifiers) refer to the same track.
 * Requires both tracks to have a valid identifier; if either is invalid/null, returns false.
 *
 * @param {Object|string|number|null|undefined} a
 * @param {Object|string|number|null|undefined} b
 * @returns {boolean}
 */
export function areTrackIdsEqual(a, b) {
  const idA = getTrackId(a);
  const idB = getTrackId(b);
  if (idA === null || idB === null) return false;
  return String(idA).trim() === String(idB).trim();
}

/**
 * Normalizes an incoming or persisted track record into the canonical track contract:
 * - Guarantees canonical `id` field.
 * - Retains `track_id` alias for backwards compatibility during migration.
 * - Preserves all unknown and additional fields (album, bpm, lyrics, duration, etc.).
 * - Preserves valid ID values including numeric 0.
 * - Ensures fallback coverArt when serverUrl is provided and coverArt is missing.
 * - Returns null if the track or its identifier is missing/invalid.
 *
 * @param {Object|null|undefined} rawTrack
 * @param {Object} [options]
 * @param {string} [options.serverUrl]
 * @returns {Object|null}
 */
export function normalizeTrack(rawTrack, options = {}) {
  if (!rawTrack || typeof rawTrack !== 'object') return null;
  const id = getTrackId(rawTrack);
  if (id === null) return null;

  const serverUrl = options.serverUrl
    ? String(options.serverUrl).replace(/\/+$/, '')
    : '';
  const fallbackCover = serverUrl
    ? `${serverUrl}/api/cover/${encodeURIComponent(String(id))}`
    : null;

  const title =
    rawTrack.title !== undefined && rawTrack.title !== null
      ? rawTrack.title
      : 'Unknown Track';
  const artist =
    rawTrack.artist !== undefined && rawTrack.artist !== null
      ? rawTrack.artist
      : 'Unknown Artist';
  const coverArt =
    rawTrack.coverArt !== undefined && rawTrack.coverArt !== null
      ? rawTrack.coverArt
      : fallbackCover;

  return {
    ...rawTrack,
    id,
    track_id: id,
    title,
    artist,
    coverArt,
  };
}
