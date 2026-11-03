import * as SecureStore from 'expo-secure-store';
import {
  setAuthToken,
  logout,
  SERVER_URL,
  ApiError,
} from '../api';
import {
  getArtists,
  fetchArtists,
  getArtist,
  fetchArtist,
  getArtistDetail,
  updateArtistArtwork,
  uploadArtistArtwork,
  putArtistArtwork,
  deleteArtistArtwork,
  removeArtistArtwork,
  recordPlayStart,
  logPlayStart,
  getArtistArtworkUrl,
  resolveArtistArtworkUrl,
  normalizeArtistDTO,
  normalizeArtworkUrl,
  stripTokenFromUrl,
} from '../artists';

const mockStore = new Map();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key) => mockStore.get(key) || null),
  setItemAsync: jest.fn(async (key, val) => {
    mockStore.set(key, String(val));
  }),
  deleteItemAsync: jest.fn(async (key) => {
    mockStore.delete(key);
  }),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
}));

describe('shared/api/artists', () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStore.clear();
    await logout();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('getArtists / fetchArtists (GET /api/artists)', () => {
    it('calls GET /api/artists when no search query is provided', async () => {
      const mockArtists = [
        { id: 'art_1', name: 'Radiohead', track_count: 12, album_count: 2, artwork_version: 0, artwork_url: null },
        { id: 'art_2', name: 'The Beatles', track_count: 24, album_count: 3, artwork_version: 1, artwork_url: 'https://other.host/api/artists/art_2/artwork?v=1' },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockArtists,
      });

      const result = await getArtists();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(`${SERVER_URL}/api/artists`);
      expect(calledOptions.method).toBe('GET');

      // Predictable DTO mapping: artwork_url normalized, no token in URL
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'art_1',
        name: 'Radiohead',
        track_count: 12,
        album_count: 2,
        artwork_version: 0,
        artwork_url: null,
      });
      expect(result[1]).toEqual({
        id: 'art_2',
        name: 'The Beatles',
        track_count: 24,
        album_count: 3,
        artwork_version: 1,
        artwork_url: `${SERVER_URL}/api/artists/art_2/artwork?v=1`,
      });
    });

    it('calls GET /api/artists?q=query with proper encoding when string query is given', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await fetchArtists('Pink Floyd & Co');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(`${SERVER_URL}/api/artists?q=Pink%20Floyd%20%26%20Co`);
    });

    it('calls GET /api/artists?q=query when options object with q is provided', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });

      await getArtists({ q: 'Nirvana' });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(`${SERVER_URL}/api/artists?q=Nirvana`);
    });

    it('returns empty array [] when response is not an array', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => null,
      });

      const result = await getArtists();
      expect(result).toEqual([]);
    });

    it('normalizes artwork_url and strips any auth token from returned artists', async () => {
      const mockRaw = [
        {
          id: 'art_10',
          name: 'Artist With Token In Backend Url',
          track_count: 5,
          album_count: 1,
          artwork_version: 0,
          artwork_url: 'https://backend.puuk.fun/api/artists/art_10/artwork?v=1&token=leaked_secret',
        },
        {
          id: 'art_11',
          name: 'Artist With Cover Fallback (Contract 4.5 Violation By Backend)',
          track_count: 2,
          album_count: 1,
          artwork_version: 0,
          artwork_url: 'https://backend.puuk.fun/api/cover/track_123',
        },
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockRaw,
      });

      const result = await getArtists();
      // First artist has token stripped
      expect(result[0].artwork_url).toBe(`${SERVER_URL}/api/artists/art_10/artwork?v=1`);
      expect(result[0].artwork_url).not.toContain('token=');
      // Second artist has /api/cover/ rejected per contract 4.5
      expect(result[1].artwork_url).toBeNull();
    });

    it('supports AbortSignal and aborts requests', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(getArtists({ signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('throws ApiError with status and detail on non-200 responses', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ detail: 'Internal server error' }),
      });

      await expect(getArtists()).rejects.toThrow('Internal server error');
      await expect(getArtists()).rejects.toBeInstanceOf(ApiError);
    });

    it('propagates network errors to caller', async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

      await expect(getArtists({ retry: 0 })).rejects.toMatchObject({
        name: 'NetworkError',
      });
    });
  });

  describe('getArtist / fetchArtist / getArtistDetail (GET /api/artists/{id})', () => {
    const mockDetail = {
      artist: {
        id: 'art_123',
        name: 'Radiohead',
        track_count: 50,
        album_count: 6,
        artwork_version: 1,
        artwork_url: 'https://server.domain/api/artists/art_123/artwork?v=1',
      },
      popular_tracks: [{ id: 't_1', title: 'Creep', play_count: 42 }],
      albums: [{ id: 'alb_1', title: 'OK Computer', year: '1997' }],
    };

    it('calls GET /api/artists/{artistId} and returns normalized artist detail payload', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockDetail,
      });

      const result = await getArtist('art_123');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(`${SERVER_URL}/api/artists/art_123`);
      expect(calledOptions.method).toBe('GET');

      expect(result.artist).toEqual({
        id: 'art_123',
        name: 'Radiohead',
        track_count: 50,
        album_count: 6,
        artwork_version: 1,
        artwork_url: `${SERVER_URL}/api/artists/art_123/artwork?v=1`,
      });
      expect(result.popular_tracks).toEqual([expect.objectContaining({ id: 't_1', title: 'Creep', play_count: 42, artists: [] })]);
      expect(result.albums).toEqual([expect.objectContaining({ id: 'alb_1', title: 'OK Computer', year: '1997', artists: [] })]);
    });

    it('encodes artistId properly in the URL path', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockDetail,
      });

      await fetchArtist('art/test 1');

      const [calledUrl] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(`${SERVER_URL}/api/artists/art%2Ftest%201`);
    });

    it('aliases getArtistDetail and fetchArtist to getArtist', () => {
      expect(getArtistDetail).toBe(getArtist);
      expect(fetchArtist).toBe(getArtist);
    });

    it('throws ApiError when artistId is missing or empty', async () => {
      await expect(getArtist('')).rejects.toThrow('Artist ID is required');
      await expect(getArtist(null)).rejects.toThrow('Artist ID is required');
      await expect(getArtist('   ')).rejects.toThrow('Artist ID is required');
    });

    it('throws ApiError with status 404 when artist is not found', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ detail: 'Артист не найден' }),
      });

      await expect(getArtist('art_unknown')).rejects.toMatchObject({
        name: 'ApiError',
        status: 404,
        message: 'Артист не найден',
      });
    });

    it('supports AbortSignal on getArtist', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(getArtist('art_123', { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
    });

    it('propagates network errors on getArtist', async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

      await expect(getArtist('art_123', { retry: 0 })).rejects.toMatchObject({
        name: 'NetworkError',
      });
    });
  });

  describe('updateArtistArtwork / uploadArtistArtwork / putArtistArtwork (PUT /api/artists/{id}/artwork)', () => {
    it('sends PUT /api/artists/{artistId}/artwork with multipart FormData and does NOT set JSON Content-Type', async () => {
      const mockResult = { status: 'updated', artist_id: 'art_123', artwork_version: 2 };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResult,
      });

      const fileObj = {
        uri: 'file:///path/to/image.jpg',
        name: 'custom_artwork.jpg',
        type: 'image/jpeg',
      };

      const result = await updateArtistArtwork('art_123', fileObj);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(`${SERVER_URL}/api/artists/art_123/artwork`);
      expect(calledOptions.method).toBe('PUT');

      // Crucial requirement: multipart body MUST NOT set JSON Content-Type
      expect(calledOptions.headers['Content-Type']).toBeUndefined();
      expect(calledOptions.headers['content-type']).toBeUndefined();

      expect(calledOptions.body).toBeInstanceOf(FormData);
      expect(result).toEqual(mockResult);
    });

    it('handles native FormData instance directly', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'updated', artist_id: 'art_123', artwork_version: 1 }),
      });

      const formData = new FormData();
      formData.append('file', 'binarydata');

      await uploadArtistArtwork('art_123', formData);

      const [, calledOptions] = global.fetch.mock.calls[0];
      expect(calledOptions.body).toBe(formData);
      expect(calledOptions.headers['Content-Type']).toBeUndefined();
    });

    it('aliases uploadArtistArtwork and putArtistArtwork to updateArtistArtwork', () => {
      expect(uploadArtistArtwork).toBe(updateArtistArtwork);
      expect(putArtistArtwork).toBe(updateArtistArtwork);
    });

    it('validates artistId and file', async () => {
      await expect(updateArtistArtwork('', { uri: 'file://x' })).rejects.toThrow('Artist ID is required');
      await expect(updateArtistArtwork('art_1', null)).rejects.toThrow('File is required to update artwork');
    });

    it('throws ApiError on upload errors (401, 403, 413, 415)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 413,
        json: async () => ({ detail: 'Изображение должно быть не больше 5 MiB' }),
      });

      await expect(
        updateArtistArtwork('art_1', { uri: 'file://too-big.jpg' })
      ).rejects.toMatchObject({
        name: 'ApiError',
        status: 413,
        message: 'Изображение должно быть не больше 5 MiB',
      });
    });

    it('propagates network and abort errors on artwork upload', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        updateArtistArtwork('art_1', { uri: 'file://img.jpg' }, { signal: controller.signal })
      ).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  });

  describe('deleteArtistArtwork / removeArtistArtwork (DELETE /api/artists/{id}/artwork)', () => {
    it('sends DELETE /api/artists/{artistId}/artwork and returns confirmation', async () => {
      const mockResult = { status: 'removed', artist_id: 'art_123' };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResult,
      });

      const result = await deleteArtistArtwork('art_123');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(`${SERVER_URL}/api/artists/art_123/artwork`);
      expect(calledOptions.method).toBe('DELETE');
      expect(result).toEqual(mockResult);
    });

    it('aliases removeArtistArtwork to deleteArtistArtwork', () => {
      expect(removeArtistArtwork).toBe(deleteArtistArtwork);
    });

    it('validates artistId', async () => {
      await expect(deleteArtistArtwork('')).rejects.toThrow('Artist ID is required');
      await expect(deleteArtistArtwork(null)).rejects.toThrow('Artist ID is required');
    });

    it('throws ApiError on deletion errors (e.g. 403 Forbidden)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ detail: 'Недостаточно прав администратора' }),
      });

      await expect(deleteArtistArtwork('art_123')).rejects.toMatchObject({
        name: 'ApiError',
        status: 403,
        message: 'Недостаточно прав администратора',
      });
    });
  });

  describe('recordPlayStart / logPlayStart (POST /api/tracks/{id}/play-start) & EV-17 retry semantics', () => {
    it('sends POST /api/tracks/{trackId}/play-start and returns status recorded', async () => {
      const mockResult = { status: 'recorded', track_id: 'track_456' };
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResult,
      });

      const result = await recordPlayStart('track_456');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = global.fetch.mock.calls[0];
      expect(calledUrl).toBe(`${SERVER_URL}/api/tracks/track_456/play-start`);
      expect(calledOptions.method).toBe('POST');
      expect(result).toEqual(mockResult);
    });

    it('handles idempotent duplicate start and ignored responses', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: 'duplicate', track_id: 'track_456' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: 'ignored', track_id: 'track_various' }),
        });

      const resDuplicate = await logPlayStart('track_456');
      expect(resDuplicate.status).toBe('duplicate');

      const resIgnored = await recordPlayStart('track_various');
      expect(resIgnored.status).toBe('ignored');
    });

    it('validates trackId', async () => {
      await expect(recordPlayStart('')).rejects.toThrow('Track ID is required');
      await expect(recordPlayStart(null)).rejects.toThrow('Track ID is required');
    });

    it('throws ApiError when track is not found (404) and does not retry on 404', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ detail: 'Трек не найден' }),
      });

      await expect(recordPlayStart('non_existent', { retryDelay: 0 })).rejects.toMatchObject({
        name: 'ApiError',
        status: 404,
        message: 'Трек не найден',
      });
      // 404 is client error: must not be retried!
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries exactly once on transient network failure and succeeds (EV-17)', async () => {
      // First attempt fails with network error, second attempt succeeds
      global.fetch = jest.fn()
        .mockRejectedValueOnce(new TypeError('Network request failed'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ status: 'recorded', track_id: 'track_retry' }),
        });

      const result = await recordPlayStart('track_retry', { retryDelay: 0 });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ status: 'recorded', track_id: 'track_retry' });
    });

    it('bounds retries to at most one and throws to caller when all attempts fail', async () => {
      // Both attempts fail with network error
      global.fetch = jest.fn()
        .mockRejectedValueOnce(new TypeError('Network request failed'))
        .mockRejectedValueOnce(new TypeError('Network request failed'));

      // Even if caller asks for retry: 5, it is clamped to at most 1 retry (2 attempts total)
      await expect(
        recordPlayStart('track_retry', { retry: 5, retryDelay: 0 })
      ).rejects.toMatchObject({
        name: 'NetworkError',
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('allows caller to disable retry with retry: 0', async () => {
      global.fetch = jest.fn().mockRejectedValueOnce(new TypeError('Network request failed'));

      await expect(
        recordPlayStart('track_noretry', { retry: 0, retryDelay: 0 })
      ).rejects.toMatchObject({
        name: 'NetworkError',
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('allows caller to catch error so that no error is visible to user', async () => {
      global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

      let caught = false;
      await recordPlayStart('track_silent', { retryDelay: 0 }).catch(() => {
        caught = true;
      });

      expect(caught).toBe(true);
    });
  });

  describe('Artwork URL handling & Auth Never In URL constraint', () => {
    it('getArtistArtworkUrl builds absolute URL with version query and NEVER appends token', async () => {
      await setAuthToken('jwt_super_secret');

      const url = getArtistArtworkUrl('art_99', 3);
      expect(url).toBe(`${SERVER_URL}/api/artists/art_99/artwork?v=3`);
      expect(url).not.toContain('token=');
      expect(url).not.toContain('jwt_super_secret');
    });

    it('getArtistArtworkUrl works with artist object directly and never appends token', async () => {
      await setAuthToken('jwt_super_secret');

      const artist = { id: 'art_42', artwork_version: 5 };
      const url = getArtistArtworkUrl(artist);
      expect(url).toBe(`${SERVER_URL}/api/artists/art_42/artwork?v=5`);
      expect(url).not.toContain('token=');
    });

    it('supports custom serverUrl in getArtistArtworkUrl', () => {
      const url = getArtistArtworkUrl('art_1', 1, {
        serverUrl: 'https://music.custom.net',
        token: 'should_be_ignored',
      });
      expect(url).toBe('https://music.custom.net/api/artists/art_1/artwork?v=1');
      expect(url).not.toContain('token=');
    });

    it('returns empty string if artistId is absent or invalid', () => {
      expect(getArtistArtworkUrl('')).toBe('');
      expect(getArtistArtworkUrl(null)).toBe('');
      expect(getArtistArtworkUrl({})).toBe('');
    });

    it('resolveArtistArtworkUrl prioritizes artwork_version > 0 and never appends token', async () => {
      await setAuthToken('jwt_tok');

      const artistWithVersion = {
        id: 'art_10',
        artwork_version: 2,
        artwork_url: 'https://cdn.example.com/art.jpg',
      };
      const resolved = resolveArtistArtworkUrl(artistWithVersion);
      expect(resolved).toBe(`${SERVER_URL}/api/artists/art_10/artwork?v=2`);
      expect(resolved).not.toContain('token=');
    });

    it('resolveArtistArtworkUrl normalizes valid artwork_url without token', () => {
      const artist = {
        id: 'art_20',
        artwork_version: 0,
        artwork_url: 'https://foreign.puuk.app/api/artists/art_20/artwork?v=1&token=leaked',
      };
      const resolved = resolveArtistArtworkUrl(artist);
      expect(resolved).toBe(`${SERVER_URL}/api/artists/art_20/artwork?v=1`);
      expect(resolved).not.toContain('token=');
    });

    it('resolveArtistArtworkUrl strictly rejects fallback to /api/cover/ and cover_track_id per Contract 4.5', () => {
      const artistWithCoverUrl = {
        id: 'art_11',
        artwork_version: 0,
        artwork_url: '/api/cover/track_abc',
      };
      expect(resolveArtistArtworkUrl(artistWithCoverUrl)).toBe('');

      const artistWithCoverTrack = {
        id: 'art_12',
        artwork_version: 0,
        cover_track_id: 'track_xyz',
      };
      expect(resolveArtistArtworkUrl(artistWithCoverTrack)).toBe('');
    });

    it('stripTokenFromUrl removes token query param regardless of position', () => {
      expect(stripTokenFromUrl('https://puuk.fun/api/artwork?token=abc')).toBe('https://puuk.fun/api/artwork');
      expect(stripTokenFromUrl('https://puuk.fun/api/artwork?token=abc&v=2')).toBe('https://puuk.fun/api/artwork?v=2');
      expect(stripTokenFromUrl('https://puuk.fun/api/artwork?v=2&token=abc')).toBe('https://puuk.fun/api/artwork?v=2');
      expect(stripTokenFromUrl('https://puuk.fun/api/artwork?v=2&token=abc&size=large')).toBe('https://puuk.fun/api/artwork?v=2&size=large');
      expect(stripTokenFromUrl('/api/artwork?token=abc&v=1')).toBe('/api/artwork?v=1');
      expect(stripTokenFromUrl('')).toBe('');
      expect(stripTokenFromUrl(null)).toBe('');
    });

    it('normalizeArtworkUrl returns null for cover track urls', () => {
      expect(normalizeArtworkUrl('/api/cover/track_1')).toBeNull();
      expect(normalizeArtworkUrl('https://backend/api/cover/track_1?v=1')).toBeNull();
      expect(normalizeArtworkUrl(null)).toBeNull();
      expect(normalizeArtworkUrl('')).toBeNull();
    });

    it('normalizeArtistDTO normalizes artist fields predictably', () => {
      const raw = {
        id: 'art_99',
        name: 'Normalized Artist',
        track_count: 'invalid',
        album_count: 3,
        artwork_version: 2,
      };

      const normalized = normalizeArtistDTO(raw);
      expect(normalized).toEqual({
        id: 'art_99',
        name: 'Normalized Artist',
        track_count: 0,
        album_count: 3,
        artwork_version: 2,
        artwork_url: `${SERVER_URL}/api/artists/art_99/artwork?v=2`,
      });
    });
  });
});
