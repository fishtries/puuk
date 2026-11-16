/**
 * linking.js — Dormant React Navigation linking adapter and share destination manager.
 * Contract v1 (§7.1, §8) / J5 isolated module.
 *
 * Rules:
 * - DORMANT: does NOT enable incoming HTTPS or native custom-scheme listeners.
 * - Universal Links are a separate follow-up; web links must open working web auth/destination.
 * - Incoming links NEVER auto-play, replace queue, change current track, or count a listen.
 * - Preserves pending destination data ({ type, id, savedAt }) with 24-hour expiration.
 * - Deduplicates destinations and replaces older pending targets.
 * - Clears pending destination on successful dispatch, explicit cancel, expiry, or navigation away.
 */

import { parseShareUrl, formatShareUrl, validateTrackId, validateAlbumId, validateArtistId } from '../utils/shareLinks';

export const MAX_DESTINATION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Validates destination object structure { type, id }.
 */
export function validateDestination(destination) {
  if (!destination || typeof destination !== 'object') {
    throw new Error('Destination must be a non-null object.');
  }

  const { type, id } = destination;
  if (!['track', 'album', 'artist'].includes(type)) {
    throw new Error(`Invalid destination type: "${type}". Must be "track", "album", or "artist".`);
  }

  let validatedId;
  switch (type) {
    case 'track':
      validatedId = validateTrackId(id);
      break;
    case 'album':
      validatedId = validateAlbumId(id);
      break;
    case 'artist':
      validatedId = validateArtistId(id);
      break;
    default:
      throw new Error(`Unsupported destination type: ${type}`);
  }

  return { type, id: validatedId };
}

/**
 * Parses incoming share URL or path into a destination object { type, id }.
 * Returns null if invalid or hostile.
 */
export function parseShareDestination(urlOrPath) {
  const parsed = parseShareUrl(urlOrPath);
  if (!parsed) return null;
  return {
    type: parsed.type,
    id: parsed.id,
  };
}

/**
 * Dormant React Navigation linking configuration.
 *
 * Contract requirements:
 * - prefixes: [] (dormant, does NOT register URL schemes or incoming listeners)
 * - enabled: false (dormant)
 * - getInitialURL: resolves null (no cold start incoming URL execution)
 * - subscribe: returns empty unsubscribe (no background/foreground listeners)
 * - getStateFromPath: parses valid canonical share paths without side effects (NO AUTOPLAY)
 */
export const DORMANT_LINKING_CONFIG = {
  prefixes: [],
  enabled: false,

  async getInitialURL() {
    // Dormant: Universal Links are a separate follow-up. Does not intercept URLs on startup.
    return null;
  },

  subscribe(_listener) {
    // Dormant: does not register native Linking event listeners.
    return () => {};
  },

  getStateFromPath(path, _options) {
    const destination = parseShareDestination(path);
    if (!destination) {
      return undefined;
    }

    // NO AUTOPLAY: State contains purely screen routing, never playback commands or queue mutations.
    if (destination.type === 'album') {
      return {
        routes: [
          { name: 'MainTabs' },
          { name: 'Album', params: { albumId: destination.id } },
        ],
      };
    }

    if (destination.type === 'artist') {
      return {
        routes: [
          { name: 'MainTabs' },
          { name: 'ArtistDetail', params: { artistId: destination.id, id: destination.id } },
        ],
      };
    }

    // No track detail screen exists. HTTPS track browsing stays on web.

    return undefined;
  },

  getPathFromState(state, _options) {
    if (!state?.routes?.length) return undefined;
    const activeRoute = state.routes[state.routes.length - 1];

    try {
      if (activeRoute.name === 'Album' && activeRoute.params?.albumId)
        return formatShareUrl('album', activeRoute.params.albumId).slice('https://web.puuk.fun'.length);
      if (activeRoute.name === 'ArtistDetail')
        return formatShareUrl('artist', activeRoute.params?.artistId || activeRoute.params?.id).slice('https://web.puuk.fun'.length);
    } catch { return undefined; }
    return undefined;
  },
};

/**
 * In-memory pending destination store for iOS.
 * Handles deduplication, 24-hour expiration, and auth-ready resolution.
 */
class PendingShareDestinationStore {
  constructor() {
    this._pending = null;
  }

  /**
   * Sets the pending destination.
   * Replaces older target, deduplicates identical target, validates age.
   */
  setPendingDestination(destination, { now = Date.now() } = {}) {
    const valid = validateDestination(destination);

    // Deduplicate if identical target is already pending
    if (
      this._pending &&
      this._pending.type === valid.type &&
      this._pending.id === valid.id
    ) {
      // Refresh timestamp to preserve within current session
      this._pending.savedAt = now;
      return { ...this._pending };
    }

    this._pending = {
      type: valid.type,
      id: valid.id,
      savedAt: now,
    };
    return { ...this._pending };
  }

  /**
   * Retrieves current pending destination if valid and unexpired (< 24 hours).
   * Rejects future/corrupt timestamps.
   */
  getPendingDestination({ now = Date.now() } = {}) {
    if (!this._pending) return null;

    const age = now - this._pending.savedAt;
    // Reject negative/future-corrupt ages or ages exceeding 24 hours
    if (age < 0 || age > MAX_DESTINATION_AGE_MS) {
      this._pending = null;
      return null;
    }

    return { ...this._pending };
  }

  /**
   * Clears any saved pending destination.
   */
  clearPendingDestination() {
    this._pending = null;
  }

  /**
   * Returns true if a valid unexpired pending destination exists.
   */
  hasPendingDestination({ now = Date.now() } = {}) {
    return this.getPendingDestination({ now }) !== null;
  }
}

export const pendingDestinationStore = new PendingShareDestinationStore();

/**
 * Dispatches a destination to React Navigation with strict NO-AUTOPLAY guarantee.
 *
 * If not authenticated: saves to pending store, returns pending: true.
 * If authenticated: clears pending store and navigates to the target screen.
 *
 * In all cases:
 * - NO playback is started
 * - NO queue is modified
 * - NO current track is replaced
 *
 * @param {object} destination - { type: 'track'|'album'|'artist', id: string }
 * @param {object} navigation - React Navigation object (or navigationRef)
 * @param {object} [options]
 * @param {boolean} [options.isAuthenticated=false] - Whether user session is verified
 * @param {number} [options.now=Date.now()] - Timestamp
 * @returns {{ handled: boolean, pending: boolean, autoplay: false, destination: object }}
 */
export function dispatchShareDestination(destination, navigation, options = {}) {
  const { isAuthenticated = false, now = Date.now() } = options;
  const valid = validateDestination(destination);

  if (!isAuthenticated) {
    pendingDestinationStore.setPendingDestination(valid, { now });
    return {
      handled: false,
      pending: true,
      autoplay: false,
      destination: valid,
    };
  }

  // User is authenticated: clear pending target and navigate
  pendingDestinationStore.clearPendingDestination();

  if (navigation && typeof navigation.navigate === 'function') {
    switch (valid.type) {
      case 'album':
        navigation.navigate('Album', { albumId: valid.id });
        break;
      case 'artist':
        navigation.navigate('ArtistDetail', { artistId: valid.id, id: valid.id });
        break;
      case 'track':
        return { handled: false, pending: false, autoplay: false, destination: valid };
      default:
        break;
    }
  }

  return {
    handled: true,
    pending: false,
    autoplay: false,
    destination: valid,
  };
}
