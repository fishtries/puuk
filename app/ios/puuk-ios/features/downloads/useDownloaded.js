import { useEffect, useState } from 'react';
import {
  getBackgroundDownloadStatus,
  subscribeBackgroundDownloadStatus,
} from '../../offline/downloads/runtime';
import { overlayFavorites } from '../../offline/collections/runtime';
import { getRatingOverlay } from '../../offline/outbox/runtime';
import {
  FAVORITES_COLLECTION,
  getOfflineSession,
  isOfflineSessionCurrent,
  readCollection,
  subscribeOfflineIndex,
} from '../../offline';
import {
  collectionProgress,
  listSavedCollections,
} from '../../offline/collections';
import {
  readOfflineWaveStatus,
  readStorageBudget,
  subscribeOfflineAvailability,
} from '../../offline/availability';

export default function useDownloaded() {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true,
      revision = 0,
      previousSession = null;
    const refresh = async () => {
      const session = getOfflineSession(),
        token = ++revision;
      if (session !== previousSession) {
        previousSession = session;
        if (alive) setData(null);
      }
      if (!session) {
        if (alive) setData(null);
        return;
      }
      try {
        const [keys, budget, wave] = await Promise.all([
          listSavedCollections(session),
          readStorageBudget(session),
          readOfflineWaveStatus(session),
        ]);
        const all = [
          FAVORITES_COLLECTION,
          ...keys.filter((k) => k.kind !== 'favorites'),
        ];
        const collections = (
          await Promise.all(
            all.map(async (key) => {
              const snapshot = await readCollection(session, key);
              if (!snapshot) return null;
              const tracks =
                key.kind === 'favorites'
                  ? overlayFavorites(
                      snapshot.tracks,
                      await getRatingOverlay(session),
                    )
                  : snapshot.tracks;
              const progress = await collectionProgress(session, tracks);
              return { key, ...snapshot, tracks, progress };
            }),
          )
        ).filter(Boolean);
        if (alive && token === revision && isOfflineSessionCurrent(session))
          setData({
            session,
            collections,
            budget,
            wave,
            downloadStatus: getBackgroundDownloadStatus(),
          });
      } catch (_) {
        if (alive && token === revision) setData(null);
      }
    };
    refresh();
    const a = subscribeOfflineIndex(refresh),
      b = subscribeOfflineAvailability(refresh),
      c = subscribeBackgroundDownloadStatus(refresh);
    return () => {
      alive = false;
      revision++;
      a();
      b();
      c();
    };
  }, []);
  return data;
}
