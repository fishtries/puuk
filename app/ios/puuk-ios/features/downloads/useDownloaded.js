import { useEffect, useState } from 'react';
import { getBackgroundDownloadStatus } from '../../offline/downloads/runtime';
import { overlayFavorites } from '../../offline/collections/runtime';
import { getRatingOverlay } from '../../offline/outbox/runtime';
import {
  FAVORITES_COLLECTION,
  getOfflineSession,
  isOfflineSessionCurrent,
  readCollection,
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

export default function useDownloaded(enabled = true) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let running = false;
    let pending = false;
    let previousSession = getOfflineSession();
    const refresh = async () => {
      if (!alive) return;
      const session = getOfflineSession();
      if (session !== previousSession) {
        previousSession = session;
        if (alive) setData(null);
      }
      if (!session) {
        if (alive) setData(null);
        return;
      }
      if (running) {
        pending = true;
        return;
      }
      running = true;
      const current = () => alive && isOfflineSessionCurrent(session);
      try {
        const [keys, budget] = await Promise.all([
          listSavedCollections(session),
          readStorageBudget(session),
        ]);
        if (!current()) return;
        const wave = await readOfflineWaveStatus(session, budget);
        if (!current()) return;
        const all = [
          FAVORITES_COLLECTION,
          ...keys.filter((k) => k.kind !== 'favorites'),
        ];
        const snapshots = (
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
              return { key, ...snapshot, tracks };
            }),
          )
        ).filter(Boolean);
        if (!current()) return;
        const readiness = await collectionProgress(
          session,
          snapshots.flatMap((item) => item.tracks),
        );
        let offset = 0;
        const collections = snapshots.map((item) => {
          const tracks = readiness.tracks.slice(
            offset,
            offset + item.tracks.length,
          );
          offset += tracks.length;
          const ready = tracks.reduce(
            (count, track) => count + Number(track.state === 'ready'),
            0,
          );
          return { ...item, progress: { total: tracks.length, tracks, ready } };
        });
        if (current())
          setData({
            session,
            collections,
            budget,
            wave,
            downloadStatus: getBackgroundDownloadStatus(),
          });
      } catch (_) {
        if (current()) setData(null);
      } finally {
        running = false;
        if (alive && pending) {
          pending = false;
          void refresh();
        }
      }
    };
    refresh();
    const unsubscribe = subscribeOfflineAvailability(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [enabled]);
  return data && isOfflineSessionCurrent(data.session) ? data : null;
}
