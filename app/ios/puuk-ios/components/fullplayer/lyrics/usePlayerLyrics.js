import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getTrackId } from '../../../shared/domain/trackAdapter';
import {
  addSessionListener, getAuthSessionGeneration, getOfflineSession,
  isOfflineSessionCurrent, readSelectedLyrics, subscribeOfflineIndex,
} from '../../../offline/lyrics';

export default function usePlayerLyrics(track, playbackMediaKey, enabled = true) {
  const id = getTrackId(track);
  const trackId = id === null ? null : String(id);
  const session = useSyncExternalStore(subscribeOfflineIndex, getOfflineSession);
  const generation = useSyncExternalStore(addSessionListener, getAuthSessionGeneration);
  const playedVersion = playbackMediaKey && session &&
    playbackMediaKey.owner?.origin === session.owner.origin &&
    playbackMediaKey.owner?.userId === session.owner.userId &&
    String(playbackMediaKey.trackId) === trackId ? playbackMediaKey.contentVersion : undefined;
  const version = playedVersion ?? track?.content_version;
  const [mediaChange, setMediaChange] = useState(0);
  const selection = useMemo(() => ({ session, generation, trackId, version }),
    [session, generation, trackId, version]);
  const [snapshot, setSnapshot] = useState(null);
  const lastRead = useRef(null);

  useEffect(() => subscribeOfflineIndex(event => {
    if ((event?.type === 'published' || event?.type === 'missing') &&
        session && isOfflineSessionCurrent(event.session) &&
        String(event.mediaKey?.trackId) === trackId &&
        (!version || event.mediaKey.contentVersion === version)) {
      setMediaChange(value => value + 1);
    }
  }), [session, trackId, version]);

  useEffect(() => {
    if (!enabled || selection.trackId === null) return;
    if (lastRead.current?.selection === selection && lastRead.current.mediaChange === mediaChange) return;
    const controller = new AbortController();
    readSelectedLyrics(selection.session, selection.trackId, selection.version, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        if (result.state === 'ready' || result.state === 'absent') lastRead.current = { selection, mediaChange };
        setSnapshot(previous => {
          const saved = previous?.result;
          if (previous?.selection === selection && saved?.state === 'ready') {
            if (result.state === 'unknown') return previous;
            if (result.state === 'ready' && saved.lyricsRevision != null &&
                saved.lyricsRevision === result.lyricsRevision &&
                saved.contentVersion === result.contentVersion &&
                saved.payload?.lyrics === result.payload?.lyrics) return previous;
          }
          return { selection, result };
        });
      });
    return () => controller.abort();
  }, [enabled, selection, mediaChange]);

  if (snapshot?.selection === selection) return snapshot.result;
  return { state: trackId === null ? 'unknown' : 'loading' };
}
