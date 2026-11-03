import { normalizeStreamUrl } from '../streamUrl';

describe('normalizeStreamUrl', () => {
  const defaultServer = 'https://web.puuk.fun';

  test('returns empty string if track is null or undefined', () => {
    expect(normalizeStreamUrl(null)).toBe('');
    expect(normalizeStreamUrl(undefined)).toBe('');
  });

  test('normalizes relative stream URL', () => {
    const track = { id: 42, stream_url: '/api/stream/42' };
    expect(normalizeStreamUrl(track, defaultServer)).toBe(
      'https://web.puuk.fun/api/stream/42',
    );
  });

  test('preserves absolute stream URL', () => {
    const track = { id: 42, stream_url: 'https://other.server.com/audio.mp3' };
    expect(normalizeStreamUrl(track, defaultServer)).toBe(
      'https://other.server.com/audio.mp3',
    );
  });

  test('constructs URL if stream_url is missing', () => {
    const track = { id: 105 };
    expect(normalizeStreamUrl(track, defaultServer)).toBe(
      'https://web.puuk.fun/api/stream/105',
    );
  });

  test('handles track_id instead of id', () => {
    const track = { track_id: 'abc-xyz' };
    expect(normalizeStreamUrl(track, defaultServer)).toBe(
      'https://web.puuk.fun/api/stream/abc-xyz',
    );
  });

  test('falls back to valid track_id when id is blank or whitespace', () => {
    const track = { id: '   ', track_id: 'legacy-valid-123' };
    expect(normalizeStreamUrl(track, defaultServer)).toBe(
      'https://web.puuk.fun/api/stream/legacy-valid-123',
    );
  });

  test('returns empty string when id is blank and track_id is missing or blank', () => {
    expect(normalizeStreamUrl({ id: '   ' }, defaultServer)).toBe('');
    expect(normalizeStreamUrl({ id: '', track_id: '   ' }, defaultServer)).toBe(
      '',
    );
  });

  test('preserves numeric zero id in stream URL', () => {
    const track = { id: 0 };
    expect(normalizeStreamUrl(track, defaultServer)).toBe(
      'https://web.puuk.fun/api/stream/0',
    );
  });

  test('strips trailing slashes from serverUrl', () => {
    const track = { id: 1 };
    expect(normalizeStreamUrl(track, 'https://my.server.org///')).toBe(
      'https://my.server.org/api/stream/1',
    );
  });

  test('dynamically evaluates live SERVER_URL binding when serverUrl is omitted', () => {
    const { SERVER_URL, setServerUrl } = require('../../shared/api/api');
    const original = SERVER_URL;
    try {
      setServerUrl('https://cold-start-loaded.puuk.fun');
      const track = { id: 99 };
      expect(normalizeStreamUrl(track)).toBe(
        'https://cold-start-loaded.puuk.fun/api/stream/99',
      );

      // Relative path preserves custom server
      const relativeTrack = { id: 100, stream_url: '/api/stream/100' };
      expect(normalizeStreamUrl(relativeTrack)).toBe(
        'https://cold-start-loaded.puuk.fun/api/stream/100',
      );

      // Null or empty serverUrl argument falls back to live SERVER_URL
      expect(normalizeStreamUrl(track, null)).toBe(
        'https://cold-start-loaded.puuk.fun/api/stream/99',
      );
      expect(normalizeStreamUrl(track, '')).toBe(
        'https://cold-start-loaded.puuk.fun/api/stream/99',
      );
    } finally {
      setServerUrl(original);
    }
  });
});
