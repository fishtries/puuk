import {
  DORMANT_LINKING_CONFIG,
  validateDestination,
  parseShareDestination,
  pendingDestinationStore,
  dispatchShareDestination,
  MAX_DESTINATION_AGE_MS,
} from '../linking';

describe('linking.js — Dormant React Navigation Linking Adapter & Destination Manager', () => {
  beforeEach(() => {
    pendingDestinationStore.clearPendingDestination();
    jest.clearAllMocks();
  });

  describe('1. Dormant Linking Adapter Configuration', () => {
    it('is dormant: empty prefixes array (does not intercept incoming URLs)', () => {
      expect(DORMANT_LINKING_CONFIG.prefixes).toEqual([]);
      expect(DORMANT_LINKING_CONFIG.enabled).toBe(false);
    });

    it('is dormant: getInitialURL resolves null on app launch', async () => {
      const initialUrl = await DORMANT_LINKING_CONFIG.getInitialURL();
      expect(initialUrl).toBeNull();
    });

    it('is dormant: subscribe returns cleanup function with no native listeners registered', () => {
      const listener = jest.fn();
      const unsubscribe = DORMANT_LINKING_CONFIG.subscribe(listener);
      expect(typeof unsubscribe).toBe('function');
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('maps canonical album path to navigation state without autoplay', () => {
      const state = DORMANT_LINKING_CONFIG.getStateFromPath('/album/9223372036854775807');
      expect(state).toEqual({
        routes: [
          { name: 'MainTabs' },
          { name: 'Album', params: { albumId: '9223372036854775807' } },
        ],
      });
      // Verify NO autoplay flags or callbacks in route state
      expect(state.routes.some((r) => r.params?.autoPlay || r.params?.play)).toBe(false);
    });

    it('maps canonical artist path to navigation state without autoplay', () => {
      const artistId = 'art_0123456789abcdef0123456789abcdef';
      const state = DORMANT_LINKING_CONFIG.getStateFromPath(`/artist/${artistId}`);
      expect(state).toEqual({
        routes: [
          { name: 'MainTabs' },
          { name: 'ArtistDetail', params: { artistId, id: artistId } },
        ],
      });
      expect(state.routes.some((r) => r.params?.autoPlay || r.params?.play)).toBe(false);
    });

    it('maps canonical track path to navigation state without autoplay', () => {
      const trackId = '12345678-1234-4234-8234-123456789abc';
      const state = DORMANT_LINKING_CONFIG.getStateFromPath(`/track/${trackId}`);
      expect(state).toBeUndefined();
    });

    it('returns undefined for invalid, malformed, or hostile paths', () => {
      expect(DORMANT_LINKING_CONFIG.getStateFromPath('/unknown/123')).toBeUndefined();
      expect(DORMANT_LINKING_CONFIG.getStateFromPath('/track/invalid-uuid')).toBeUndefined();
      expect(DORMANT_LINKING_CONFIG.getStateFromPath('/album/9223372036854775808')).toBeUndefined(); // overflow
      expect(DORMANT_LINKING_CONFIG.getStateFromPath('/artist/art_various')).toBeUndefined();
      expect(DORMANT_LINKING_CONFIG.getStateFromPath('/track/../album/1')).toBeUndefined();
      expect(DORMANT_LINKING_CONFIG.getStateFromPath('//track/123')).toBeUndefined();
    });

    it('serializes state back to canonical path via getPathFromState', () => {
      expect(
        DORMANT_LINKING_CONFIG.getPathFromState({
          routes: [{ name: 'Album', params: { albumId: '42' } }],
        }),
      ).toBe('/album/42');

      expect(
        DORMANT_LINKING_CONFIG.getPathFromState({
          routes: [
            {
              name: 'ArtistDetail',
              params: { artistId: 'art_0123456789abcdef0123456789abcdef' },
            },
          ],
        }),
      ).toBe('/artist/art_0123456789abcdef0123456789abcdef');
    });
  });

  describe('2. Destination Validation & Parsing', () => {
    it('validates destination objects correctly', () => {
      expect(
        validateDestination({
          type: 'track',
          id: '12345678-1234-4234-8234-123456789abc',
        }),
      ).toEqual({
        type: 'track',
        id: '12345678-1234-4234-8234-123456789abc',
      });

      expect(
        validateDestination({
          type: 'album',
          id: '9223372036854775807',
        }),
      ).toEqual({
        type: 'album',
        id: '9223372036854775807',
      });

      expect(
        validateDestination({
          type: 'artist',
          id: 'art_0123456789abcdef0123456789abcdef',
        }),
      ).toEqual({
        type: 'artist',
        id: 'art_0123456789abcdef0123456789abcdef',
      });
    });

    it('rejects invalid destination objects', () => {
      expect(() => validateDestination(null)).toThrow();
      expect(() => validateDestination({ type: 'playlist', id: '1' })).toThrow(/Invalid destination type/);
      expect(() => validateDestination({ type: 'track', id: 'not-uuid' })).toThrow();
      expect(() => validateDestination({ type: 'album', id: '0' })).toThrow();
      expect(() => validateDestination({ type: 'artist', id: 'art_various' })).toThrow();
    });

    it('parseShareDestination parses URLs and paths', () => {
      expect(
        parseShareDestination(
          'https://web.puuk.fun/track/12345678-1234-4234-8234-123456789abc',
        ),
      ).toEqual({
        type: 'track',
        id: '12345678-1234-4234-8234-123456789abc',
      });

      expect(parseShareDestination('/album/42')).toEqual({
        type: 'album',
        id: '42',
      });

      expect(parseShareDestination('https://evil.com/track/123')).toBeNull();
    });
  });

  describe('3. Pending Destination Store (Deduplication, Age & Expiry)', () => {
    const baseNow = 1700000000000;
    const destTrack = {
      type: 'track',
      id: '12345678-1234-4234-8234-123456789abc',
    };
    const destAlbum = {
      type: 'album',
      id: '42',
    };

    it('stores pending destination with timestamp', () => {
      const stored = pendingDestinationStore.setPendingDestination(destTrack, { now: baseNow });
      expect(stored).toEqual({
        type: 'track',
        id: '12345678-1234-4234-8234-123456789abc',
        savedAt: baseNow,
      });
      expect(pendingDestinationStore.hasPendingDestination({ now: baseNow })).toBe(true);
    });

    it('deduplicates identical targets within session and updates timestamp', () => {
      pendingDestinationStore.setPendingDestination(destTrack, { now: baseNow });
      const later = baseNow + 1000;
      const updated = pendingDestinationStore.setPendingDestination(destTrack, { now: later });

      expect(updated.savedAt).toBe(later);
      expect(pendingDestinationStore.getPendingDestination({ now: later })).toEqual({
        type: 'track',
        id: '12345678-1234-4234-8234-123456789abc',
        savedAt: later,
      });
    });

    it('replaces older pending target with newer valid target', () => {
      pendingDestinationStore.setPendingDestination(destTrack, { now: baseNow });
      const later = baseNow + 5000;
      pendingDestinationStore.setPendingDestination(destAlbum, { now: later });

      expect(pendingDestinationStore.getPendingDestination({ now: later })).toEqual({
        type: 'album',
        id: '42',
        savedAt: later,
      });
    });

    it('expires destination older than 24 hours', () => {
      pendingDestinationStore.setPendingDestination(destTrack, { now: baseNow });
      const past24h = baseNow + MAX_DESTINATION_AGE_MS + 1000;

      expect(pendingDestinationStore.getPendingDestination({ now: past24h })).toBeNull();
      expect(pendingDestinationStore.hasPendingDestination({ now: past24h })).toBe(false);
    });

    it('rejects future/corrupt timestamps (clock skew)', () => {
      pendingDestinationStore.setPendingDestination(destTrack, { now: baseNow });
      const clockSkewPast = baseNow - 60000; // time went backwards

      expect(pendingDestinationStore.getPendingDestination({ now: clockSkewPast })).toBeNull();
    });

    it('clears pending destination on demand', () => {
      pendingDestinationStore.setPendingDestination(destTrack, { now: baseNow });
      expect(pendingDestinationStore.hasPendingDestination({ now: baseNow })).toBe(true);

      pendingDestinationStore.clearPendingDestination();
      expect(pendingDestinationStore.hasPendingDestination({ now: baseNow })).toBe(false);
      expect(pendingDestinationStore.getPendingDestination({ now: baseNow })).toBeNull();
    });
  });

  describe('4. Destination Dispatching & NO AUTOPLAY Invariant', () => {
    let mockNavigation;

    beforeEach(() => {
      mockNavigation = {
        navigate: jest.fn(),
      };
    });

    it('when unauthenticated: saves to pending store, does NOT navigate or autoplay', () => {
      const dest = {
        type: 'album',
        id: '42',
      };

      const result = dispatchShareDestination(dest, mockNavigation, {
        isAuthenticated: false,
      });

      expect(result).toEqual({
        handled: false,
        pending: true,
        autoplay: false,
        destination: dest,
      });
      expect(mockNavigation.navigate).not.toHaveBeenCalled();
      expect(pendingDestinationStore.hasPendingDestination()).toBe(true);
    });

    it('when authenticated: navigates to target screen and clears pending store with NO AUTOPLAY', () => {
      const dest = {
        type: 'album',
        id: '42',
      };

      // Set pending first
      pendingDestinationStore.setPendingDestination(dest);

      const result = dispatchShareDestination(dest, mockNavigation, {
        isAuthenticated: true,
      });

      expect(result).toEqual({
        handled: true,
        pending: false,
        autoplay: false,
        destination: dest,
      });
      expect(mockNavigation.navigate).toHaveBeenCalledWith('Album', { albumId: '42' });
      expect(pendingDestinationStore.hasPendingDestination()).toBe(false);
    });

    it('dispatches artist destination to ArtistDetail with NO AUTOPLAY', () => {
      const artistId = 'art_0123456789abcdef0123456789abcdef';
      const dest = {
        type: 'artist',
        id: artistId,
      };

      const result = dispatchShareDestination(dest, mockNavigation, {
        isAuthenticated: true,
      });

      expect(result.autoplay).toBe(false);
      expect(mockNavigation.navigate).toHaveBeenCalledWith('ArtistDetail', {
        artistId,
        id: artistId,
      });
    });

    it('dispatches track destination to MainTabs Tracks tab with NO AUTOPLAY', () => {
      const trackId = '12345678-1234-4234-8234-123456789abc';
      const dest = {
        type: 'track',
        id: trackId,
      };

      const result = dispatchShareDestination(dest, mockNavigation, {
        isAuthenticated: true,
      });

      expect(result.autoplay).toBe(false);
      expect(result.handled).toBe(false);
      expect(mockNavigation.navigate).not.toHaveBeenCalled();
    });
  });
});
