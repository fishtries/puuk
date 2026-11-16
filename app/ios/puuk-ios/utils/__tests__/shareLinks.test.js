import { Share } from 'react-native';
import {
  CANONICAL_ORIGIN,
  MAX_SIGNED_64_INT,
  validateTrackId,
  validateAlbumId,
  validateArtistId,
  extractEntityShareId,
  formatShareUrl,
  formatTrackShareUrl,
  formatAlbumShareUrl,
  formatArtistShareUrl,
  parseShareUrl,
  isValidShareUrl,
  shareEntity,
} from '../shareLinks';
import {
  fetchShareEntity,
  resolveShareUrl,
  ShareApiError,
  SHARE_API_TIMEOUT_MS,
} from '../../shared/api/share';
import * as apiModule from '../../shared/api/api';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
}));

describe('shareLinks.js — Puuk iOS Permanent Links & Share Helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. ID Validation & 64-bit Precision', () => {
    describe('validateTrackId', () => {
      it('accepts valid canonical lowercase UUID', () => {
        const id = '12345678-1234-4234-8234-123456789abc';
        expect(validateTrackId(id)).toBe(id);
      });

      it('rejects uppercase UUIDs', () => {
        const id = '12345678-1234-4234-8234-123456789ABC';
        expect(() => validateTrackId(id)).toThrow();
      });

      it('rejects malformed track IDs', () => {
        expect(() => validateTrackId('not-a-uuid')).toThrow();
        expect(() => validateTrackId('12345678-1234-4234-8234-123456789abg')).toThrow(); // non-hex
        expect(() => validateTrackId('')).toThrow();
        expect(() => validateTrackId(null)).toThrow();
        expect(() => validateTrackId(12345)).toThrow();
      });
    });

    describe('validateAlbumId & 64-bit boundary', () => {
      it('accepts positive safe integer numbers', () => {
        expect(validateAlbumId(1)).toBe('1');
        expect(validateAlbumId(42)).toBe('42');
        expect(validateAlbumId(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER));
      });

      it('rejects unsafe rounded numbers (> Number.MAX_SAFE_INTEGER)', () => {
        const unsafeNum = Number.MAX_SAFE_INTEGER + 1; // 9007199254740992
        expect(() => validateAlbumId(unsafeNum)).toThrow();
      });

      it('accepts valid canonical decimal strings up to 64-bit signed max', () => {
        expect(validateAlbumId('1')).toBe('1');
        expect(validateAlbumId('42')).toBe('42');
        expect(validateAlbumId('9007199254740992')).toBe('9007199254740992');
        expect(validateAlbumId('9223372036854775807')).toBe('9223372036854775807');
      });

      it('accepts valid BigInt values up to 64-bit signed max', () => {
        expect(validateAlbumId(1n)).toBe('1');
        expect(validateAlbumId(42n)).toBe('42');
        expect(validateAlbumId(MAX_SIGNED_64_INT)).toBe('9223372036854775807');
      });

      it('rejects 64-bit overflow', () => {
        // 9223372036854775808 is MAX_SIGNED_64_INT + 1
        expect(() => validateAlbumId('9223372036854775808')).toThrow();
        expect(() => validateAlbumId(MAX_SIGNED_64_INT + 1n)).toThrow();
        expect(() => validateAlbumId('999999999999999999999999')).toThrow();
      });

      it('rejects non-positive numbers and zeros', () => {
        expect(() => validateAlbumId(0)).toThrow();
        expect(() => validateAlbumId('0')).toThrow();
        expect(() => validateAlbumId(0n)).toThrow();
        expect(() => validateAlbumId(-1)).toThrow();
        expect(() => validateAlbumId('-1')).toThrow();
        expect(() => validateAlbumId(-10n)).toThrow();
      });

      it('rejects signs, leading zeros, exponents, and floats in decimal strings', () => {
        expect(() => validateAlbumId('+1')).toThrow();
        expect(() => validateAlbumId('+42')).toThrow();
        expect(() => validateAlbumId('01')).toThrow();
        expect(() => validateAlbumId('007')).toThrow();
        expect(() => validateAlbumId('1e5')).toThrow();
        expect(() => validateAlbumId('1.5')).toThrow();
        expect(() => validateAlbumId(1.5)).toThrow();
      });
    });

    describe('validateArtistId', () => {
      it('accepts valid art_ + 32 lowercase hex characters', () => {
        const id = 'art_0123456789abcdef0123456789abcdef';
        expect(validateArtistId(id)).toBe(id);
      });

      it('rejects reserved "various artists"', () => {
        expect(() => validateArtistId('art_various')).toThrow();
        expect(() => validateArtistId('various')).toThrow();
        expect(() => validateArtistId('various artists')).toThrow();
      });

      it('rejects raw artist names without name hashing', () => {
        expect(() => validateArtistId('Radiohead')).toThrow();
        expect(() => validateArtistId('The Beatles')).toThrow();
      });

      it('rejects non-32-hex or malformed artist IDs', () => {
        expect(() => validateArtistId('art_123')).toThrow();
        expect(() => validateArtistId('art_0123456789abcdef0123456789abcdeg')).toThrow(); // non-hex
        expect(() => validateArtistId('0123456789abcdef0123456789abcdef')).toThrow(); // missing art_ prefix
      });
    });
  });

  describe('2. Entity Share ID Extraction & Safety Rules', () => {
    it('extracts lossless share_id when available', () => {
      const track = { share_id: '12345678-1234-4234-8234-123456789abc', title: 'Song' };
      expect(extractEntityShareId(track, 'track')).toBe('12345678-1234-4234-8234-123456789abc');

      const album = { share_id: '9223372036854775807', title: 'Album' };
      expect(extractEntityShareId(album, 'album')).toBe('9223372036854775807');

      const artist = { share_id: 'art_0123456789abcdef0123456789abcdef', name: 'Artist' };
      expect(extractEntityShareId(artist, 'artist')).toBe('art_0123456789abcdef0123456789abcdef');
    });

    it('falls back to legacy id only when valid and safe', () => {
      const track = { id: '12345678-1234-4234-8234-123456789abc' };
      expect(extractEntityShareId(track, 'track')).toBe('12345678-1234-4234-8234-123456789abc');

      const albumSafe = { id: 42 };
      expect(extractEntityShareId(albumSafe, 'album')).toBe('42');

      const artist = { id: 'art_0123456789abcdef0123456789abcdef' };
      expect(extractEntityShareId(artist, 'artist')).toBe('art_0123456789abcdef0123456789abcdef');
    });

    it('rejects unsafe numeric album IDs lacking share_id', () => {
      const albumUnsafe = { id: 9007199254740992 };
      expect(() => extractEntityShareId(albumUnsafe, 'album')).toThrow();
    });

    it('throws meaningful error if entity lacks ID (no guessed first entity)', () => {
      const trackWithoutId = { title: 'Unknown Song' };
      expect(() => extractEntityShareId(trackWithoutId, 'track')).toThrow(
        /lacks a valid ID or share_id. Guessing entity identity is prohibited/,
      );

      // Even if track has artists array, it must NOT guess the first artist's ID
      const trackWithArtists = {
        title: 'Song',
        artists: [{ id: 'art_0123456789abcdef0123456789abcdef', name: 'Artist' }],
      };
      expect(() => extractEntityShareId(trackWithArtists, 'track')).toThrow(
        /lacks a valid ID or share_id/,
      );
    });
  });

  describe('3. Formatter Output Format', () => {
    it('formats canonical track HTTPS URL without trailing slash', () => {
      const url = formatShareUrl('track', '12345678-1234-4234-8234-123456789abc');
      expect(url).toBe('https://web.puuk.fun/track/12345678-1234-4234-8234-123456789abc');
      expect(url.endsWith('/')).toBe(false);
    });

    it('formats canonical album HTTPS URL with 64-bit integer ID', () => {
      const url = formatShareUrl('album', '9223372036854775807');
      expect(url).toBe('https://web.puuk.fun/album/9223372036854775807');
    });

    it('formats canonical artist HTTPS URL', () => {
      const url = formatShareUrl('artist', 'art_0123456789abcdef0123456789abcdef');
      expect(url).toBe('https://web.puuk.fun/artist/art_0123456789abcdef0123456789abcdef');
    });

    it('formats directly from entity objects via helper methods', () => {
      const trackUrl = formatTrackShareUrl({ share_id: '12345678-1234-4234-8234-123456789abc' });
      expect(trackUrl).toBe('https://web.puuk.fun/track/12345678-1234-4234-8234-123456789abc');

      const albumUrl = formatAlbumShareUrl({ album_id: 100 });
      expect(albumUrl).toBe('https://web.puuk.fun/album/100');

      const artistUrl = formatArtistShareUrl({ id: 'art_0123456789abcdef0123456789abcdef' });
      expect(artistUrl).toBe('https://web.puuk.fun/artist/art_0123456789abcdef0123456789abcdef');
    });
  });

  describe('4. Raw-URL Hostile Input Parsing & Normalization', () => {
    const validTrackId = '12345678-1234-4234-8234-123456789abc';
    const validAlbumId = '9223372036854775807';
    const validArtistId = 'art_0123456789abcdef0123456789abcdef';

    it('accepts valid full HTTPS URLs', () => {
      const res = parseShareUrl(`https://web.puuk.fun/track/${validTrackId}`);
      expect(res).toEqual({
        type: 'track',
        id: validTrackId,
        normalizedPath: `/track/${validTrackId}`,
        canonicalUrl: `https://web.puuk.fun/track/${validTrackId}`,
      });
      expect(isValidShareUrl(`https://web.puuk.fun/track/${validTrackId}`)).toBe(true);
    });

    it('accepts valid root-relative paths', () => {
      const res = parseShareUrl(`/album/${validAlbumId}`);
      expect(res).toEqual({
        type: 'album',
        id: validAlbumId,
        normalizedPath: `/album/${validAlbumId}`,
        canonicalUrl: `https://web.puuk.fun/album/${validAlbumId}`,
      });
    });

    it('normalizes exactly one trailing slash ONLY after successful ID validation', () => {
      const res = parseShareUrl(`https://web.puuk.fun/track/${validTrackId}/`);
      expect(res).toEqual({
        type: 'track',
        id: validTrackId,
        normalizedPath: `/track/${validTrackId}`,
        canonicalUrl: `https://web.puuk.fun/track/${validTrackId}`,
      });

      // Trailing slash on invalid ID must fail validation
      expect(parseShareUrl('https://web.puuk.fun/track/invalid-id/')).toBeNull();
    });

    it('rejects other origins and subdomains', () => {
      expect(parseShareUrl(`https://media.puuk.fun/track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`https://evil.com/track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`https://web.puuk.fun.evil.com/track/${validTrackId}`)).toBeNull();
    });

    it('rejects non-HTTPS custom schemes and insecure HTTP', () => {
      expect(parseShareUrl(`http://web.puuk.fun/track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`puuk://track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`javascript:alert(1)`)).toBeNull();
      expect(parseShareUrl(`data:text/html,...`)).toBeNull();
    });

    it('rejects protocol-relative URLs', () => {
      expect(parseShareUrl(`//web.puuk.fun/track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`//track/${validTrackId}`)).toBeNull();
    });

    it('rejects alternate or explicit ports', () => {
      expect(parseShareUrl(`https://web.puuk.fun:443/track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`https://web.puuk.fun:8080/track/${validTrackId}`)).toBeNull();
    });

    it('rejects userinfo (@)', () => {
      expect(parseShareUrl(`https://user:pass@web.puuk.fun/track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`https://user@web.puuk.fun/track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`/track/${validTrackId}@evil`)).toBeNull();
    });

    it('rejects backslashes', () => {
      expect(parseShareUrl(`https://web.puuk.fun\\track\\${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`/track\\${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`\\track\\${validTrackId}`)).toBeNull();
    });

    it('rejects query parameters and fragments', () => {
      expect(parseShareUrl(`https://web.puuk.fun/track/${validTrackId}?token=secret`)).toBeNull();
      expect(parseShareUrl(`https://web.puuk.fun/track/${validTrackId}?v=1`)).toBeNull();
      expect(parseShareUrl(`https://web.puuk.fun/track/${validTrackId}#heading`)).toBeNull();
    });

    it('rejects percent-encoded separators (%2f, %5c) and dot segments (%2e)', () => {
      expect(parseShareUrl(`https://web.puuk.fun/track%2f${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`https://web.puuk.fun%2ftrack/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`/track%5c${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`/track/%2e%2e/album/1`)).toBeNull();
    });

    it('rejects dot segments (/./, /../, /., /..)', () => {
      expect(parseShareUrl(`/track/../album/1`)).toBeNull();
      expect(parseShareUrl(`/./track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`/track/./${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`/track/${validTrackId}/..`)).toBeNull();
    });

    it('rejects duplicate separators (//)', () => {
      expect(parseShareUrl(`https://web.puuk.fun//track/${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`/track//${validTrackId}`)).toBeNull();
      expect(parseShareUrl(`https://web.puuk.fun/track/${validTrackId}//`)).toBeNull();
    });

    it('rejects extra segments or missing segments', () => {
      expect(parseShareUrl(`/track/${validTrackId}/extra`)).toBeNull();
      expect(parseShareUrl(`/album/${validAlbumId}/tracks`)).toBeNull();
      expect(parseShareUrl(`/track`)).toBeNull();
      expect(parseShareUrl(`/track/`)).toBeNull();
      expect(parseShareUrl(`/`)).toBeNull();
      expect(parseShareUrl(``)).toBeNull();
    });

    it('rejects album overflow, zeros, and malformed numeric IDs during parsing', () => {
      expect(parseShareUrl(`/album/9223372036854775808`)).toBeNull(); // overflow
      expect(parseShareUrl(`/album/0`)).toBeNull(); // zero
      expect(parseShareUrl(`/album/042`)).toBeNull(); // leading zero
      expect(parseShareUrl(`/album/+42`)).toBeNull(); // plus sign
      expect(parseShareUrl(`/album/-42`)).toBeNull(); // minus sign
      expect(parseShareUrl(`/album/1e5`)).toBeNull(); // exponent
      expect(parseShareUrl(`/album/1.5`)).toBeNull(); // float
    });

    it('rejects various artists and invalid artist IDs during parsing', () => {
      expect(parseShareUrl(`/artist/art_various`)).toBeNull();
      expect(parseShareUrl(`/artist/Radiohead`)).toBeNull();
      expect(parseShareUrl(`/artist/art_123`)).toBeNull();
    });
  });

  describe('5. Native React Native Share Helper', () => {
    const validTrackId = '12345678-1234-4234-8234-123456789abc';
    let shareSpy;

    beforeEach(() => {
      shareSpy = jest.spyOn(Share, 'share');
    });

    afterEach(() => {
      shareSpy.mockRestore();
    });

    it('shares canonical HTTPS URL successfully', async () => {
      shareSpy.mockResolvedValueOnce({
        action: Share.sharedAction,
        activityType: 'com.apple.UIKit.activity.CopyToPasteboard',
      });

      const res = await shareEntity({
        share_id: validTrackId,
        type: 'track',
        title: 'My Track',
      });

      expect(shareSpy).toHaveBeenCalledWith(
        { url: `https://web.puuk.fun/track/${validTrackId}` },
        {},
      );
      expect(res).toEqual({
        status: 'shared',
        completed: true,
        action: Share.sharedAction,
        activityType: 'com.apple.UIKit.activity.CopyToPasteboard',
        url: `https://web.puuk.fun/track/${validTrackId}`,
      });
    });

    it('handles user cancellation neutrally without misleading success', async () => {
      shareSpy.mockResolvedValueOnce({
        action: Share.dismissedAction,
        activityType: null,
      });

      const res = await shareEntity(`https://web.puuk.fun/track/${validTrackId}`);

      expect(res).toEqual({
        status: 'dismissed',
        completed: false, // NOT true, avoiding misleading success
        action: Share.dismissedAction,
        activityType: null,
        url: `https://web.puuk.fun/track/${validTrackId}`,
      });
    });

    it('handles native share dialog errors safely', async () => {
      shareSpy.mockRejectedValueOnce(new Error('User cancelled via system'));

      const res = await shareEntity(`https://web.puuk.fun/track/${validTrackId}`);

      expect(res.status).toBe('error');
      expect(res.completed).toBe(false);
      expect(res.error).toBeDefined();
    });

    it('rejects entity lacking ID before calling native Share (no guessed entity)', async () => {
      const res = await shareEntity({ title: 'Song without ID', type: 'track' });

      expect(shareSpy).not.toHaveBeenCalled();
      expect(res.status).toBe('error');
      expect(res.completed).toBe(false);
      expect(res.error.message).toBe('Не удалось поделиться ссылкой');
    });

    it('rejects invalid URL string before calling native Share', async () => {
      const res = await shareEntity('https://evil.com/track/123');

      expect(shareSpy).not.toHaveBeenCalled();
      expect(res.status).toBe('error');
      expect(res.completed).toBe(false);
      expect(res.error.message).toBe('Не удалось поделиться ссылкой');
    });
  });

});
