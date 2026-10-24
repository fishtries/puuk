import * as SecureStore from 'expo-secure-store';
import {
  getSavedLastTrack,
  setSavedLastTrack,
  clearSavedLastTrack,
} from '../settings';

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

describe('shared/storage/settings - persisted last track (Stage 8 Slice 1)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockStore.clear();
    await clearSavedLastTrack();
    jest.clearAllMocks();
  });

  describe('canonical identity (id)', () => {
    test('saves track with standard string id and retrieves normalized record', async () => {
      const track = { id: 'uuid-101', title: 'Song 101', artist: 'Artist A' };
      const result = await setSavedLastTrack(track);

      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
      expect(result.id).toBe('uuid-101');
      expect(result.track_id).toBe('uuid-101');

      const retrieved = await getSavedLastTrack();
      expect(retrieved.id).toBe('uuid-101');
      expect(retrieved.track_id).toBe('uuid-101');
      expect(retrieved.title).toBe('Song 101');
    });

    test('prefers canonical id over track_id when both exist on write', async () => {
      const track = {
        id: 'canonical-primary',
        track_id: 'legacy-secondary',
        title: 'Dual ID Song',
      };
      const result = await setSavedLastTrack(track);

      expect(result.id).toBe('canonical-primary');
      expect(result.track_id).toBe('canonical-primary');

      const retrieved = await getSavedLastTrack();
      expect(retrieved.id).toBe('canonical-primary');
      expect(retrieved.track_id).toBe('canonical-primary');
    });

    test('prefers canonical id over track_id when reading stored record from disk', async () => {
      mockStore.set(
        'puuk_last_track_v1',
        JSON.stringify({
          id: 'stored-canonical',
          track_id: 'stored-legacy',
          title: 'Stored Dual ID',
        }),
      );

      const retrieved = await getSavedLastTrack();
      expect(retrieved.id).toBe('stored-canonical');
      expect(retrieved.track_id).toBe('stored-canonical');
    });
  });

  describe('legacy track_id compatibility', () => {
    test('saves legacy track with track_id and normalizes canonical id', async () => {
      const legacyTrack = {
        track_id: 'legacy-007',
        title: 'Legacy Spy',
        album: 'GoldenEye',
        year: 1995,
        genre: 'Soundtrack',
      };
      const saved = await setSavedLastTrack(legacyTrack);

      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
      expect(saved.id).toBe('legacy-007');
      expect(saved.track_id).toBe('legacy-007');
      expect(saved.album).toBe('GoldenEye');
      expect(saved.year).toBe(1995);

      const retrieved = await getSavedLastTrack();
      expect(retrieved.id).toBe('legacy-007');
      expect(retrieved.track_id).toBe('legacy-007');
      expect(retrieved.album).toBe('GoldenEye');
      expect(retrieved.year).toBe(1995);
    });

    test('falls back to track_id when id is null or undefined on write', async () => {
      const fallbackNull = await setSavedLastTrack({
        id: null,
        track_id: 'fallback-null',
        title: 'Null ID Fallback',
      });
      expect(fallbackNull.id).toBe('fallback-null');
      expect(fallbackNull.track_id).toBe('fallback-null');

      const fallbackUndef = await setSavedLastTrack({
        id: undefined,
        track_id: 'fallback-undef',
        title: 'Undefined ID Fallback',
      });
      expect(fallbackUndef.id).toBe('fallback-undef');
      expect(fallbackUndef.track_id).toBe('fallback-undef');
    });

    test('normalizes stored legacy record on read from disk without id', async () => {
      const legacyDiskData = {
        track_id: 'old-stored-uuid',
        title: 'Old Track On Disk',
        artist: 'Ancient Band',
        album: 'Classic Vinyl',
        customMeta: { note: 'preserved' },
      };
      mockStore.set('puuk_last_track_v1', JSON.stringify(legacyDiskData));

      const retrieved = await getSavedLastTrack();
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe('old-stored-uuid');
      expect(retrieved.track_id).toBe('old-stored-uuid');
      expect(retrieved.title).toBe('Old Track On Disk');
      expect(retrieved.album).toBe('Classic Vinyl');
      expect(retrieved.customMeta).toEqual({ note: 'preserved' });
    });
  });

  describe('numeric zero preservation', () => {
    test('accepts and preserves numeric zero id without deleting from storage', async () => {
      const zeroTrack = { id: 0, title: 'Zero Track', artist: 'Zero Artist' };
      const saved = await setSavedLastTrack(zeroTrack);

      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
      expect(saved.id).toBe(0);
      expect(saved.track_id).toBe(0);

      // Verify stored JSON directly in mock store
      const storedRaw = mockStore.get('puuk_last_track_v1');
      expect(storedRaw).toBeDefined();
      const parsedStored = JSON.parse(storedRaw);
      expect(parsedStored.id).toBe(0);
      expect(parsedStored.track_id).toBe(0);

      // Verify retrieval
      const retrieved = await getSavedLastTrack();
      expect(retrieved.id).toBe(0);
      expect(retrieved.track_id).toBe(0);
      expect(retrieved.title).toBe('Zero Track');
    });

    test('accepts and preserves numeric zero legacy track_id', async () => {
      const zeroLegacy = { track_id: 0, title: 'Zero Legacy' };
      const saved = await setSavedLastTrack(zeroLegacy);

      expect(saved.id).toBe(0);
      expect(saved.track_id).toBe(0);

      const retrieved = await getSavedLastTrack();
      expect(retrieved.id).toBe(0);
      expect(retrieved.track_id).toBe(0);
    });

    test('canonical id 0 wins over non-zero track_id', async () => {
      const zeroWins = { id: 0, track_id: 'other-id', title: 'Zero Wins' };
      const saved = await setSavedLastTrack(zeroWins);

      expect(saved.id).toBe(0);
      expect(saved.track_id).toBe(0);
    });

    test('track_id 0 is used when id is null or undefined', async () => {
      const zeroFallbackNull = await setSavedLastTrack({
        id: null,
        track_id: 0,
        title: 'Zero Fallback',
      });
      expect(zeroFallbackNull.id).toBe(0);
      expect(zeroFallbackNull.track_id).toBe(0);

      const zeroFallbackUndef = await setSavedLastTrack({
        id: undefined,
        track_id: 0,
        title: 'Zero Fallback 2',
      });
      expect(zeroFallbackUndef.id).toBe(0);
      expect(zeroFallbackUndef.track_id).toBe(0);
    });
  });

  describe('missing or invalid identifier', () => {
    test('clears storage and returns null when setSavedLastTrack called with null or invalid track', async () => {
      await setSavedLastTrack({ id: 'valid-1', title: 'Valid' });
      expect(mockStore.has('puuk_last_track_v1')).toBe(true);

      const resultNull = await setSavedLastTrack(null);
      expect(resultNull).toBeNull();
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
        'puuk_last_track_v1',
        expect.any(Object),
      );
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);

      await setSavedLastTrack({ id: 'valid-2', title: 'Valid 2' });
      expect(mockStore.has('puuk_last_track_v1')).toBe(true);

      const resultEmpty = await setSavedLastTrack({});
      expect(resultEmpty).toBeNull();
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);

      await setSavedLastTrack({ id: 'valid-3', title: 'Valid 3' });
      const resultBlank = await setSavedLastTrack({ id: '   ' });
      expect(resultBlank).toBeNull();
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);

      await setSavedLastTrack({ id: 'valid-4', title: 'Valid 4' });
      const resultBlankTrackId = await setSavedLastTrack({ track_id: '' });
      expect(resultBlankTrackId).toBeNull();
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);

      await setSavedLastTrack({ id: 'valid-5', title: 'Valid 5' });
      const resultNaN = await setSavedLastTrack({ id: NaN });
      expect(resultNaN).toBeNull();
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);

      await setSavedLastTrack({ id: 'valid-6', title: 'Valid 6' });
      const resultNaNTrackId = await setSavedLastTrack({ track_id: NaN });
      expect(resultNaNTrackId).toBeNull();
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);
    });

    test('clears corrupt stored record on read if identifier is missing, blank, or NaN', async () => {
      // Missing identifier
      mockStore.set(
        'puuk_last_track_v1',
        JSON.stringify({ title: 'No ID Track' }),
      );
      const retrievedMissing = await getSavedLastTrack();
      expect(retrievedMissing).toBeNull();
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
        'puuk_last_track_v1',
        expect.any(Object),
      );
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);

      // Blank identifier
      mockStore.set('puuk_last_track_v1', JSON.stringify({ id: '   ' }));
      const retrievedBlank = await getSavedLastTrack();
      expect(retrievedBlank).toBeNull();
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);

      // NaN identifier (stored as null in JSON)
      mockStore.set('puuk_last_track_v1', JSON.stringify({ id: null }));
      const retrievedNullId = await getSavedLastTrack();
      expect(retrievedNullId).toBeNull();
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);
    });

    test('clears corrupt storage on read if stored JSON is malformed', async () => {
      mockStore.set('puuk_last_track_v1', 'corrupted-json-content{[');

      const retrieved = await getSavedLastTrack();
      expect(retrieved).toBeNull();
      expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
        'puuk_last_track_v1',
        expect.any(Object),
      );
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);
    });
  });

  describe('legacy read/write compatibility & unknown fields preservation', () => {
    test('preserves unknown and extra fields on write (anti-stripping)', async () => {
      const richTrack = {
        id: 'rich-1',
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
      const saved = await setSavedLastTrack(richTrack);

      expect(saved.id).toBe('rich-1');
      expect(saved.track_id).toBe('rich-1');
      expect(saved.album).toBe('Special Album');
      expect(saved.album_id).toBe(10);
      expect(saved.year).toBe(2024);
      expect(saved.genre).toBe('Electronic');
      expect(saved.track_number).toBe('3/12');
      expect(saved.lyrics).toBe('[00:01.00]Hello');
      expect(saved.bpm).toBe(128);
      expect(saved.file_path).toBe('artist/album/rich.mp3');
      expect(saved.normalization_gain_db).toBe(-4.2);
      expect(saved.customProp).toBe('customValue');
    });

    test('preserves unknown and extra fields on read from legacy disk storage', async () => {
      const storedRichLegacy = {
        track_id: 'rich-legacy-1',
        title: 'Legacy Disk Song',
        artist: 'Legacy Disk Artist',
        album: 'Vintage Vinyl',
        year: 1988,
        bpm: 120,
        lyrics: 'Plain lyrics without lrc',
        normalization_gain_db: -1.5,
        customExtra: 'retained',
      };
      mockStore.set('puuk_last_track_v1', JSON.stringify(storedRichLegacy));

      const retrieved = await getSavedLastTrack();
      expect(retrieved.id).toBe('rich-legacy-1');
      expect(retrieved.track_id).toBe('rich-legacy-1');
      expect(retrieved.title).toBe('Legacy Disk Song');
      expect(retrieved.artist).toBe('Legacy Disk Artist');
      expect(retrieved.album).toBe('Vintage Vinyl');
      expect(retrieved.year).toBe(1988);
      expect(retrieved.bpm).toBe(120);
      expect(retrieved.lyrics).toBe('Plain lyrics without lrc');
      expect(retrieved.normalization_gain_db).toBe(-1.5);
      expect(retrieved.customExtra).toBe('retained');
    });

    test('generates fallback coverArt when serverUrl is present and coverArt is missing', async () => {
      const track = { id: 'cover-track-1', title: 'Test Fallback Cover' };
      const saved = await setSavedLastTrack(track);

      expect(saved.coverArt).toMatch(/\/api\/cover\/cover-track-1$/);
    });

    test('preserves existing coverArt if already provided', async () => {
      const track = {
        id: 'cover-track-2',
        title: 'Test Existing Cover',
        coverArt: 'https://cdn.custom.com/art.png',
      };
      const saved = await setSavedLastTrack(track);

      expect(saved.coverArt).toBe('https://cdn.custom.com/art.png');
    });
  });

  describe('storage lifecycle', () => {
    test('explicit clearSavedLastTrack deletes from store and resets memory cache', async () => {
      await setSavedLastTrack({ id: 'persisted-1', title: 'Test' });
      expect(await getSavedLastTrack()).not.toBeNull();

      await clearSavedLastTrack();
      expect(mockStore.has('puuk_last_track_v1')).toBe(false);
      expect(await getSavedLastTrack()).toBeNull();
    });

    test('memory cache returns cached object without re-querying SecureStore', async () => {
      await setSavedLastTrack({ id: 'cached-id-1', title: 'Cache Test' });
      SecureStore.getItemAsync.mockClear();

      const cached = await getSavedLastTrack();
      expect(cached.id).toBe('cached-id-1');
      expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    });
  });
});
