import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ActionSheetIOS, Switch } from 'react-native';
import OfflineSettings from '../../auth/OfflineSettings';
import {
  setOfflineStorageLimit,
  setWaveReserveTarget,
  setCellularDownloads,
} from '../../../offline/availability';
jest.mock('../../../offline', () => ({ getOfflineSession: () => ({}) }));
jest.mock('../../../offline/availability', () => ({
  readStorageBudget: jest.fn(async () => ({
    usedBytes: 0,
    limitBytes: 5 * 1024 ** 3,
  })),
  readOfflineWaveStatus: jest.fn(async () => ({
    readyMinutes: 10,
    targetMinutes: 60,
    pauseReason: 'network',
  })),
  subscribeOfflineAvailability: () => () => {},
  setOfflineStorageLimit: jest.fn(),
  setWaveReserveTarget: jest.fn(),
  setCellularDownloads: jest.fn(),
}));
jest.mock('../DownloadedScreen', () => ({
  formatBytes: (bytes) => `${bytes / 1024 ** 3} GiB`,
  reasonText: (reason) => (reason === 'network' ? 'Waiting for network' : ''),
}));
const settings = {
  offlineBudgetBytes: 5 * 1024 ** 3,
  waveReserveMinutes: 60,
  allowCellularDownloads: true,
};
test('limit, reserve and cellular actions remain independent and show waiting', async () => {
  let tree, callback;
  jest
    .spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementation((_, cb) => {
      callback = cb;
    });
  await act(async () => {
    tree = TestRenderer.create(
      <OfflineSettings settings={settings} lang="en" accent="#fff" visible />,
    );
  });
  expect(JSON.stringify(tree.toJSON())).toContain('Waiting for network');
  await act(async () => {
    tree.root
      .findByProps({ accessibilityLabel: 'Storage limit' })
      .props.onPress();
    callback(1);
  });
  expect(setOfflineStorageLimit).toHaveBeenCalledWith(1024 ** 3);
  expect(setWaveReserveTarget).not.toHaveBeenCalled();
  await act(async () => {
    tree.root
      .findByProps({ accessibilityLabel: 'Wave reserve target' })
      .props.onPress();
    callback(2);
  });
  expect(setWaveReserveTarget).toHaveBeenCalledWith(30);
  await act(async () =>
    tree.root.findByType(Switch).props.onValueChange(false),
  );
  expect(setCellularDownloads).toHaveBeenCalledWith(false);
});
