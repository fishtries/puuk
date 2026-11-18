import { AppState } from 'react-native';
import { getCurrentNetworkPolicy, subscribeNetworkPolicy } from '../../utils/networkPolicy';
import { offlineDatabase } from '../storage';
import { ownerKey } from '../session';
import { createLyricsSync } from './runtime';
import {
  authFetch, addSessionListener, getAuthSessionGeneration,
} from '../../shared/api/api';
import { boundedMediaOperation } from '../../shared/api/media';
import {
  getOfflineSession, isOfflineSessionCurrent, readMediaKey, readLyrics,
  saveLyricsResult, subscribeOfflineIndex,
} from '../index';
import { createLyricsProvider } from './provider';

const trackPath = trackId => `/api/tracks/${encodeURIComponent(trackId)}`;

function fetchJson(endpoint, signal, options) {
  return boundedMediaOperation(async requestSignal => {
    const response = await authFetch(endpoint, { ...options, signal: requestSignal });
    if (!response || response.ok === false ||
        (response.status != null && (response.status < 200 || response.status >= 300))) {
      throw new Error('Lyrics API request failed');
    }
    return response.json();
  }, { signal, timeout: options?.timeout ?? 30000 });
}

const provider = createLyricsProvider({
  readMediaKey, readLyrics, saveLyricsResult, isOfflineSessionCurrent,
  getAuthGeneration: getAuthSessionGeneration,
  fetchLyrics: (trackId, signal) => fetchJson(`${trackPath(trackId)}/lyrics`, signal),
  fetchContentVersion: async (trackId, signal) => {
    const track = await fetchJson(`${trackPath(trackId)}?credits_only=true`, signal, {
      retry: 0, timeout: 3000, cache: 'no-store',
    });
    return track?.content_version;
  },
});

export const { refreshLyrics, readSelectedLyrics } = provider;
export {
  getOfflineSession, isOfflineSessionCurrent, subscribeOfflineIndex,
  getAuthSessionGeneration, addSessionListener,
};

// Read only, bounded and fenced by both the live session and its persisted activation.
async function listUnknownLyrics(session, after, limit) {
  if (!isOfflineSessionCurrent(session)) return [];
  const db = await offlineDatabase();
  if (!isOfflineSessionCurrent(session)) return [];
  const owner = ownerKey(session.owner);
  const rows = await db.getAllAsync(
    `SELECT m.track_id, m.version FROM media m
     JOIN track_version v ON v.owner=m.owner AND v.track_id=m.track_id AND v.desired_version=m.version
     JOIN activation a ON a.singleton=1 AND a.owner=m.owner AND a.activation_id=?
     LEFT JOIN lyrics l ON l.owner=m.owner AND l.track_id=m.track_id AND l.version=m.version
     WHERE m.owner=? AND m.track_id>? AND
       (l.result IS NULL OR CASE WHEN json_valid(l.result) THEN json_extract(l.result, '$.state') = 'unknown' ELSE 1 END)
     ORDER BY m.track_id LIMIT ?`, session.activationId, owner, after, limit,
  );
  return isOfflineSessionCurrent(session)
    ? rows.map(row => ({ owner: session.owner, trackId: row.track_id, contentVersion: row.version })) : [];
}

export const startLyricsSync = createLyricsSync({
  getSession: getOfflineSession, isCurrent: isOfflineSessionCurrent,
  listUnknown: listUnknownLyrics, refresh: refreshLyrics,
  subscribeIndex: subscribeOfflineIndex, subscribeNetwork: subscribeNetworkPolicy,
  getNetwork: getCurrentNetworkPolicy,
  subscribeAppState: listener => {
    const subscription = AppState.addEventListener('change', listener);
    return () => subscription.remove();
  },
});
