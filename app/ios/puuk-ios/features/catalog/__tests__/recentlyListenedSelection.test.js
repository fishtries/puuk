import {
  selectRecentlyListened,
  getPrimaryArtistKey,
  getAlbumKey,
  getGenreKey,
  DEFAULT_RECENTLY_LISTENED_LIMIT,
  ARTIST_SCORE_WEIGHT,
  ALBUM_SCORE_WEIGHT,
  GENRE_SCORE_WEIGHT,
} from '../recentlyListenedSelection';

describe('recentlyListenedSelection', () => {
  describe('key extraction helpers', () => {
    test('getPrimaryArtistKey uses first credit id, name fallback, or artist field', () => {
      expect(
        getPrimaryArtistKey({
          artists: [{ id: 'art-1', name: 'Art 1' }, { id: 'art-2', name: 'Art 2' }],
          artist: 'Legacy Name',
        }),
      ).toBe('artist_id_art-1');

      // Credit without ID uses name
      expect(
        getPrimaryArtistKey({
          artists: [{ name: 'Solo Singer' }],
        }),
      ).toBe('artist_name_solo singer');

      // No credits fallback to artist field
      expect(
        getPrimaryArtistKey({
          artist: 'The Band',
        }),
      ).toBe('artist_name_the band');

      // Placeholders return null
      expect(getPrimaryArtistKey({ artist: 'Unknown Artist' })).toBeNull();
      expect(getPrimaryArtistKey({ artist: 'unknown' })).toBeNull();
      expect(getPrimaryArtistKey({ artist: '' })).toBeNull();
      expect(getPrimaryArtistKey(null)).toBeNull();
    });

    test('getAlbumKey distinguishes same album title from different artists', () => {
      const track1 = {
        album: 'Greatest Hits',
        artist: 'Artist A',
      };
      const track2 = {
        album: 'Greatest Hits',
        artist: 'Artist B',
      };
      const key1 = getAlbumKey(track1, getPrimaryArtistKey(track1));
      const key2 = getAlbumKey(track2, getPrimaryArtistKey(track2));

      expect(key1).not.toBeNull();
      expect(key2).not.toBeNull();
      expect(key1).not.toBe(key2);

      // Uses album_id if available
      expect(
        getAlbumKey({ album_id: 'alb-99', album: 'Ignored' }, 'artist_1'),
      ).toBe('album_id_alb-99');

      // Unknown album returns null
      expect(getAlbumKey({ album: 'Unknown Album' }, 'artist_1')).toBeNull();
      expect(getAlbumKey({ album: 'Greatest Hits' }, null)).toBeNull();
    });

    test('getGenreKey extracts valid normalized genre and ignores placeholders', () => {
      expect(getGenreKey({ genre: 'Electronic' })).toBe('genre_electronic');
      expect(getGenreKey({ genre: '  Rock  ' })).toBe('genre_rock');
      expect(getGenreKey({ genre: 'Unknown Genre' })).toBeNull();
      expect(getGenreKey({ genre: 'none' })).toBeNull();
      expect(getGenreKey({})).toBeNull();
    });
  });

  describe('selectRecentlyListened algorithm', () => {
    test('handles empty input, single track, short list, and limit = 0', () => {
      expect(selectRecentlyListened([])).toEqual([]);
      expect(selectRecentlyListened(null)).toEqual([]);
      expect(selectRecentlyListened(undefined)).toEqual([]);

      const single = [{ id: 1, title: 'Solo' }];
      expect(selectRecentlyListened(single)).toEqual(single);

      const two = [
        { id: 1, title: 'One' },
        { id: 2, title: 'Two' },
      ];
      expect(selectRecentlyListened(two)).toEqual(two);

      expect(selectRecentlyListened(two, 0)).toEqual([]);
    });

    test('preserves immutability of input tracks', () => {
      const input = [
        Object.freeze({ id: 't1', title: 'Song 1', artist: 'Artist 1' }),
        Object.freeze({ id: 't2', title: 'Song 2', artist: 'Artist 2' }),
      ];
      const frozenInput = Object.freeze([...input]);

      const result = selectRecentlyListened(frozenInput);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('t1');
      expect(result[1].id).toBe('t2');
    });

    test('filters invalid IDs, handles numeric 0, and deduplicates preserving first occurrence', () => {
      const input = [
        { id: null, title: 'Invalid null' },
        { id: undefined, title: 'Invalid undefined' },
        { id: '', title: 'Invalid empty string' },
        { id: '   ', title: 'Invalid whitespace' },
        { id: NaN, title: 'Invalid NaN' },
        { id: 0, title: 'Valid zero' }, // 0 is a valid ID
        { id: '100', title: 'First 100' },
        { id: 100, title: 'Duplicate numeric 100' },
        { id: '100', title: 'Duplicate string 100' },
        { id: '200', title: 'Track 200' },
      ];

      const result = selectRecentlyListened(input);
      expect(result).toHaveLength(3);
      expect(result.map((t) => t.title)).toEqual([
        'Valid zero',
        'First 100',
        'Track 200',
      ]);
    });

    test('the most recent valid track is always first in the result', () => {
      const tracks = [
        { id: 'first', artist: 'Artist A', album: 'Album A', genre: 'Rock' },
        { id: 'second', artist: 'Artist B', album: 'Album B', genre: 'Pop' },
        { id: 'third', artist: 'Artist C', album: 'Album C', genre: 'Jazz' },
      ];

      const result = selectRecentlyListened(tracks);
      expect(result[0].id).toBe('first');
    });

    test('alternates artists and enforces cap of 2 tracks per artist before exhausting alternatives', () => {
      // 5 tracks from Artist A, 2 tracks from Artist B, 2 tracks from Artist C
      const tracks = [
        { id: 'a1', artist: 'Artist A', title: 'A1' },
        { id: 'a2', artist: 'Artist A', title: 'A2' },
        { id: 'a3', artist: 'Artist A', title: 'A3' },
        { id: 'a4', artist: 'Artist A', title: 'A4' },
        { id: 'b1', artist: 'Artist B', title: 'B1' },
        { id: 'c1', artist: 'Artist C', title: 'C1' },
        { id: 'b2', artist: 'Artist B', title: 'B2' },
        { id: 'c2', artist: 'Artist C', title: 'C2' },
        { id: 'a5', artist: 'Artist A', title: 'A5' },
      ];

      const result = selectRecentlyListened(tracks, 6);
      expect(result).toHaveLength(6);

      // Result index 0: 'a1' (first valid)
      expect(result[0].id).toBe('a1');

      // Next cannot be Artist A immediately if other artists available:
      expect(result[1].artist).not.toBe('Artist A');

      // Check that Artist A appears at most 2 times in the first 6 (since B and C have 4 tracks total)
      const countA = result.filter((t) => t.artist === 'Artist A').length;
      expect(countA).toBe(2);
    });

    test('monolithic history of a single artist or album fills without infinite loop or hanging', () => {
      const singleArtistTracks = Array.from({ length: 15 }, (_, i) => ({
        id: `song-${i}`,
        artist: 'The Only Artist',
        album: 'The Only Album',
        genre: 'Rock',
      }));

      const result = selectRecentlyListened(singleArtistTracks, 10);
      expect(result).toHaveLength(10);
      // All unique
      const ids = new Set(result.map((t) => t.id));
      expect(ids.size).toBe(10);
    });

    test('missing metadata does not group into unknown or block diversity', () => {
      const tracks = [
        { id: 't1', title: 'T1', artist: 'Unknown Artist', album: null },
        { id: 't2', title: 'T2', artist: 'Unknown Artist', album: null },
        { id: 't3', title: 'T3', artist: 'Artist X', album: 'Album X' },
      ];

      const result = selectRecentlyListened(tracks);
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('t1');
    });

    test('deterministic scoring with calculated fixture', () => {
      // Setup known candidates to test precise formula:
      // rank + 12 * artistCount + 6 * albumCount + 3 * genreCount
      const fixtureTracks = [
        // rank 0: picked first
        { id: 1, artist: 'Art1', album_id: 'Alb1', genre: 'Rock' },
        // rank 1: same artist Art1 (diff artist rule prefers Art2 or Art3)
        { id: 2, artist: 'Art1', album_id: 'Alb1', genre: 'Rock' },
        // rank 2: diff artist Art2, Alb2, Rock (genreCount=1) -> score = 2 + 0 + 0 + 3*1 = 5
        { id: 3, artist: 'Art2', album_id: 'Alb2', genre: 'Rock' },
        // rank 3: diff artist Art3, Alb3, Pop (genreCount=0) -> score = 3 + 0 + 0 + 0 = 3
        { id: 4, artist: 'Art3', album_id: 'Alb3', genre: 'Pop' },
      ];

      // Step 0: Track 1 is picked. Result: [Track 1].
      // Counts: Art1: 1, Alb1: 1, Rock: 1.
      // Next pick (slot 1):
      // prev: Art1, Alb1.
      // diff artist from Art1: Track 3 (Art2), Track 4 (Art3).
      // Scores:
      // Track 3: rank=2, Art2=0, Alb2=0, Rock=1 -> 2 + 0 + 0 + 3*1 = 5
      // Track 4: rank=3, Art3=0, Alb3=0, Pop=0 -> 3 + 0 + 0 + 0 = 3
      // Track 4 has lower score (3 < 5), so Track 4 must be chosen!

      const result = selectRecentlyListened(fixtureTracks);
      expect(result[0].id).toBe(1);
      expect(result[1].id).toBe(4); // Track 4 beats Track 3 due to genre diversity
      expect(result[2].id).toBe(3); // Track 3 next
      expect(result[3].id).toBe(2); // Track 2 last
    });

    test('caps at limit when input has more than 20 tracks', () => {
      const tracks = Array.from({ length: 50 }, (_, i) => ({
        id: `tr-${i}`,
        artist: `Artist ${i % 10}`,
        album: `Album ${i % 15}`,
      }));

      const result = selectRecentlyListened(tracks, 20);
      expect(result).toHaveLength(20);
    });
  });
});
