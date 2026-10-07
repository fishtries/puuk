import { normalizeStreamUrl } from '../streamUrl';

describe('normalizeStreamUrl', () => {
  const defaultServer = 'https://web.puuk.fun';

  test('returns empty string if track is null or undefined', () => {
    expect(normalizeStreamUrl(null)).toBe('');
    expect(normalizeStreamUrl(undefined)).toBe('');
  });

  test('normalizes relative stream URL', () => {
    const track = { id: 42, stream_url: '/api/stream/42' };
    expect(normalizeStreamUrl(track, defaultServer)).toBe('https://web.puuk.fun/api/stream/42');
  });

  test('preserves absolute stream URL', () => {
    const track = { id: 42, stream_url: 'https://other.server.com/audio.mp3' };
    expect(normalizeStreamUrl(track, defaultServer)).toBe('https://other.server.com/audio.mp3');
  });

  test('constructs URL if stream_url is missing', () => {
    const track = { id: 105 };
    expect(normalizeStreamUrl(track, defaultServer)).toBe('https://web.puuk.fun/api/stream/105');
  });

  test('handles track_id instead of id', () => {
    const track = { track_id: 'abc-xyz' };
    expect(normalizeStreamUrl(track, defaultServer)).toBe('https://web.puuk.fun/api/stream/abc-xyz');
  });

  test('strips trailing slashes from serverUrl', () => {
    const track = { id: 1 };
    expect(normalizeStreamUrl(track, 'https://my.server.org///')).toBe('https://my.server.org/api/stream/1');
  });
});
