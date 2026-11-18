import { Directory, File } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { getOfflineRootUri } from './storage';

export function offlineCoverFile(owner, trackId) {
  const key = bytesToHex(
    sha256(utf8ToBytes(JSON.stringify([owner.origin, owner.userId, trackId]))),
  );
  return new File(getOfflineRootUri(), 'covers', `${key}.jpg`);
}

export function prepareOfflineCovers() {
  new Directory(getOfflineRootUri(), 'covers').create({
    intermediates: true,
    idempotent: true,
  });
}
