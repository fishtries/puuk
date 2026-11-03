import { useEffect, useRef } from 'react';
import { SERVER_URL, authFetch, addAuthListener } from '../shared/api/api';
import { getSavedLastTrack, setSavedLastTrack } from '../shared/storage/settings';
import { getTrackId, areTrackIdsEqual } from '../shared/domain/trackAdapter';
import { subscribeArtistCreditsUpdated } from '../shared/domain/artistCreditEvents';

// Keep a persisted track fresh when no player owns it.
export default function useSavedCreditsSync(currentTrack, currentUser) {
  // Cleanup may abort requests without settling them. Keep their slots until
  // finally, and let their completion wake whichever effect now owns the queue.
  const requestsRef = useRef({ running: 0, pump: null });
  useEffect(() => {
    const requests = requestsRef.current;
    let live = true;
    const versions = new Map();
    const pending = new Map();
    const controllers = new Set();
    const abortRequests = () => { for (const controller of controllers) controller.abort(); };
    let authEpoch = 0;
    const unsubscribeAuth = addAuthListener(() => { authEpoch += 1; pending.clear(); abortRequests(); });
    const apply = async (id, version, updated, server, epoch) => {
      const saved = await getSavedLastTrack();
      if (!live || authEpoch !== epoch || SERVER_URL !== server || versions.get(id) !== version ||
          !saved || !areTrackIdsEqual(saved, id) || !areTrackIdsEqual(updated, id)) return;
      const patch = {};
      for (const key of ['artist', 'artist_id', 'artists', 'artists_revision', 'album_artist', 'album_artists', 'album_artists_revision']) {
        if (Object.prototype.hasOwnProperty.call(updated, key)) patch[key] = updated[key];
      }
      await setSavedLastTrack({ ...saved, ...patch });
    };
    const pump = () => {
      while (live && requests.running < 4 && pending.size) {
        const [id, task] = pending.entries().next().value;
        pending.delete(id);
        if (versions.get(id) !== task.version || authEpoch !== task.epoch || SERVER_URL !== task.server) continue;
        requests.running += 1;
        const controller = new AbortController();
        controllers.add(controller);
        (async () => {
          try {
            const response = await authFetch(`/api/tracks/${encodeURIComponent(id)}?credits_only=true`, { signal: controller.signal });
            if (response.ok) await apply(id, task.version, await response.json(), task.server, task.epoch);
          } catch { /* Preserve the saved track for a later refresh. */ }
        })().finally(() => {
          controllers.delete(controller);
          requests.running -= 1;
          requests.pump?.();
        });
      }
    };
    requests.pump = pump;
    const unsubscribe = subscribeArtistCreditsUpdated(async (event) => {
      if (currentTrack) return;
      const updates = event.scope === 'track' ? [event.track] : event.scope === 'album' ? (event.tracks || []) : [];
      const ids = event.scope === 'bulk' ? (event.affected?.track_ids || []) : updates.map(getTrackId);
      const uniqueIds = [...new Set(ids.map(getTrackId).filter((id) => id !== null).map(String))];
      const eventVersions = new Map();
      for (const id of uniqueIds) {
        const version = (versions.get(id) || 0) + 1;
        versions.set(id, version);
        eventVersions.set(id, version);
        pending.delete(id);
      }
      const server = SERVER_URL;
      const epoch = authEpoch;
      const saved = await getSavedLastTrack();
      const id = saved && getTrackId(saved) !== null ? String(getTrackId(saved)) : null;
      if (!live || epoch !== authEpoch || server !== SERVER_URL || !id || !eventVersions.has(id) || versions.get(id) !== eventVersions.get(id)) return;
      if (event.scope === 'bulk') {
        pending.set(id, { version: eventVersions.get(id), server, epoch });
        pump();
      } else {
        const updated = updates.find((track) => areTrackIdsEqual(track, id));
        if (updated) await apply(id, eventVersions.get(id), updated, server, epoch);
      }
    });
    return () => {
      live = false;
      pending.clear();
      requests.pump = null;
      unsubscribe();
      unsubscribeAuth();
      abortRequests();
    };
  }, [currentTrack, currentUser]);

}
