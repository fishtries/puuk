import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_ORIGIN,
  INT64_MAX,
  formatSharePath,
  formatShareUrl,
  parseShareTarget,
  isValidTrackId,
  isValidAlbumId,
  isValidArtistId,
  isCanonicalShareTarget,
  shareEntityUrl,
} from '../shareLinks.ts';

describe('Permanent web share link formatter and parser', () => {
  const validTrackId = '550e8400-e29b-41d4-a716-446655440000';
  const validAlbumId = '12345';
  const validArtistId = 'art_0123456789abcdef0123456789abcdef';

  describe('ID validators', () => {
    it('validates canonical lowercase UUID track IDs', () => {
      assert.equal(isValidTrackId(validTrackId), true);
      assert.equal(isValidTrackId(validTrackId.toUpperCase()), false, 'uppercase UUID must be rejected');
      assert.equal(isValidTrackId('550e8400e29b41d4a716446655440000'), false, 'UUID without hyphens must be rejected');
      assert.equal(isValidTrackId('not-a-uuid'), false);
      assert.equal(isValidTrackId(null), false);
    });

    it('validates canonical album IDs across decimal strings, safe integers, and BigInt', () => {
      assert.equal(isValidAlbumId('1'), true);
      assert.equal(isValidAlbumId(1), true);
      assert.equal(isValidAlbumId(1n), true);
      assert.equal(isValidAlbumId(String(INT64_MAX)), true);
      assert.equal(isValidAlbumId(INT64_MAX), true);

      // Rejections
      assert.equal(isValidAlbumId(0), false, '0 must be rejected');
      assert.equal(isValidAlbumId('0'), false, '"0" must be rejected');
      assert.equal(isValidAlbumId(0n), false, '0n must be rejected');
      assert.equal(isValidAlbumId(-1), false, '-1 must be rejected');
      assert.equal(isValidAlbumId('-1'), false, '"-1" must be rejected');
      assert.equal(isValidAlbumId('+1'), false, 'sign +1 must be rejected');
      assert.equal(isValidAlbumId('01'), false, 'leading zero must be rejected');
      assert.equal(isValidAlbumId('1e5'), false, 'exponent must be rejected');
      assert.equal(isValidAlbumId('1.5'), false, 'decimal must be rejected');
      assert.equal(isValidAlbumId(1.5), false, 'float must be rejected');
      assert.equal(isValidAlbumId(Number.MAX_SAFE_INTEGER + 1), false, 'unsafe JS integer must be rejected');
      assert.equal(isValidAlbumId(INT64_MAX + 1n), false, 'BigInt int64 overflow must be rejected');
      assert.equal(isValidAlbumId('9223372036854775808'), false, 'string int64 overflow must be rejected');
    });

    it('validates canonical artist IDs', () => {
      assert.equal(isValidArtistId(validArtistId), true);
      assert.equal(isValidArtistId(validArtistId.toUpperCase()), false, 'uppercase hex must be rejected');
      assert.equal(isValidArtistId('art_1234'), false, 'short hex must be rejected');
      assert.equal(isValidArtistId('art_0123456789abcdef0123456789abcdef0'), false, 'long hex must be rejected');
      assert.equal(isValidArtistId('artist_0123456789abcdef0123456789abcdef'), false, 'wrong prefix must be rejected');
      assert.equal(isValidArtistId('various artists'), false, 'names must never be accepted as artist ID');
      assert.equal(isValidArtistId('Various Artists'), false);
    });
  });

  describe('formatShareUrl and formatSharePath', () => {
    it('formats canonical track URLs without trailing slashes', () => {
      const path = formatSharePath('track', validTrackId);
      const url = formatShareUrl('track', validTrackId);
      assert.equal(path, `/track/${validTrackId}`);
      assert.equal(url, `${CANONICAL_ORIGIN}/track/${validTrackId}`);
      assert.equal(url.endsWith('/'), false, 'formatter must never emit trailing slash');
    });

    it('formats canonical album URLs from string, safe number, and BigInt', () => {
      assert.equal(formatShareUrl('album', '42'), `${CANONICAL_ORIGIN}/album/42`);
      assert.equal(formatShareUrl('album', 42), `${CANONICAL_ORIGIN}/album/42`);
      assert.equal(formatShareUrl('album', 42n), `${CANONICAL_ORIGIN}/album/42`);
      assert.equal(formatShareUrl('album', INT64_MAX), `${CANONICAL_ORIGIN}/album/9223372036854775807`);
    });

    it('formats canonical artist URLs', () => {
      const url = formatShareUrl('artist', validArtistId);
      assert.equal(url, `${CANONICAL_ORIGIN}/artist/${validArtistId}`);
    });

    it('throws when formatting unsafe numeric album IDs rather than rounding', () => {
      const unsafeNum = Number.MAX_SAFE_INTEGER + 1;
      assert.throws(() => formatShareUrl('album', unsafeNum), /Invalid share identifier/);
      assert.throws(() => formatShareUrl('album', 0), /Invalid share identifier/);
      assert.throws(() => formatShareUrl('album', -5), /Invalid share identifier/);
    });

    it('throws when formatting invalid or malformed IDs', () => {
      assert.throws(() => formatShareUrl('track', 'not-uuid'), /Invalid share identifier/);
      assert.throws(() => formatShareUrl('track', validTrackId.toUpperCase()), /Invalid share identifier/);
      assert.throws(() => formatShareUrl('album', '9223372036854775808'), /Invalid share identifier/);
      assert.throws(() => formatShareUrl('artist', 'Various Artists'), /Invalid share identifier/);
    });
  });

  describe('parseShareTarget strict raw parser', () => {
    it('parses valid canonical HTTPS URLs', () => {
      const trackRes = parseShareTarget(`${CANONICAL_ORIGIN}/track/${validTrackId}`);
      assert.deepEqual(trackRes, {
        type: 'track',
        id: validTrackId,
        canonicalPath: `/track/${validTrackId}`,
        canonicalUrl: `${CANONICAL_ORIGIN}/track/${validTrackId}`,
        hasTrailingSlash: false,
      });

      const albumRes = parseShareTarget(`${CANONICAL_ORIGIN}/album/${validAlbumId}`);
      assert.deepEqual(albumRes, {
        type: 'album',
        id: validAlbumId,
        canonicalPath: `/album/${validAlbumId}`,
        canonicalUrl: `${CANONICAL_ORIGIN}/album/${validAlbumId}`,
        hasTrailingSlash: false,
      });

      const artistRes = parseShareTarget(`${CANONICAL_ORIGIN}/artist/${validArtistId}`);
      assert.deepEqual(artistRes, {
        type: 'artist',
        id: validArtistId,
        canonicalPath: `/artist/${validArtistId}`,
        canonicalUrl: `${CANONICAL_ORIGIN}/artist/${validArtistId}`,
        hasTrailingSlash: false,
      });
    });

    it('parses valid root-relative canonical paths', () => {
      const res = parseShareTarget(`/track/${validTrackId}`);
      assert.ok(res);
      assert.equal(res.canonicalPath, `/track/${validTrackId}`);
      assert.equal(res.canonicalUrl, `${CANONICAL_ORIGIN}/track/${validTrackId}`);
      assert.equal(res.hasTrailingSlash, false);
    });

    it('parses valid path with single trailing slash and flags hasTrailingSlash: true', () => {
      const res = parseShareTarget(`${CANONICAL_ORIGIN}/track/${validTrackId}/`);
      assert.ok(res);
      assert.equal(res.hasTrailingSlash, true);
      assert.equal(res.canonicalPath, `/track/${validTrackId}`, 'canonical path must not include trailing slash');
    });

    it('rejects external origins and insecure schemes', () => {
      assert.equal(parseShareTarget(`https://evil.com/track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`https://sub.puuk.fun/track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`http://web.puuk.fun/track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`puuk://track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`//web.puuk.fun/track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`//track/${validTrackId}`), null);
    });

    it('rejects credentials and userinfo', () => {
      assert.equal(parseShareTarget(`https://user:pass@web.puuk.fun/track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`user@web.puuk.fun/track/${validTrackId}`), null);
    });

    it('rejects alternate ports', () => {
      assert.equal(parseShareTarget(`https://web.puuk.fun:443/track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`https://web.puuk.fun:80/track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`https://web.puuk.fun:8080/track/${validTrackId}`), null);
    });

    it('rejects backslashes', () => {
      assert.equal(parseShareTarget(`https://web.puuk.fun\\track\\${validTrackId}`), null);
      assert.equal(parseShareTarget(`\\track\\${validTrackId}`), null);
    });

    it('rejects percent-encoded separators and double decodes', () => {
      assert.equal(parseShareTarget(`https://web.puuk.fun/track%2f${validTrackId}`), null);
      assert.equal(parseShareTarget(`https://web.puuk.fun/track%2F${validTrackId}`), null);
      assert.equal(parseShareTarget(`https://web.puuk.fun/track%5c${validTrackId}`), null);
      assert.equal(parseShareTarget(`https://web.puuk.fun/track%2e${validTrackId}`), null);
      assert.equal(parseShareTarget(`/track/${validTrackId}%252f`), null);
    });

    it('rejects dot-segments', () => {
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/track/../album/1`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/track/./${validTrackId}`), null);
      assert.equal(parseShareTarget(`/track/${validTrackId}/..`), null);
      assert.equal(parseShareTarget(`/track/${validTrackId}/.`), null);
      assert.equal(parseShareTarget(`../track/${validTrackId}`), null);
    });

    it('rejects duplicate slashes', () => {
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}//track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/track//${validTrackId}`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/track/${validTrackId}//`), null);
      assert.equal(parseShareTarget(`//track/${validTrackId}`), null);
    });

    it('rejects query parameters and fragments', () => {
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/track/${validTrackId}?returnTo=/`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/track/${validTrackId}?foo=bar`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/track/${validTrackId}#heading`), null);
      assert.equal(parseShareTarget(`/track/${validTrackId}?token=123`), null);
    });

    it('rejects trailing segments', () => {
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/track/${validTrackId}/extra`), null);
      assert.equal(parseShareTarget(`/album/${validAlbumId}/tracks`), null);
    });

    it('rejects whitespace', () => {
      assert.equal(parseShareTarget(` ${CANONICAL_ORIGIN}/track/${validTrackId}`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/track/${validTrackId} `), null);
      assert.equal(parseShareTarget(`\t/track/${validTrackId}`), null);
      assert.equal(parseShareTarget(''), null);
      assert.equal(parseShareTarget(null), null);
    });

    it('rejects invalid album IDs including zeros, signs, exponents, and overflow', () => {
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/album/0`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/album/+42`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/album/-42`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/album/0123`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/album/1e3`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/album/1.5`), null);
      assert.equal(parseShareTarget(`${CANONICAL_ORIGIN}/album/9223372036854775808`), null, 'overflow signed 64-bit max');
    });

    it('rejects uppercase UUIDs and invalid artist IDs', () => {
      assert.equal(parseShareTarget(`/track/${validTrackId.toUpperCase()}`), null);
      assert.equal(parseShareTarget(`/artist/art_various`), null);
      assert.equal(parseShareTarget(`/artist/Various Artists`), null);
      assert.equal(parseShareTarget(`/artist/${validArtistId.toUpperCase()}`), null);
    });
  });

  describe('isCanonicalShareTarget', () => {
    it('accurately verifies target objects', () => {
      assert.equal(isCanonicalShareTarget({ type: 'track', id: validTrackId }), true);
      assert.equal(isCanonicalShareTarget({ type: 'album', id: '42' }), true);
      assert.equal(isCanonicalShareTarget({ type: 'artist', id: validArtistId }), true);

      assert.equal(isCanonicalShareTarget({ type: 'playlist', id: '1' }), false);
      assert.equal(isCanonicalShareTarget({ type: 'track', id: 'invalid-id' }), false);
      assert.equal(isCanonicalShareTarget(null), false);
    });
  });

  describe('shareEntityUrl', () => {
    it('invokes navigator.share when available and reports shared', async () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      let sharedPayload: unknown = null;

      Object.defineProperty(globalThis, 'navigator', {
        value: {
          share: async (payload: unknown) => {
            sharedPayload = payload;
          },
        },
        configurable: true,
      });

      try {
        const result = await shareEntityUrl({
          type: 'track',
          id: validTrackId,
          title: 'Awesome Song',
        });
        assert.equal(result, 'shared');
        assert.deepEqual(sharedPayload, {
          url: `${CANONICAL_ORIGIN}/track/${validTrackId}`,
        });
      } finally {
        if (origDescriptor) {
          Object.defineProperty(globalThis, 'navigator', origDescriptor);
        }
      }
    });

    it('reports cancelled neutrally when navigator.share aborts', async () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      const abortError = new Error('Share canceled');
      abortError.name = 'AbortError';

      Object.defineProperty(globalThis, 'navigator', {
        value: {
          share: async () => {
            throw abortError;
          },
        },
        configurable: true,
      });

      try {
        const result = await shareEntityUrl({ type: 'track', id: validTrackId });
        assert.equal(result, 'cancelled');
      } finally {
        if (origDescriptor) {
          Object.defineProperty(globalThis, 'navigator', origDescriptor);
        }
      }
    });

    it('falls back to navigator.clipboard.writeText when share unavailable', async () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      let copiedText = '';

      Object.defineProperty(globalThis, 'navigator', {
        value: {
          clipboard: {
            writeText: async (text: string) => {
              copiedText = text;
            },
          },
        },
        configurable: true,
      });

      try {
        const result = await shareEntityUrl({ type: 'album', id: '42' });
        assert.equal(result, 'copied');
        assert.equal(copiedText, `${CANONICAL_ORIGIN}/album/42`);
      } finally {
        if (origDescriptor) {
          Object.defineProperty(globalThis, 'navigator', origDescriptor);
        }
      }
    });

    it('reports failed when both share and clipboard fail or input is invalid', async () => {
      const origDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
      });

      try {
        const result = await shareEntityUrl({ type: 'track', id: 'not-a-uuid' });
        assert.equal(result, 'failed');
      } finally {
        if (origDescriptor) {
          Object.defineProperty(globalThis, 'navigator', origDescriptor);
        }
      }
    });
  });
});
