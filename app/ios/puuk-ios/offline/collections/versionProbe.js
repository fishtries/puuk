import { authFetch } from '../../shared/api/api';
import {
  captureDesiredVersion,
  confirmDesiredVersion,
  isOfflineSessionCurrent,
  readMediaKey,
} from '..';
import { reconcileRetention } from '.';

// A single bounded queue spans refreshes. A track is checked once while in flight.
const pending = new Map();
let active = 0;
const limit = 3;
function pump() {
  for (const [key, item] of pending) {
    if (active >= limit) break;
    if (item.started) continue;
    item.started = true;
    active += 1;
    void probe(item.session, item.id).finally(() => {
      pending.delete(key);
      active -= 1;
      pump();
    });
  }
}
async function probe(session, id) {
  try {
    if (!isOfflineSessionCurrent(session) || !(await readMediaKey(session, id)))
      return;
    const expected = await captureDesiredVersion(session, id);
    if (!expected || !isOfflineSessionCurrent(session)) return;
    const response = await authFetch(
      `/api/tracks/${encodeURIComponent(id)}?credits_only=true`,
      {
        retry: 0,
        timeout: 3000,
        cache: 'no-store',
      },
    );
    if (!response.ok) return;
    const data = await response.json();
    if (!isOfflineSessionCurrent(session)) return;
    if (
      await confirmDesiredVersion(session, id, expected, data?.content_version)
    )
      await reconcileRetention(session);
  } catch {
    // No verified version means the current ready file remains usable.
  }
}
export function probeReadyVersions(session, tracks) {
  for (const track of tracks) {
    const id = track?.id ?? track?.track_id;
    if (id == null) continue;
    const key = `${session.activationId}:${session.generation}:${String(id)}`;
    if (!pending.has(key)) pending.set(key, { session, id: String(id) });
  }
  pump();
}
