import { useEffect, useState } from 'react';
import {
  isOfflineSessionCurrent,
  readPlayableIds,
  subscribeOfflineIndex,
} from '../../offline';
import { getTrackId } from '../../shared/domain/trackAdapter';

export default function useCollectionProgress(session, key, tracks, enabled) {
  const { kind, collectionId } = key;
  const [progress, setProgress] = useState(null);

  useEffect(() => {
    if (!session || !enabled) return;
    const ids = tracks.map((track) => {
      const id = getTrackId(track);
      return id === null ? null : String(id);
    });
    const trackIds = new Set(ids.filter((id) => id !== null));
    const uniqueIds = [...trackIds];
    let active = true;
    let running = false;
    let pending = false;
    const current = () => active && isOfflineSessionCurrent(session);

    const refresh = async () => {
      if (!current()) return;
      if (running) {
        // A read can discover missing files and emit more index events.
        pending = true;
        return;
      }
      running = true;
      try {
        const readyIds = await readPlayableIds(session, uniqueIds);
        if (current()) {
          const ready = ids.reduce(
            (count, id) => count + Number(readyIds.has(id)),
            0,
          );
          setProgress((previous) =>
            previous?.session === session &&
            previous.kind === kind &&
            previous.collectionId === collectionId &&
            previous.ready === ready &&
            previous.total === ids.length &&
            previous.readyIds.size === readyIds.size &&
            [...readyIds].every((id) => previous.readyIds.has(id))
              ? previous
              : {
                  session,
                  kind,
                  collectionId,
                  readyIds,
                  ready,
                  total: ids.length,
                },
          );
        }
      } catch {
        // Retain the last known count until the index can be read again.
      } finally {
        running = false;
        if (pending) {
          pending = false;
          void refresh();
        }
      }
    };

    const unsubscribe = subscribeOfflineIndex((event) => {
      if (!isOfflineSessionCurrent(event.session)) return;
      if (event.type === 'collection') {
        if (
          event.kind === kind &&
          String(event.collectionId) === String(collectionId)
        )
          void refresh();
      } else if (
        event.type === 'published' ||
        event.type === 'missing' ||
        event.type === 'version'
      ) {
        const trackId = event.mediaKey?.trackId ?? event.trackId;
        if (trackId == null || trackIds.has(String(trackId))) void refresh();
      }
    });
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session, kind, collectionId, tracks, enabled]);

  return enabled &&
    progress &&
    progress.session === session &&
    progress.kind === kind &&
    progress.collectionId === collectionId
    ? progress
    : null;
}
