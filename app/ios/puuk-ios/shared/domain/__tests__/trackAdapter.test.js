import { getTrackId, areTrackIdsEqual, normalizeTrack } from '../trackAdapter';

describe('shared/domain/trackAdapter', () => {
  describe('getTrackId', () => {
    test('extracts string id from track.id', () => {
      expect(getTrackId({ id: 'uuid-123' })).toBe('uuid-123');
    });

    test('extracts legacy string from track.track_id', () => {
      expect(getTrackId({ track_id: 'legacy-456' })).toBe('legacy-456');
    });

    test('prefers track.id over track.track_id when both exist', () => {
      expect(getTrackId({ id: 'primary-id', track_id: 'secondary-id' })).toBe(
        'primary-id',
      );
    });

    test('falls back to track_id if id is null or undefined', () => {
      expect(getTrackId({ id: null, track_id: 'legacy-fallback' })).toBe(
        'legacy-fallback',
      );
      expect(getTrackId({ id: undefined, track_id: 'legacy-fallback' })).toBe(
        'legacy-fallback',
      );
    });

    test('falls back to valid legacy track_id when id is blank or whitespace string', () => {
      expect(getTrackId({ id: ' ', track_id: 'legacy-valid' })).toBe(
        'legacy-valid',
      );
      expect(getTrackId({ id: '', track_id: 'legacy-valid' })).toBe(
        'legacy-valid',
      );
      expect(getTrackId({ id: '   ', track_id: 'legacy-valid' })).toBe(
        'legacy-valid',
      );
      expect(getTrackId({ id: ' ', track_id: 0 })).toBe(0);
    });

    test('preserves valid numeric zero for track.id', () => {
      expect(getTrackId({ id: 0 })).toBe(0);
    });

    test('preserves valid numeric zero for track.track_id', () => {
      expect(getTrackId({ track_id: 0 })).toBe(0);
    });

    test('extracts direct string or numeric identifier when passed directly', () => {
      expect(getTrackId('direct-uuid')).toBe('direct-uuid');
      expect(getTrackId(42)).toBe(42);
      expect(getTrackId(0)).toBe(0);
    });

    test('returns null for missing, null, or undefined track', () => {
      expect(getTrackId(null)).toBeNull();
      expect(getTrackId(undefined)).toBeNull();
      expect(getTrackId({})).toBeNull();
      expect(getTrackId({ id: null })).toBeNull();
      expect(getTrackId({ id: undefined, track_id: null })).toBeNull();
    });

    test('returns null for empty or whitespace-only string identifiers', () => {
      expect(getTrackId({ id: '' })).toBeNull();
      expect(getTrackId({ id: '   ' })).toBeNull();
      expect(getTrackId({ track_id: '' })).toBeNull();
      expect(getTrackId('')).toBeNull();
      expect(getTrackId('   ')).toBeNull();
    });

    test('returns null for NaN and non-track primitives', () => {
      expect(getTrackId(NaN)).toBeNull();
      expect(getTrackId({ id: NaN })).toBeNull();
      expect(getTrackId(true)).toBeNull();
      expect(getTrackId(false)).toBeNull();
    });
  });

  describe('areTrackIdsEqual', () => {
    test('returns true for matching string IDs', () => {
      expect(areTrackIdsEqual({ id: 'abc-123' }, { id: 'abc-123' })).toBe(true);
    });

    test('returns true when comparing track.id to legacy track.track_id', () => {
      expect(areTrackIdsEqual({ id: 'xyz-999' }, { track_id: 'xyz-999' })).toBe(
        true,
      );
    });

    test('returns true when comparing track with blank id that falls back to track_id', () => {
      expect(
        areTrackIdsEqual({ id: ' ', track_id: 'match-1' }, { id: 'match-1' }),
      ).toBe(true);
    });

    test('returns true for numeric zero and string zero', () => {
      expect(areTrackIdsEqual({ id: 0 }, { id: 0 })).toBe(true);
      expect(areTrackIdsEqual({ id: 0 }, { id: '0' })).toBe(true);
      expect(areTrackIdsEqual({ track_id: 0 }, { id: 0 })).toBe(true);
      expect(areTrackIdsEqual(0, { id: '0' })).toBe(true);
    });

    test('returns false for different IDs', () => {
      expect(areTrackIdsEqual({ id: 'track-1' }, { id: 'track-2' })).toBe(
        false,
      );
      expect(areTrackIdsEqual({ id: 1 }, { id: 2 })).toBe(false);
    });

    test('returns false if either track or both tracks have null/missing IDs', () => {
      expect(areTrackIdsEqual(null, null)).toBe(false);
      expect(areTrackIdsEqual({}, {})).toBe(false);
      expect(areTrackIdsEqual({ id: null }, { id: null })).toBe(false);
      expect(areTrackIdsEqual({ id: '' }, { id: '' })).toBe(false);
      expect(areTrackIdsEqual({ id: 'track-1' }, null)).toBe(false);
      expect(areTrackIdsEqual(null, { id: 'track-1' })).toBe(false);
      expect(areTrackIdsEqual({ id: 'track-1' }, {})).toBe(false);
    });
  });

  describe('normalizeTrack', () => {
    test('normalizes standard track with string id', () => {
      const raw = { id: 'track-uuid-1', title: 'Song 1', artist: 'Artist 1' };
      const normalized = normalizeTrack(raw);
      expect(normalized).toEqual({
        id: 'track-uuid-1',
        track_id: 'track-uuid-1',
        title: 'Song 1',
        artist: 'Artist 1',
        coverArt: null,
      });
    });

    test('normalizes legacy track with track_id to canonical id and mirrors track_id', () => {
      const legacy = { track_id: 'legacy-uuid-2', title: 'Old Song' };
      const normalized = normalizeTrack(legacy);
      expect(normalized.id).toBe('legacy-uuid-2');
      expect(normalized.track_id).toBe('legacy-uuid-2');
      expect(normalized.title).toBe('Old Song');
      expect(normalized.artist).toBe('Unknown Artist');
    });

    test('normalizes track when id is blank whitespace by falling back to valid track_id', () => {
      const raw = {
        id: ' ',
        track_id: 'legacy-whitespace-fallback',
        title: 'Whitespace ID Track',
      };
      const normalized = normalizeTrack(raw);
      expect(normalized).not.toBeNull();
      expect(normalized.id).toBe('legacy-whitespace-fallback');
      expect(normalized.track_id).toBe('legacy-whitespace-fallback');
      expect(normalized.title).toBe('Whitespace ID Track');
    });

    test('preserves numeric zero id and mirrors to track_id', () => {
      const zeroTrack = { id: 0, title: 'Zero Track' };
      const normalized = normalizeTrack(zeroTrack);
      expect(normalized.id).toBe(0);
      expect(normalized.track_id).toBe(0);
    });

    test('preserves unknown and extra track fields (anti-stripping)', () => {
      const richTrack = {
        track_id: 'rich-1',
        title: 'Rich Track',
        artist: 'Rich Artist',
        album: 'Special Album',
        album_id: 10,
        year: 2024,
        genre: 'Electronic',
        track_number: '3/12',
        lyrics: '[00:01.00]Hello',
        bpm: 128,
        file_path: 'artist/album/rich.mp3',
        normalization_gain_db: -4.2,
        customProp: 'customValue',
      };
      const normalized = normalizeTrack(richTrack);
      expect(normalized.id).toBe('rich-1');
      expect(normalized.track_id).toBe('rich-1');
      expect(normalized.album).toBe('Special Album');
      expect(normalized.album_id).toBe(10);
      expect(normalized.year).toBe(2024);
      expect(normalized.genre).toBe('Electronic');
      expect(normalized.track_number).toBe('3/12');
      expect(normalized.lyrics).toBe('[00:01.00]Hello');
      expect(normalized.bpm).toBe(128);
      expect(normalized.file_path).toBe('artist/album/rich.mp3');
      expect(normalized.normalization_gain_db).toBe(-4.2);
      expect(normalized.customProp).toBe('customValue');
    });

    test('generates fallback coverArt when serverUrl is provided and coverArt is missing', () => {
      const track = { id: 'cover-track-1', title: 'Test' };
      const normalized = normalizeTrack(track, {
        serverUrl: 'https://web.puuk.fun',
      });
      expect(normalized.coverArt).toBe(
        'https://web.puuk.fun/api/cover/cover-track-1',
      );
    });

    test('generates fallback coverArt correctly for numeric zero id', () => {
      const track = { id: 0, title: 'Test Zero' };
      const normalized = normalizeTrack(track, {
        serverUrl: 'https://web.puuk.fun',
      });
      expect(normalized.coverArt).toBe('https://web.puuk.fun/api/cover/0');
    });

    test('preserves existing coverArt if present', () => {
      const track = {
        id: 'cover-track-2',
        coverArt: 'https://cdn.custom.com/art.jpg',
      };
      const normalized = normalizeTrack(track, {
        serverUrl: 'https://web.puuk.fun',
      });
      expect(normalized.coverArt).toBe('https://cdn.custom.com/art.jpg');
    });

    test('preserves supplied empty-string title, artist, and coverArt', () => {
      const track = {
        id: 'empty-meta-1',
        title: '',
        artist: '',
        coverArt: '',
      };
      const normalized = normalizeTrack(track, {
        serverUrl: 'https://web.puuk.fun',
      });
      expect(normalized.title).toBe('');
      expect(normalized.artist).toBe('');
      expect(normalized.coverArt).toBe('');
    });

    test('defaults title and artist only when absent (null or undefined)', () => {
      const nullMeta = {
        id: 'null-meta-1',
        title: null,
        artist: null,
        coverArt: null,
      };
      const normalizedNull = normalizeTrack(nullMeta, {
        serverUrl: 'https://web.puuk.fun',
      });
      expect(normalizedNull.title).toBe('Unknown Track');
      expect(normalizedNull.artist).toBe('Unknown Artist');
      expect(normalizedNull.coverArt).toBe(
        'https://web.puuk.fun/api/cover/null-meta-1',
      );

      const undefMeta = {
        id: 'undef-meta-1',
      };
      const normalizedUndef = normalizeTrack(undefMeta, {
        serverUrl: 'https://web.puuk.fun',
      });
      expect(normalizedUndef.title).toBe('Unknown Track');
      expect(normalizedUndef.artist).toBe('Unknown Artist');
      expect(normalizedUndef.coverArt).toBe(
        'https://web.puuk.fun/api/cover/undef-meta-1',
      );
    });

    test('returns null for missing, null, or invalid tracks', () => {
      expect(normalizeTrack(null)).toBeNull();
      expect(normalizeTrack(undefined)).toBeNull();
      expect(normalizeTrack({})).toBeNull();
      expect(normalizeTrack({ id: '' })).toBeNull();
      expect(normalizeTrack({ id: '   ' })).toBeNull();
      expect(normalizeTrack({ id: null, track_id: null })).toBeNull();
      expect(normalizeTrack('not-an-object')).toBeNull();
    });
  });
});
