import { FileMode } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import defaultAudioCache from '../utils/audioCache';
import { isOfflineSessionCurrent } from './session';
import { offlineFile } from './storage';

// The ordinary cache binds its downloads to a version but does not hash them.
// Authenticate every byte before giving a local copy to the S1 publisher.
export function prepareCachePromotion(session, ticket, signal) {
  if (!isOfflineSessionCurrent(session)) return null;
  const cached = defaultAudioCache.borrowVersion(
    session.owner,
    ticket.trackId,
    ticket.contentVersion,
  );
  if (!cached) return null;
  return {
    release: cached.release,
    commit: cached.discard,
    async stage(reservation) {
      const deadline = Date.now() + 30_000;
      const assertCurrent = () => {
        if (
          signal?.aborted ||
          !isOfflineSessionCurrent(session) ||
          Date.now() >= deadline
        )
          throw new Error('Offline cache promotion interrupted');
      };
      const stage = offlineFile(reservation.stagingPath);
      const digest = sha256.create();
      let input;
      let output;
      let verified = false;
      try {
        assertCurrent();
        input = cached.file.open(FileMode.ReadOnly);
        stage.create();
        output = stage.open(FileMode.WriteOnly);
        let bytes = 0;
        while (bytes < ticket.contentLength) {
          assertCurrent();
          const chunk = await input.readBytes(
            Math.min(256 * 1024, ticket.contentLength - bytes),
          );
          assertCurrent();
          if (!chunk.byteLength) return null;
          bytes += chunk.byteLength;
          digest.update(chunk);
          await output.writeBytes(chunk);
        }
        assertCurrent();
        const hash = bytesToHex(digest.digest());
        if (hash !== ticket.contentVersion || bytes !== ticket.contentLength)
          return null;
        verified = true;
        return {
          stagingPath: reservation.stagingPath,
          status: 200,
          bytes,
          sha256: hash,
        };
      } catch {
        return null;
      } finally {
        input?.close();
        output?.close();
        if (!verified && stage.exists) stage.delete();
      }
    },
  };
}
