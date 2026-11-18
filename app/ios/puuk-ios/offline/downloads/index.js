import { requireOptionalNativeModule } from 'expo';
import { mediaDelivery } from '../../shared/api/media';
export { createDownloadScheduler } from './scheduler';

export function getIOSBackgroundDownloadTransport() {
  const native = requireOptionalNativeModule('PuukBackgroundDownloads');
  if (!native || typeof native.prepareStorage !== 'function') return null;
  return {
    start: request => native.start(request),
    snapshot: () => native.snapshot(),
    discard: operationId => native.discard(operationId),
    prepareStorage: () => native.prepareStorage(),
    addListener: listener => native.addListener('change', listener),
  };
}

export function resolveDownloadTicket(trackId, { signal }) {
  return mediaDelivery.resolve(trackId, { force: true, priority: 'download', signal });
}
