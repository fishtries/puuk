/**
 * shareLinks.js — Canonical permanent HTTPS share links & native Share helper for Puuk iOS.
 * Contract v1 (§7.1, §8) / J5 isolated module.
 *
 * Output format:
 *   https://web.puuk.fun/track/<canonical lowercase UUID>
 *   https://web.puuk.fun/album/<positive signed 64-bit integer canonical text>
 *   https://web.puuk.fun/artist/<art_32lowerhex>
 *
 * Rules:
 * - Always canonical HTTPS origin (https://web.puuk.fun).
 * - Album IDs: positive signed 64-bit integers (1 to 9223372036854775807). Unsafe rounded JS Numbers are rejected.
 * - Raw path validation rejects hostile inputs (ports, userinfo, custom schemes, backslashes, dot segments, encoded separators, query, fragment).
 * - Trailing slash normalized ONLY after successful ID validation.
 * - Native React Native Share helper is cancellation neutral and emits only canonical HTTPS URLs.
 * - Business entities lacking IDs throw meaningful errors; guessing first entity is prohibited.
 */

import { Share, Alert, AccessibilityInfo } from 'react-native';

export const CANONICAL_ORIGIN = 'https://web.puuk.fun';
export const ALLOWED_ENTITY_TYPES = Object.freeze(['track', 'album', 'artist']);

export const MAX_SIGNED_64_INT = 9223372036854775807n;
export const MIN_SIGNED_64_INT = 1n;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALBUM_DECIMAL_REGEX = /^[1-9][0-9]*$/;
const ARTIST_ID_REGEX = /^art_[0-9a-f]{32}$/;

/**
 * Validates canonical lowercase UUID string for tracks.
 * Returns canonical string or throws if invalid.
 */
export function validateTrackId(id) {
  if (typeof id !== 'string') {
    throw new Error('Track ID must be a string.');
  }
  const normalized = id;
  if (!UUID_REGEX.test(normalized)) {
    throw new Error('Ссылка недоступна');
  }
  return normalized;
}

/**
 * Validates positive signed 64-bit integer for albums.
 * Rejects unsafe rounded numbers, zeros, signs, exponents, fractions, and overflow.
 * Returns canonical string representation.
 */
export function validateAlbumId(id) {
  if (id === null || id === undefined) {
    throw new Error('Album ID is required.');
  }

  // If number, must be safe integer and strictly positive (> 0)
  if (typeof id === 'number') {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('Ссылка недоступна');
    }
    if (!Number.isSafeInteger(id)) {
      throw new Error(
        `Unsafe numeric album ID: ${id} exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}). ` +
          'Must be provided as string share_id to preserve 64-bit precision without rounding.',
      );
    }
    return String(id);
  }

  // If BigInt
  if (typeof id === 'bigint') {
    if (id < MIN_SIGNED_64_INT || id > MAX_SIGNED_64_INT) {
      throw new Error('Ссылка недоступна');
    }
    return id.toString();
  }

  // If string
  if (typeof id === 'string') {
    const trimmed = id;
    if (!ALBUM_DECIMAL_REGEX.test(trimmed)) {
      throw new Error(
        'Ссылка недоступна',
      );
    }
    try {
      const b = BigInt(trimmed);
      if (b < MIN_SIGNED_64_INT || b > MAX_SIGNED_64_INT) {
        throw new Error('Ссылка недоступна');
      }
      return trimmed;
    } catch (e) {
      throw new Error('Ссылка недоступна');
    }
  }

  throw new Error('Ссылка недоступна');
}

/**
 * Validates artist ID: art_ + 32 lowercase hex characters.
 * Rejects name hashes, various artists, and malformed strings.
 */
export function validateArtistId(id) {
  if (typeof id !== 'string') {
    throw new Error('Artist ID must be a string.');
  }
  const trimmed = id;
  if (trimmed === 'art_various' || trimmed === 'various' || trimmed === 'various artists') {
    throw new Error('Reserved "various artists" has no shareable artist ID per Contract v1 §7.1.');
  }
  if (!ARTIST_ID_REGEX.test(trimmed)) {
    throw new Error(
      'Ссылка недоступна',
    );
  }
  return trimmed;
}

/**
 * Extracts and validates the canonical share ID from a business entity.
 * Uses lossless share_id / server ID, never name hashes or unsafe rounded numbers.
 * If entity lacks ID, throws meaningful error without guessing sub-entities.
 */
export function extractEntityShareId(entity, type) {
  if (!entity || typeof entity !== 'object') {
    throw new Error('Cannot extract share ID: entity must be a valid object.');
  }

  const effectiveType = type || entity.type;
  if (!effectiveType || !ALLOWED_ENTITY_TYPES.includes(effectiveType)) {
    throw new Error('Ссылка недоступна');
  }

  // Prefer lossless share_id if present
  const candidateId =
    entity.share_id ??
    (effectiveType === 'album'
      ? entity.album_id ?? entity.id
      : effectiveType === 'track'
        ? entity.id ?? entity.track_id
        : entity.id);

  if (candidateId === null || candidateId === undefined || candidateId === '') {
    throw new Error(
      `Entity of type "${effectiveType}" lacks a valid ID or share_id. Guessing entity identity is prohibited.`,
    );
  }

  switch (effectiveType) {
    case 'track':
      return validateTrackId(candidateId);
    case 'album':
      return validateAlbumId(candidateId);
    case 'artist':
      return validateArtistId(candidateId);
    default:
      throw new Error('Ссылка недоступна');
  }
}

/**
 * Formats a canonical permanent HTTPS URL for track, album, or artist.
 *
 * Usage:
 *   formatShareUrl('track', trackId)
 *   formatShareUrl('album', albumId)
 *   formatShareUrl('artist', artistId)
 *   formatShareUrl(entityObject, 'track')
 */
export function formatShareUrl(typeOrEntity, optionalIdOrType) {
  let type;
  let id;

  if (typeof typeOrEntity === 'object' && typeOrEntity !== null) {
    const explicitType = typeof optionalIdOrType === 'string' ? optionalIdOrType : typeOrEntity.type;
    type = explicitType;
    id = extractEntityShareId(typeOrEntity, explicitType);
  } else {
    type = String(typeOrEntity).toLowerCase();
    id = optionalIdOrType;
  }

  if (!ALLOWED_ENTITY_TYPES.includes(type)) {
    throw new Error('Ссылка недоступна');
  }

  let canonicalId;
  switch (type) {
    case 'track':
      canonicalId = validateTrackId(id);
      break;
    case 'album':
      canonicalId = validateAlbumId(id);
      break;
    case 'artist':
      canonicalId = validateArtistId(id);
      break;
    default:
      throw new Error('Ссылка недоступна');
  }

  // Canonical format: https://web.puuk.fun/<type>/<id> (no trailing slash emitted by formatter)
  return `${CANONICAL_ORIGIN}/${type}/${encodeURIComponent(canonicalId)}`;
}

export function formatTrackShareUrl(idOrEntity) {
  return typeof idOrEntity === 'object' && idOrEntity !== null
    ? formatShareUrl(idOrEntity, 'track')
    : formatShareUrl('track', idOrEntity);
}

export function formatAlbumShareUrl(idOrEntity) {
  return typeof idOrEntity === 'object' && idOrEntity !== null
    ? formatShareUrl(idOrEntity, 'album')
    : formatShareUrl('album', idOrEntity);
}

export function formatArtistShareUrl(idOrEntity) {
  return typeof idOrEntity === 'object' && idOrEntity !== null
    ? formatShareUrl(idOrEntity, 'artist')
    : formatShareUrl('artist', idOrEntity);
}

/**
 * Parses and validates raw share URL or path.
 *
 * Validates raw path before URL normalization:
 * - Rejects non-canonical origins, ports, userinfo, custom schemes, backslashes.
 * - Rejects percent-encoded separators (%2f, %5c, %2e), dot segments (., ..), duplicate slashes.
 * - Rejects queries (?) and fragments (#).
 * - Rejects extra segments.
 * - Allows exactly one trailing slash, normalized ONLY after successful ID validation.
 *
 * Returns: { type: 'track'|'album'|'artist', id: string, normalizedPath: string, canonicalUrl: string }
 * or null if invalid.
 */
export function parseShareUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return null;
  }

  // Reject leading/trailing whitespace
  if (rawUrl.trim() !== rawUrl || /[\x00-\x20%]/.test(rawUrl)) {
    return null;
  }

  // Reject backslashes anywhere in raw input
  if (rawUrl.includes('\\')) {
    return null;
  }

  // Reject userinfo (@)
  if (rawUrl.includes('@')) {
    return null;
  }

  // Reject query (?) and fragment (#)
  if (rawUrl.includes('?') || rawUrl.includes('#')) {
    return null;
  }

  // Reject percent-encoded separators and dot segments (%2f, %5c, %2e)
  if (/%(?:2f|5c|2e)/i.test(rawUrl)) {
    return null;
  }

  // Reject protocol-relative URLs
  if (rawUrl.startsWith('//')) {
    return null;
  }

  let path;
  if (rawUrl.startsWith('https://')) {
    // Origin must be strictly https://web.puuk.fun (no ports, no userinfo, no other domain)
    if (!rawUrl.startsWith(`${CANONICAL_ORIGIN}/`)) {
      return null;
    }
    path = rawUrl.slice(CANONICAL_ORIGIN.length);
  } else if (rawUrl.startsWith('/')) {
    path = rawUrl;
  } else {
    // Non-https scheme (http://, puuk://, custom schemes) or malformed relative URL
    return null;
  }

  // Path must start with single '/' and not '//'
  if (!path.startsWith('/') || path.startsWith('//')) {
    return null;
  }

  // Reject duplicate slashes anywhere in path
  if (path.includes('//')) {
    return null;
  }

  // Reject dot segments: /./, /../, /. or /..
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(path)) {
    return null;
  }

  // Inspect segments
  const segments = path.split('/');
  // segments[0] is "" because path starts with '/'
  // Valid options:
  // 1. Without trailing slash: ["", type, id] -> length 3
  // 2. With trailing slash: ["", type, id, ""] -> length 4
  if (segments.length !== 3 && segments.length !== 4) {
    return null;
  }
  if (segments.length === 4 && segments[3] !== '') {
    return null;
  }

  const type = segments[1];
  const id = segments[2];

  if (!ALLOWED_ENTITY_TYPES.includes(type)) {
    return null;
  }

  // Validate ID strictly against entity type rules
  let validatedId;
  try {
    switch (type) {
      case 'track':
        validatedId = validateTrackId(id);
        break;
      case 'album':
        validatedId = validateAlbumId(id);
        break;
      case 'artist':
        validatedId = validateArtistId(id);
        break;
      default:
        return null;
    }
  } catch {
    // Invalid ID fails validation; trailing slash is NOT normalized
    return null;
  }

  // One trailing slash normalized after successful ID validation
  const normalizedPath = `/${type}/${validatedId}`;
  const canonicalUrl = `${CANONICAL_ORIGIN}${normalizedPath}`;

  return {
    type,
    id: validatedId,
    normalizedPath,
    canonicalUrl,
  };
}

/**
 * Returns true if rawUrl is a valid canonical Puuk share URL or path.
 */
export function isValidShareUrl(rawUrl) {
  return parseShareUrl(rawUrl) !== null;
}

/**
 * Native React Native Share helper.
 * Generates only canonical HTTPS URLs, cancellation neutral, no misleading success.
 *
 * If business entities lack ID, returns/throws meaningful error; no guessed first entity.
 *
 * @param {object|string} entityOrUrl - Entity object, { type, id }, or validated URL string.
 * @param {object} [options] - Additional share options (subject, dialogTitle, etc.).
 * @returns {Promise<{ status: 'shared'|'dismissed'|'error', completed: boolean, action?: string, activityType?: string|null, url: string, error?: Error }>}
 */
export async function shareEntity(entityOrUrl, options = {}) {
  let canonicalUrl;

  try {
    if (typeof entityOrUrl === 'string') {
      const parsed = parseShareUrl(entityOrUrl);
      if (!parsed) {
        throw new Error('Ссылка недоступна');
      }
      canonicalUrl = parsed.canonicalUrl;
    } else if (typeof entityOrUrl === 'object' && entityOrUrl !== null) {
      canonicalUrl = formatShareUrl(entityOrUrl, options.type);
    } else {
      throw new Error('Invalid input to shareEntity: expected entity object or valid share URL string.');
    }
  } catch (err) {
    if (options.throwOnError) throw new Error('Не удалось поделиться ссылкой');
    return {
      status: 'error',
      completed: false,
      error: new Error('Не удалось поделиться ссылкой'),
      url: null,
    };
  }

  try {
    const shareContent = {
      url: canonicalUrl,
    };
    const shareOptions = {};

    const result = await Share.share(shareContent, shareOptions);

    if (result.action === Share.sharedAction) {
      return {
        status: 'shared',
        completed: true,
        action: Share.sharedAction,
        activityType: result.activityType ?? null,
        url: canonicalUrl,
      };
    }

    // Cancellation neutral: user dismissed share dialog without completing
    return {
      status: 'dismissed',
      completed: false,
      action: Share.dismissedAction,
      activityType: null,
      url: canonicalUrl,
    };
  } catch (err) {
    if (options.throwOnError) throw new Error('Не удалось поделиться ссылкой');
    return {
      status: 'error',
      completed: false,
      error: new Error('Не удалось поделиться ссылкой'),
      url: canonicalUrl,
    };
  }
}

export const SHARE_LINKS_ENABLED = process.env.EXPO_PUBLIC_SHARE_LINKS_ENABLED === 'true';
let sharePending = false;
export async function presentShareEntity(entity, type) {
  if (!SHARE_LINKS_ENABLED || sharePending) return;
  sharePending = true;
  try {
    const result = await shareEntity(entity, { type });
    if (result.status === 'shared') AccessibilityInfo.announceForAccessibility('Ссылка отправлена');
    if (result.status === 'error') Alert.alert('Не удалось поделиться', 'Попробуйте ещё раз.');
    return result;
  } finally { sharePending = false; }
}
