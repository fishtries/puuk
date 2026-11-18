import { AppState } from 'react-native';
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import {
  addSettingsListener,
  getSettings,
} from '../../shared/storage/settings';
import * as index from '../index';
import { updateNativeTransferProgress } from '../budget';
import { notifyOfflineIndex } from '../session';
import {
  createDownloadScheduler,
  getIOSBackgroundDownloadTransport,
  resolveDownloadTicket,
} from './index';

let runtime;
let status = 'initializing';
const listeners = new Set();

function setStatus(next) {
  if (status === next) return;
  status = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* Subscribers are independent of the scheduler. */
    }
  }
}

export const getBackgroundDownloadStatus = () => status;

export function subscribeBackgroundDownloadStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function enqueueBackgroundDownload(session, track, reason) {
  if (!runtime?.restored) return { status };
  if (!index.isOfflineSessionCurrent(session))
    return { status: 'session-unavailable' };
  const queued = await runtime.scheduler.enqueue(session, track, reason);
  return queued ? { status: 'queued', ...queued } : { status: 'rejected' };
}

export async function cancelBackgroundDownload(session, jobId) {
  return runtime?.restored ? runtime.scheduler.cancel(session, jobId) : false;
}

export function finishBackgroundDownloadRestore({ clearOrphans = false } = {}) {
  if (!runtime || runtime.restored) return;
  runtime.restored = true;
  setStatus('available');
  if (clearOrphans || index.getOfflineSession()) runtime.sessionChanged();
}

export function startBackgroundDownloads({ orderJobs, promoteCache } = {}) {
  if (runtime) return undefined;
  const transport = getIOSBackgroundDownloadTransport();
  if (!transport) {
    setStatus('unsupported');
    return undefined;
  }

  let network;
  let networkRevision = 0;
  const lifecycle = { restored: false };
  let scheduled;
  let progressKey;
  const reconsiderSpace = () => {
    if (scheduled !== undefined) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      if (runtime === lifecycle && lifecycle.restored)
        void scheduler.reconsiderSpace().catch(() => {});
    }, 0);
  };
  const scheduler = createDownloadScheduler({
    index: {
      ...index,
      getOfflineSession: () =>
        lifecycle.restored ? index.getOfflineSession() : null,
    },
    transport,
    resolveTicket: resolveDownloadTicket,
    getNetworkPolicy: () => ({
      connected:
        lifecycle.restored &&
        network?.isConnected === true &&
        network.isInternetReachable !== false,
      type: network?.type,
      allowCellular: getSettings().allowCellularDownloads === true,
    }),
    orderJobs,
    promoteCache,
    onTransferSnapshot(transfers) {
      updateNativeTransferProgress(transfers);
      const key = JSON.stringify(transfers.map(({ operationId, bytesReceived, receipt }) =>
        [operationId, bytesReceived, receipt?.bytes]));
      if (key === progressKey) return;
      progressKey = key;
      const session = index.getOfflineSession();
      if (session) notifyOfflineIndex({ type: 'transfer-progress', session });
    },
    onState: ({ jobId, state, trackId }) => {
      if (runtime === lifecycle && lifecycle.restored && !jobId)
        setStatus(state);
      if (!jobId) return;
      const session = index.getOfflineSession();
      if (session) notifyOfflineIndex({ type: 'download-state', session, jobId, trackId, state });
    },
  });
  lifecycle.scheduler = scheduler;
  lifecycle.sessionChanged = () => {
    void scheduler.sessionChanged().catch(() => {
      if (runtime === lifecycle) setStatus('unavailable');
    });
  };
  runtime = lifecycle;
  setStatus('initializing');

  const wake = () => {
    if (runtime === lifecycle && lifecycle.restored) void scheduler.wake();
  };
  const refreshNetwork = async () => {
    const revision = ++networkRevision;
    const next = await getNetworkStateAsync().catch(() => undefined);
    if (revision === networkRevision) {
      network = next;
      wake();
    }
  };
  const networkSubscription = addNetworkStateListener((next) => {
    networkRevision += 1;
    network = next;
    wake();
  });
  const settingsSubscription = addSettingsListener(({ key }) => {
    if (key === 'allowCellularDownloads') wake();
    if (key === 'offlineBudgetBytes') reconsiderSpace();
  });
  const indexSubscription = index.subscribeOfflineIndex(({ type }) => {
    if (lifecycle.restored && (type === 'opened' || type === 'closed'))
      lifecycle.sessionChanged();
    else if (type === 'cache-cleared') reconsiderSpace();
    else if (type === 'missing' || type === 'published' || type === 'budget') wake();
  });
  const appSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') void refreshNetwork();
  });
  void refreshNetwork();
  void transport.prepareStorage().catch(() => {});

  return () => {
    runtime = undefined;
    clearTimeout(scheduled);
    scheduler.stop();
    networkSubscription.remove();
    settingsSubscription();
    indexSubscription();
    appSubscription.remove();
    setStatus('initializing');
  };
}
