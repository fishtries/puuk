import { authFetch } from '../shared/api/api';
import { boundedMediaOperation } from '../shared/api/media';
import { readMediaKey } from './index';
import {
  getOfflineSession,
  isOfflineSessionCurrent,
  notifyOfflineIndex,
  ownerKey,
  subscribeOfflineIndex,
} from './session';
import { withStorageAdmission } from './budget';
import { offlineCoverFile, prepareOfflineCovers } from './artworkFiles';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_COVER_BYTES = 512 * 1024;
const MAX_PENDING_COVERS = 64;

function resolveFile(uri) {
  const session = getOfflineSession();
  if (!session || typeof uri !== 'string') return null;
  try {
    const url = new URL(uri, session.owner.origin);
    const trackId = url.pathname.split('/').pop();
    if (
      url.origin === session.owner.origin &&
      url.pathname === `/api/cover/${trackId}` &&
      uuid.test(trackId)
    )
      return offlineCoverFile(session.owner, trackId);
  } catch {
    /* An invalid source cannot identify local artwork. */
  }
  return null;
}

export function getOfflineCoverUri(uri) {
  try {
    const file = resolveFile(uri);
    return file?.exists && file.size > 0 ? file.uri : null;
  } catch {
    return null;
  }
}

export function startOfflineArtwork() {
  let stopped = false;
  let running = false;
  const pending = new Map();
  let controller;
  let activeId;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.size && !stopped) {
        const [trackId, session] = pending.entries().next().value;
        pending.delete(trackId);
        if (!isOfflineSessionCurrent(session)) continue;
        const file = offlineCoverFile(session.owner, trackId);
        if (file.exists && file.size > 0) continue;
        activeId = trackId;
        controller = new AbortController();
        try {
          const bytes = await boundedMediaOperation(
            async (signal) => {
              const response = await authFetch(
                `/api/cover/${trackId}?size=256`,
                {
                  signal,
                  retry: 0,
                  timeout: 4000,
                  cache: 'no-store',
                },
              );
              const length = Number(response.headers.get('content-length'));
              if (
                !response.ok ||
                response.headers.get('content-type')?.split(';')[0] !==
                  'image/jpeg' ||
                !Number.isSafeInteger(length) ||
                length < 1 ||
                length > MAX_COVER_BYTES
              )
                return null;
              const body = new Uint8Array(await response.arrayBuffer());
              return body.byteLength === length ? body : null;
            },
            { signal: controller.signal, timeout: 4000 },
          );
          if (!bytes || stopped || !(await readMediaKey(session, trackId)))
            continue;
          await withStorageAdmission(
            session,
            bytes.byteLength,
            () => {
              prepareOfflineCovers();
              file.write(bytes);
              notifyOfflineIndex({ type: 'cover', session, trackId });
              return true;
            },
            {
              reclaim: false,
              eligible: (db) => {
                if (
                  stopped ||
                  file.exists ||
                  !db.getFirstSync(
                    'SELECT 1 FROM media WHERE owner=? AND track_id=? LIMIT 1',
                    ownerKey(session.owner),
                    trackId,
                  )
                )
                  return false;
                const hasJournal = db.getFirstSync(
                  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_cleanup'",
                );
                return (
                  !hasJournal ||
                  !db.getFirstSync(
                    'SELECT 1 FROM media_cleanup WHERE path=?',
                    `covers/${file.name}`,
                  )
                );
              },
            },
          );
        } catch {
          /* Artwork is optional for each already published audio file. */
        } finally {
          controller = undefined;
          activeId = undefined;
        }
      }
    } finally {
      running = false;
    }
  }
  const unsubscribe = subscribeOfflineIndex(({ type, session, mediaKey }) => {
    if (type === 'closed') {
      pending.clear();
      controller?.abort();
    }
    if (
      type === 'published' &&
      activeId !== mediaKey.trackId &&
      uuid.test(mediaKey.trackId) &&
      pending.size < MAX_PENDING_COVERS
    ) {
      pending.set(mediaKey.trackId, session);
      void drain().catch(() => {});
    }
  });
  return () => {
    stopped = true;
    unsubscribe();
    pending.clear();
    controller?.abort();
  };
}
