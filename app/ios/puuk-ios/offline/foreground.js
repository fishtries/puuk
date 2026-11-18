import { fetch } from 'expo/fetch';
import { AppState } from 'react-native';
import { FileMode } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { mediaDelivery } from '../shared/api/media';
import { getTrackId } from '../shared/domain/trackAdapter';
import {
  isOfflineSessionCurrent,
  publishVerifiedDownload,
  queueDownload,
  reserveTransfer,
  resetTransfer,
  subscribeOfflineIndex,
} from './index';
import { offlineFile } from './storage';
import { prepareCachePromotion } from './promoteCache';

// Only an explicit S1 foreground save uses this transport. S2 supplies native receipts
// to the same publisher, without putting ticket URLs into the durable index.
export async function saveFavoriteOffline(session, track) {
  if (!isOfflineSessionCurrent(session)) return null;
  if (AppState.currentState && AppState.currentState !== 'active') return null;
  const controller = new AbortController();
  const appState = AppState.addEventListener('change', (state) => {
    if (state !== 'active') controller.abort();
  });
  const unsubscribe = subscribeOfflineIndex(({ type }) => {
    if (type === 'closed' && !isOfflineSessionCurrent(session))
      controller.abort();
  });
  const trackId = String(getTrackId(track));
  let attempt;
  let promotion;
  let stage;
  let published;
  let reader;
  let handle;
  let deadline;
  let idle;
  const armInactivity = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), 15000);
  };
  const check = () => {
    if (controller.signal.aborted || !isOfflineSessionCurrent(session))
      throw new Error('Transfer interrupted');
  };
  try {
    const descriptor = await mediaDelivery.resolve(track, {
      mode: 'direct',
      force: true,
      priority: 'current',
      signal: controller.signal,
    });
    check();
    if (
      descriptor.legacy ||
      descriptor.trackId !== trackId ||
      descriptor.downloadBinding !== 'if-match'
    )
      return null;
    const job = await queueDownload(session, trackId, 'foreground-favorites');
    if (!job) return null;
    promotion = prepareCachePromotion(session, descriptor, controller.signal);
    const reservation = { ...descriptor, track };
    if (promotion) {
      attempt = await reserveTransfer(session, job.jobId, reservation, { localCopy: true });
      if (!attempt) {
        promotion.release();
        promotion = undefined;
      }
    }
    if (!attempt) attempt = await reserveTransfer(session, job.jobId, reservation);
    if (attempt?.mediaKey) {
      published = attempt.mediaKey;
      return published;
    }
    if (!attempt?.operationId) {
      attempt = null;
      return null;
    }
    check();
    const localReceipt = await promotion?.stage(attempt);
    check();
    if (localReceipt) {
      const confirmed = await mediaDelivery.resolve(track, {
        mode: 'direct', force: true, priority: 'download', signal: controller.signal,
      });
      check();
      if (confirmed.contentVersion !== descriptor.contentVersion ||
          confirmed.contentLength !== descriptor.contentLength) return null;
      published = await publishVerifiedDownload(session, { ...attempt, receipt: localReceipt });
      if (published) promotion?.commit();
      return published;
    }
    promotion?.release();
    promotion = undefined;

    stage = offlineFile(attempt.stagingPath);
    stage.create();
    handle = stage.open(FileMode.WriteOnly);
    deadline = setTimeout(() => controller.abort(), 120000);
    armInactivity();
    const response = await fetch(descriptor.uri, {
      headers: {
        'If-Match': `"sha256-${descriptor.contentVersion}"`,
        'Accept-Encoding': 'identity',
      },
      redirect: 'error',
      credentials: 'omit',
      signal: controller.signal,
    });
    check();
    if (
      response.status !== 200 ||
      response.redirected ||
      !response.body ||
      response.headers.get('content-range')
    )
      return null;
    reader = response.body.getReader();
    const digest = sha256.create();
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      check();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > descriptor.contentLength) return null;
      armInactivity();
      digest.update(value);
      await handle.writeBytes(value);
    }
    handle.close();
    handle = null;
    check();
    // Confirm the ticket's version again, in case the track changed during transfer.
    const current = await mediaDelivery.resolve(track, {
      mode: 'direct',
      force: true,
      priority: 'download',
      signal: controller.signal,
    });
    check();
    if (
      current.contentVersion !== descriptor.contentVersion ||
      current.contentLength !== descriptor.contentLength
    )
      return null;
    published = await publishVerifiedDownload(session, {
      ...attempt,
      receipt: {
        stagingPath: attempt.stagingPath,
        status: response.status,
        bytes,
        sha256: bytesToHex(digest.digest()),
      },
    });
    return published;
  } finally {
    controller.abort();
    promotion?.release();
    unsubscribe();
    appState.remove();
    clearTimeout(deadline);
    clearTimeout(idle);
    reader?.cancel().catch(() => {});
    handle?.close();
    if (attempt && !published) {
      try {
        const leftover = offlineFile(attempt.stagingPath);
        if (leftover.exists) leftover.delete();
      } catch {
        /* A later reconciliation can remove this staging file. */
      }
      await resetTransfer(session, attempt.jobId, attempt.operationId).catch(() => {});
    }
  }
}
