/**
 * Permanent web share link formatting, parsing, and sharing utilities.
 * Conforms strictly to CDN & Share Links Contract v1 (§7.1, §8).
 *
 * Frozen URLs:
 *   https://web.puuk.fun/track/<canonical lowercase UUID>
 *   https://web.puuk.fun/album/<canonical positive signed64 integer text>
 *   https://web.puuk.fun/artist/<art_32hex>
 */

export const SHARE_LINKS_ENABLED = (import.meta as any).env?.VITE_SHARE_LINKS_ENABLED === 'true';

export const CANONICAL_ORIGIN = 'https://web.puuk.fun';
export const INT64_MAX = 9223372036854775807n;

export type ShareEntityType = 'track' | 'album' | 'artist';

export interface ParsedShareTarget {
  type: ShareEntityType;
  id: string;
  canonicalPath: string; // own-origin formatter-compatible path: e.g. /track/<id>
  canonicalUrl: string;  // absolute canonical HTTPS URL: https://web.puuk.fun/track/<id>
  hasTrailingSlash: boolean;
}

export interface ShareEntityOptions {
  type: ShareEntityType;
  id: string | number | bigint;
  title?: string;
  text?: string;
}

export type ShareActionOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

const UUID_LOWERCASE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALBUM_CANONICAL_DECIMAL_REGEX = /^[1-9][0-9]*$/;
const ARTIST_CANONICAL_ID_REGEX = /^art_[0-9a-f]{32}$/;

/**
 * Validates canonical lowercase UUID string for track entities.
 */
export function isValidTrackId(id: unknown): id is string {
  return typeof id === 'string' && UUID_LOWERCASE_REGEX.test(id);
}

/**
 * Validates canonical positive signed 64-bit decimal string, safe integer, or bigint for albums.
 * Rejects zeros, negative values, signs (+/-), exponents (e), decimals, leading zeros, and overflow.
 */
export function isValidAlbumId(id: unknown): boolean {
  if (typeof id === 'number') {
    return Number.isSafeInteger(id) && id > 0 && BigInt(id) <= INT64_MAX;
  }
  if (typeof id === 'bigint') {
    return id > 0n && id <= INT64_MAX;
  }
  if (typeof id === 'string') {
    if (id.length > 19 || !ALBUM_CANONICAL_DECIMAL_REGEX.test(id)) return false;
    try {
      const val = BigInt(id);
      return val > 0n && val <= INT64_MAX;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Validates canonical artist ID: art_ prefix followed by 32 lowercase hex characters.
 * Reserved "various artists" has no shareable artist ID.
 * Client-side hashing of artist names is strictly prohibited.
 */
export function isValidArtistId(id: unknown): id is string {
  return typeof id === 'string' && ARTIST_CANONICAL_ID_REGEX.test(id);
}

/**
 * Formats a canonical own-origin relative path for an entity (/track/<id>, /album/<id>, /artist/<id>).
 * Never emits a trailing slash.
 */
export function formatSharePath(type: ShareEntityType, id: string | number | bigint): string {
  if (type === 'track') {
    if (!isValidTrackId(id)) {
      throw new Error('Invalid share identifier');
    }
    return `/track/${encodeURIComponent(id)}`;
  }

  if (type === 'album') {
    if (typeof id === 'number') {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error('Invalid share identifier');
      }
      return `/album/${encodeURIComponent(String(id))}`;
    }
    if (typeof id === 'bigint') {
      if (!isValidAlbumId(id)) {
        throw new Error('Invalid share identifier');
      }
      return `/album/${encodeURIComponent(id.toString())}`;
    }
    if (typeof id === 'string') {
      if (!isValidAlbumId(id)) {
        throw new Error('Invalid share identifier');
      }
      return `/album/${encodeURIComponent(id)}`;
    }
    throw new Error('Invalid album ID type: expected string, number, or bigint.');
  }

  if (type === 'artist') {
    if (!isValidArtistId(id)) {
      throw new Error('Invalid share identifier');
    }
    return `/artist/${encodeURIComponent(id)}`;
  }

  throw new Error('Invalid share identifier');
}

/**
 * Formats a canonical HTTPS share URL for an entity.
 * Uses encodeURIComponent once. Never emits a trailing slash.
 */
export function formatShareUrl(type: ShareEntityType, id: string | number | bigint): string {
  return `${CANONICAL_ORIGIN}${formatSharePath(type, id)}`;
}

/**
 * Strict parser for incoming raw share URLs or canonical root-relative paths.
 * Validates the raw string BEFORE any URL constructor normalizes the path.
 *
 * Strict rejection rules:
 * - Rejects non-string, empty, or whitespace-padded inputs.
 * - Rejects custom schemes, http://, and protocol-relative URLs (//).
 * - Rejects credentials / userinfo (@).
 * - Rejects non-canonical origins and alternate ports (:443, :80, etc.).
 * - Rejects backslashes (\).
 * - Rejects percent-encoded separators (%2f, %5c, %2e, double decode, etc.).
 * - Rejects dot-segments (/../, /./).
 * - Rejects duplicate slashes (//).
 * - Rejects query strings (?) and fragments (#).
 * - Rejects trailing segments (/track/<id>/foo).
 * - Rejects malformed / out-of-range IDs (album 0, signs, exponents, int64 overflow, uppercase UUIDs).
 *
 * Accepts optional single trailing slash, returning hasTrailingSlash: true and the canonical path without it.
 */
export function parseShareTarget(rawInput: unknown): ParsedShareTarget | null {
  if (typeof rawInput !== 'string' || rawInput.length === 0 || rawInput.length > 128) {
    return null;
  }

  // Reject any whitespace
  if (/\s/.test(rawInput)) {
    return null;
  }

  // Reject backslashes
  if (rawInput.includes('\\')) {
    return null;
  }

  // Reject percent-encoded separators or double decoding
  if (rawInput.includes('%')) {
    return null;
  }

  // Reject query strings and fragments
  if (rawInput.includes('?') || rawInput.includes('#')) {
    return null;
  }

  // Reject userinfo / credentials
  if (rawInput.includes('@')) {
    return null;
  }

  // Reject dot-segments (/../, /./, ..)
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(rawInput)) {
    return null;
  }

  let rawPath: string;

  if (rawInput.startsWith('https://')) {
    // Must start with exact canonical origin prefix
    if (!rawInput.startsWith(`${CANONICAL_ORIGIN}/`)) {
      return null;
    }
    rawPath = rawInput.slice(CANONICAL_ORIGIN.length);
  } else if (rawInput.startsWith('/')) {
    // Protocol-relative check: reject '//'
    if (rawInput.startsWith('//')) {
      return null;
    }
    rawPath = rawInput;
  } else {
    // Reject other schemes (http://, ftp://, puuk://, etc.) or non-slash paths
    return null;
  }

  // Path must start with single '/' and contain no duplicate slashes
  if (!rawPath.startsWith('/') || rawPath.includes('//')) {
    return null;
  }

  let hasTrailingSlash = false;
  let cleanPath = rawPath;
  if (cleanPath.endsWith('/')) {
    hasTrailingSlash = true;
    cleanPath = cleanPath.slice(0, -1);
  }

  // Must have exactly two segments: /<type>/<id>
  const segments = cleanPath.slice(1).split('/');
  if (segments.length !== 2) {
    return null;
  }

  const [rawType, rawId] = segments;
  if (rawType !== 'track' && rawType !== 'album' && rawType !== 'artist') {
    return null;
  }

  const type = rawType as ShareEntityType;

  if (type === 'track') {
    if (!isValidTrackId(rawId)) return null;
  } else if (type === 'album') {
    if (!isValidAlbumId(rawId)) return null;
  } else if (type === 'artist') {
    if (!isValidArtistId(rawId)) return null;
  }

  const canonicalPath = `/${type}/${rawId}`;
  const canonicalUrl = `${CANONICAL_ORIGIN}${canonicalPath}`;

  return {
    type,
    id: rawId,
    canonicalPath,
    canonicalUrl,
    hasTrailingSlash,
  };
}

/**
 * Checks if an arbitrary object conforms to a valid canonical ShareTarget.
 */
export function isCanonicalShareTarget(target: unknown): target is { type: ShareEntityType; id: string } {
  if (!target || typeof target !== 'object') return false;
  const t = target as { type?: unknown; id?: unknown };
  if (typeof t.type !== 'string' || typeof t.id !== 'string') return false;
  const parsed = parseShareTarget(`/${t.type}/${t.id}`);
  return parsed !== null && !parsed.hasTrailingSlash;
}

/**
 * Web sharing helper: invokes navigator.share when available, otherwise copies to clipboard.
 * Both receive ONLY the canonical HTTPS entity URL.
 * Cancellation (AbortError) is treated as a neutral outcome ('cancelled').
 */
export async function shareEntityUrl(options: ShareEntityOptions): Promise<ShareActionOutcome> {
  let url: string;
  try {
    url = formatShareUrl(options.type, options.id);
  } catch {
    return 'failed';
  }

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        url,
      });
      return 'shared';
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return 'cancelled';
      }
      // If native share fails for other reasons, proceed to clipboard fallback
    }
  }

  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(url);
      return 'copied';
    } catch {
      return 'failed';
    }
  }

  return 'failed';
}

/** Lossless server ID first; unsafe legacy numbers never become rounded links. */
export function entityShareId(type: ShareEntityType, entity: { id?: unknown; share_id?: unknown }): string | null {
  try {
    const value = entity.share_id ?? entity.id;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return null;
    return parseShareTarget(formatSharePath(type, value))?.id ?? null;
  } catch { return null; }
}
