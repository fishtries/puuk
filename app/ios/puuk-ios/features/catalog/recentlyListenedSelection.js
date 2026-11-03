import { getTrackId } from '../../shared/domain/trackAdapter';

export const DEFAULT_RECENTLY_LISTENED_LIMIT = 20;
export const ARTIST_SCORE_WEIGHT = 12;
export const ALBUM_SCORE_WEIGHT = 6;
export const GENRE_SCORE_WEIGHT = 3;
export const MAX_TRACKS_PER_ARTIST = 2;

/**
 * Checks if a string represents an unknown placeholder, empty string, or absent value.
 *
 * @param {any} val
 * @returns {boolean}
 */
function isUnknownOrBlank(val) {
  if (val === undefined || val === null) return true;
  if (typeof val !== 'string') return false;
  const trimmed = val.trim().toLowerCase();
  return (
    trimmed === '' ||
    trimmed === 'unknown' ||
    trimmed === 'unknown artist' ||
    trimmed === 'unknown album' ||
    trimmed === 'unknown genre' ||
    trimmed === 'none'
  );
}

/**
 * Extracts a normalized primary artist key for diversity scoring.
 * Uses the first valid credit ID from `artists`.
 * Fallback: normalized `artist` string (if not placeholder/blank).
 * Rejects unknown placeholders.
 *
 * @param {Object} track
 * @returns {string|null}
 */
export function getPrimaryArtistKey(track) {
  if (!track || typeof track !== 'object') return null;

  // 1. First valid credit in `artists` array
  if (Array.isArray(track.artists)) {
    for (const credit of track.artists) {
      if (credit && typeof credit === 'object') {
        const creditId = credit.id;
        if (
          creditId !== undefined &&
          creditId !== null &&
          String(creditId).trim().length > 0 &&
          !isUnknownOrBlank(String(creditId))
        ) {
          return `artist_id_${String(creditId).trim()}`;
        }
        if (
          typeof credit.name === 'string' &&
          !isUnknownOrBlank(credit.name)
        ) {
          return `artist_name_${credit.name.trim().toLowerCase()}`;
        }
      }
    }
  }

  // 2. Fallback to track.artist string
  if (typeof track.artist === 'string' && !isUnknownOrBlank(track.artist)) {
    return `artist_name_${track.artist.trim().toLowerCase()}`;
  }

  return null;
}

/**
 * Extracts a normalized album key for diversity scoring.
 * Uses `album_id`. Fallback: normalized album name qualified by primary artist key.
 *
 * @param {Object} track
 * @param {string|null} artistKey
 * @returns {string|null}
 */
export function getAlbumKey(track, artistKey) {
  if (!track || typeof track !== 'object') return null;

  if (
    track.album_id !== undefined &&
    track.album_id !== null &&
    String(track.album_id).trim().length > 0 &&
    !isUnknownOrBlank(String(track.album_id))
  ) {
    return `album_id_${String(track.album_id).trim()}`;
  }

  if (
    typeof track.album === 'string' &&
    !isUnknownOrBlank(track.album) &&
    artistKey !== null
  ) {
    return `album_name_${artistKey}__${track.album.trim().toLowerCase()}`;
  }

  return null;
}

/**
 * Extracts a normalized genre key for diversity scoring.
 * Rejects unknown placeholders.
 *
 * @param {Object} track
 * @returns {string|null}
 */
export function getGenreKey(track) {
  if (!track || typeof track !== 'object') return null;
  if (typeof track.genre === 'string' && !isUnknownOrBlank(track.genre)) {
    return `genre_${track.genre.trim().toLowerCase()}`;
  }
  return null;
}

/**
 * Deterministically selects up to `limit` recently listened tracks with diversity prioritisation.
 * Pure function: does not mutate inputs, does not use Math.random() or Date.now().
 *
 * @param {Array<Object>} tracks
 * @param {number} [limit=20]
 * @returns {Array<Object>}
 */
export function selectRecentlyListened(
  tracks,
  limit = DEFAULT_RECENTLY_LISTENED_LIMIT,
) {
  if (!Array.isArray(tracks) || tracks.length === 0) return [];
  const maxItems = typeof limit === 'number' && limit >= 0 ? limit : DEFAULT_RECENTLY_LISTENED_LIMIT;
  if (maxItems === 0) return [];

  // Step 1: Filter invalid IDs and deduplicate by canonical track ID (preserving first occurrence)
  const seenIds = new Set();
  const uniqueCandidates = [];

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const id = getTrackId(track);
    if (id === null) continue;

    const key = String(id);
    if (seenIds.has(key)) continue;
    seenIds.add(key);

    const artistKey = getPrimaryArtistKey(track);
    const albumKey = getAlbumKey(track, artistKey);
    const genreKey = getGenreKey(track);

    uniqueCandidates.push({
      track,
      originalRank: uniqueCandidates.length,
      artistKey,
      albumKey,
      genreKey,
    });
  }

  if (uniqueCandidates.length === 0) return [];

  const targetCount = Math.min(maxItems, uniqueCandidates.length);
  const result = [];
  const artistCounts = {};
  const albumCounts = {};
  const genreCounts = {};

  const remaining = [...uniqueCandidates];

  const pickCandidate = (candidate) => {
    result.push(candidate.track);

    if (candidate.artistKey) {
      artistCounts[candidate.artistKey] =
        (artistCounts[candidate.artistKey] || 0) + 1;
    }
    if (candidate.albumKey) {
      albumCounts[candidate.albumKey] =
        (albumCounts[candidate.albumKey] || 0) + 1;
    }
    if (candidate.genreKey) {
      genreCounts[candidate.genreKey] =
        (genreCounts[candidate.genreKey] || 0) + 1;
    }

    const idx = remaining.findIndex(
      (c) => c.originalRank === candidate.originalRank,
    );
    if (idx !== -1) {
      remaining.splice(idx, 1);
    }
  };

  // Step 2: The first valid track is ALWAYS first in the result
  pickCandidate(remaining[0]);

  // Steps 3-6: Pick remaining slots iteratively
  while (result.length < targetCount && remaining.length > 0) {
    const prevCandidate = uniqueCandidates.find((c) =>
      c.track === result[result.length - 1],
    );
    const prevArtistKey = prevCandidate?.artistKey || null;
    const prevAlbumKey = prevCandidate?.albumKey || null;

    // 3. Candidates with fewer than 2 already picked tracks from the same artist
    const underArtistCap = remaining.filter((c) => {
      if (!c.artistKey) return true;
      return (artistCounts[c.artistKey] || 0) < MAX_TRACKS_PER_ARTIST;
    });

    // If no candidate satisfies the cap, relax it to fill remaining spots
    let pool = underArtistCap.length > 0 ? underArtistCap : remaining;

    // 4. Prefer different primary artist from previous card if available
    if (prevArtistKey) {
      const diffArtistPool = pool.filter(
        (c) => !c.artistKey || c.artistKey !== prevArtistKey,
      );
      if (diffArtistPool.length > 0) {
        pool = diffArtistPool;
      }
    }

    // Prefer different album from previous card if available
    if (prevAlbumKey) {
      const diffAlbumPool = pool.filter(
        (c) => !c.albumKey || c.albumKey !== prevAlbumKey,
      );
      if (diffAlbumPool.length > 0) {
        pool = diffAlbumPool;
      }
    }

    // 5. Pick candidate with minimum score:
    // originalRank + 12 * artistCount + 6 * albumCount + 3 * genreCount
    let bestCandidate = null;
    let bestScore = Infinity;

    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      const aCount = candidate.artistKey
        ? artistCounts[candidate.artistKey] || 0
        : 0;
      const alCount = candidate.albumKey
        ? albumCounts[candidate.albumKey] || 0
        : 0;
      const gCount = candidate.genreKey
        ? genreCounts[candidate.genreKey] || 0
        : 0;

      const score =
        candidate.originalRank +
        ARTIST_SCORE_WEIGHT * aCount +
        ALBUM_SCORE_WEIGHT * alCount +
        GENRE_SCORE_WEIGHT * gCount;

      if (
        score < bestScore ||
        (score === bestScore && candidate.originalRank < bestCandidate.originalRank)
      ) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (bestCandidate) {
      pickCandidate(bestCandidate);
    } else {
      // Fallback safeguard (should not be reached)
      pickCandidate(remaining[0]);
    }
  }

  return result;
}
