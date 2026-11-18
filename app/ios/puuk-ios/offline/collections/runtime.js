import { probeReadyVersions } from './versionProbe';
import { AppState } from 'react-native';
import { subscribeNetworkPolicy } from '../../utils/networkPolicy';
import {
  getOfflineSession,
  isOfflineSessionCurrent,
  readCollection,
  FAVORITES_COLLECTION,
  subscribeOfflineIndex,
} from '..';
import {
  getRatingOverlay,
  captureFavoritesSnapshotGuard,
  waitForOutboxDrain,
} from '../outbox/runtime';
import { authFetch } from '../../shared/api/api';
import { subscribeBackgroundDownloadStatus } from '../downloads/runtime';
import {
  saveOfflineCollection,
  reconcileRetention,
  listSavedCollections,
} from '.';

export function overlayFavorites(tracks, ratings) {
  const active = ratings.filter((r) => r.state !== 'failed');
  const byId = new Map(active.map((r) => [String(r.trackId), r]));
  const result = tracks.filter((track) => {
    const r = byId.get(String(track.id));
    return !r || (r.rating === 'like' && r.state !== 'missing');
  });
  const present = new Set(result.map((track) => String(track.id)));
  for (const rating of active) {
    if (
      rating.rating === 'like' &&
      rating.state !== 'missing' &&
      rating.track &&
      !present.has(String(rating.trackId))
    ) {
      result.push(rating.track);
      present.add(String(rating.trackId));
    }
  }
  return result;
}

let running;
export function startCollectionSync() {
  if (running) return () => {};
  let stopped = false,
    requested = 0,
    busy = false,
    needsNetwork = false;
  const refresh = async (networkRefresh = false) => {
    needsNetwork ||= networkRefresh;
    requested += 1;
    if (busy) return;
    busy = true;
    try {
      while (!stopped && requested) {
        requested = 0;
        const fetchRemote = needsNetwork;
        needsNetwork = false;
        const session = getOfflineSession();
        if (!session) continue;
        if (fetchRemote) {
          await waitForOutboxDrain(session);
          if (stopped || !isOfflineSessionCurrent(session)) continue;
          const keys = [
            FAVORITES_COLLECTION,
            ...(await listSavedCollections(session)).filter(
              (key) => key.kind === 'album' || key.kind === 'playlist',
            ),
          ];
          for (const key of keys) {
            if (stopped || !isOfflineSessionCurrent(session)) break;
            const before = await readCollection(session, key);
            const guard =
              key === FAVORITES_COLLECTION
                ? captureFavoritesSnapshotGuard(session)
                : () => true;
            try {
              const path =
                key === FAVORITES_COLLECTION
                  ? '/api/favorites'
                  : `/api/${key.kind === 'album' ? 'albums' : 'playlists'}/${encodeURIComponent(key.collectionId)}`;
              const response = await authFetch(path, { retry: 0 });
              if (!response.ok) continue;
              const data = await response.json();
              const tracks = key === FAVORITES_COLLECTION ? data : data?.tracks;
              if (
                !Array.isArray(tracks) ||
                stopped ||
                !isOfflineSessionCurrent(session)
              )
                continue;
              const overlay =
                key === FAVORITES_COLLECTION
                  ? await getRatingOverlay(session)
                  : [];
              if (stopped || !isOfflineSessionCurrent(session) || !guard())
                break;
              const saved = await saveOfflineCollection(
                session,
                key,
                {
                  title:
                    data?.album?.title ||
                    data?.playlist?.name ||
                    before?.title ||
                    '',
                  tracks:
                    key === FAVORITES_COLLECTION
                      ? overlayFavorites(tracks, overlay)
                      : tracks,
                },
                {
                  snapshotTracks: tracks,
                  expectedUpdatedAt: before?.updatedAt ?? null,
                  replaceSnapshot: true,
                  requireSaved: key !== FAVORITES_COLLECTION,
                  guard,
                },
              );
              if (saved && !stopped && isOfflineSessionCurrent(session))
                probeReadyVersions(session, tracks);
            } catch {
              /* Keep the last complete snapshot on any transport failure. */
            }
          }
        }
        const guard = captureFavoritesSnapshotGuard(session);
        const snapshot = await readCollection(session, FAVORITES_COLLECTION);
        const overlay = await getRatingOverlay(session);
        if (isOfflineSessionCurrent(session)) {
          await saveOfflineCollection(
            session,
            FAVORITES_COLLECTION,
            {
              title: snapshot?.title || '',
              tracks: overlayFavorites(snapshot?.tracks || [], overlay),
            },
            {
              snapshotTracks: snapshot?.tracks || [],
              expectedUpdatedAt: snapshot?.updatedAt ?? null,
              guard,
            },
          );
        }
        if (isOfflineSessionCurrent(session)) await reconcileRetention(session);
      }
    } finally {
      busy = false;
    }
  };
  const unsub = subscribeOfflineIndex((event) => {
    if (
      ['opened', 'rating', 'rating-overlay', 'ratings-refreshed'].includes(
        event.type,
      )
    )
      void refresh(event.type === 'opened').catch(() => {});
  });
  const downloadStatus = subscribeBackgroundDownloadStatus(() => {
    void refresh().catch(() => {});
  });
  const network = subscribeNetworkPolicy(() => {
    void refresh(true).catch(() => {});
  });
  const app = AppState.addEventListener('change', (state) => {
    if (state === 'active') void refresh(true).catch(() => {});
  });
  running = () => {
    stopped = true;
    unsub();
    network();
    downloadStatus();
    app.remove();
    running = null;
  };
  void refresh(true).catch(() => {});
  return running;
}
