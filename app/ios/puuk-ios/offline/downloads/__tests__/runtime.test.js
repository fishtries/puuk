import { AppState } from 'react-native';
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import {
  addSettingsListener,
  getSettings,
} from '../../../shared/storage/settings';
import * as index from '../../index';
import {
  createDownloadScheduler,
  getIOSBackgroundDownloadTransport,
} from '../index';
import {
  cancelBackgroundDownload,
  enqueueBackgroundDownload,
  finishBackgroundDownloadRestore,
  getBackgroundDownloadStatus,
  startBackgroundDownloads,
} from '../runtime';

jest.mock('expo-network', () => ({
  addNetworkStateListener: jest.fn(),
  getNetworkStateAsync: jest.fn(),
}));
jest.mock('../../../shared/storage/settings', () => ({
  addSettingsListener: jest.fn(),
  getSettings: jest.fn(),
}));
jest.mock('../../index', () => ({
  getOfflineSession: jest.fn(),
  isOfflineSessionCurrent: jest.fn(),
  subscribeOfflineIndex: jest.fn(),
}));
jest.mock('../index', () => ({
  createDownloadScheduler: jest.fn(),
  getIOSBackgroundDownloadTransport: jest.fn(),
}));

test('reports unsupported builds without accepting background jobs', async () => {
  getIOSBackgroundDownloadTransport.mockReturnValue(null);
  expect(startBackgroundDownloads()).toBeUndefined();
  expect(getBackgroundDownloadStatus()).toBe('unsupported');
  expect(await enqueueBackgroundDownload({}, 'track', 'playlist')).toEqual({
    status: 'unsupported',
  });
  expect(createDownloadScheduler).not.toHaveBeenCalled();
});

test('gates startup on auth restore and wires the singleton to session, network and settings', async () => {
  const session = { activationId: 'login' };
  const scheduler = {
    wake: jest.fn(),
    sessionChanged: jest.fn().mockResolvedValue(),
    enqueue: jest.fn().mockResolvedValue({ jobId: 'job' }),
    cancel: jest.fn().mockResolvedValue(true),
    stop: jest.fn(),
  };
  const prepareStorage = jest.fn().mockResolvedValue();
  const remove = jest.fn();
  const appState = jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove });
  getIOSBackgroundDownloadTransport.mockReturnValue({ prepareStorage });
  createDownloadScheduler.mockReturnValue(scheduler);
  getSettings.mockReturnValue({ allowCellularDownloads: true });
  index.getOfflineSession.mockReturnValue(session);
  index.isOfflineSessionCurrent.mockImplementation(
    (value) => value === session,
  );
  index.subscribeOfflineIndex.mockReturnValue(remove);
  addNetworkStateListener.mockReturnValue({ remove });
  addSettingsListener.mockReturnValue(remove);
  let completeNetworkRead;
  getNetworkStateAsync.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeNetworkRead = resolve;
      }),
  );

  const stop = startBackgroundDownloads();
  try {
    expect(startBackgroundDownloads()).toBeUndefined();
    expect(createDownloadScheduler).toHaveBeenCalledTimes(1);
    expect(prepareStorage).toHaveBeenCalledTimes(1);
    const [options] = createDownloadScheduler.mock.calls[0];
    const [networkChange] = addNetworkStateListener.mock.calls[0];
    const [settingsChange] = addSettingsListener.mock.calls[0];
    const [indexEvent] = index.subscribeOfflineIndex.mock.calls[0];
    const [, appChange] = appState.mock.calls[0];

    indexEvent({ type: 'opened' });
    networkChange({ isConnected: true, type: 'CELLULAR' });
    completeNetworkRead({ isConnected: false, type: 'NONE' });
    await Promise.resolve();
    expect(options.index.getOfflineSession()).toBeNull();
    expect(
      await enqueueBackgroundDownload(session, 'track', 'playlist'),
    ).toEqual({ status: 'initializing' });
    expect(scheduler.sessionChanged).not.toHaveBeenCalled();

    finishBackgroundDownloadRestore();
    expect(scheduler.sessionChanged).toHaveBeenCalledTimes(1);
    expect(options.index.getOfflineSession()).toBe(session);
    expect(options.getNetworkPolicy()).toEqual({
      connected: true,
      type: 'CELLULAR',
      allowCellular: true,
    });
    expect(
      await enqueueBackgroundDownload(session, 'track', 'playlist'),
    ).toEqual({ status: 'queued', jobId: 'job' });
    expect(await cancelBackgroundDownload(session, 'job')).toBe(true);
    expect(await enqueueBackgroundDownload({}, 'track', 'playlist')).toEqual({
      status: 'session-unavailable',
    });

    getSettings.mockReturnValue({ allowCellularDownloads: false });
    settingsChange({ key: 'allowCellularDownloads' });
    expect(options.getNetworkPolicy().allowCellular).toBe(false);
    networkChange({ isConnected: true, type: 'WIFI' });
    getNetworkStateAsync.mockResolvedValue({ isConnected: true, type: 'WIFI' });
    appChange('active');
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.wake).toHaveBeenCalledTimes(3);
    indexEvent({ type: 'closed' });
    expect(scheduler.sessionChanged).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    appState.mockRestore();
  }
  expect(scheduler.stop).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(4);
});
