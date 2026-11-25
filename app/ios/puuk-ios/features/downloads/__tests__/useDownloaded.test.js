import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import useDownloaded from '../useDownloaded';
let mockSession = { activationId: 'a' },
  mockListener,
  mockStatus = 'available';
jest.mock('../../../offline', () => ({
  FAVORITES_COLLECTION: { kind: 'favorites', collectionId: 'favorites' },
  getOfflineSession: () => mockSession,
  isOfflineSessionCurrent: (s) => s === mockSession,
  readCollection: jest.fn(async () => ({ title: 'Private', tracks: [] })),
}));
jest.mock('../../../offline/collections', () => ({
  listSavedCollections: jest.fn(async () => []),
  collectionProgress: jest.fn(async () => ({ ready: 0, total: 0, tracks: [] })),
}));
jest.mock('../../../offline/collections/runtime', () => ({
  overlayFavorites: (tracks) => tracks,
}));
jest.mock('../../../offline/outbox/runtime', () => ({
  getRatingOverlay: async () => ({}),
}));
jest.mock('../../../offline/downloads/runtime', () => ({
  getBackgroundDownloadStatus: () => mockStatus,
}));
jest.mock('../../../offline/availability', () => ({
  readStorageBudget: async () => ({}),
  readOfflineWaveStatus: async () => ({}),
  subscribeOfflineAvailability: (cb) => { mockListener = cb; return () => {}; },
}));
function Probe({ enabled = true }) {
  const data = useDownloaded(enabled);
  return (
    <>
      {data
        ? `${data.collections[0]?.title}:${data.downloadStatus}`
        : 'Unavailable'}
    </>
  );
}
test('clears previous owner data when mockSession closes', async () => {
  let tree;
  await act(async () => {
    tree = TestRenderer.create(<Probe />);
  });
  expect(tree.toJSON()).toBe('Private:available');
  await act(async () => {
    mockStatus = 'unsupported';
    mockListener();
  });
  expect(tree.toJSON()).toBe('Private:unsupported');
  await act(async () => {
    mockSession = null;
    mockListener({ type: 'closed' });
  });
  expect(tree.toJSON()).toBe('Unavailable');
});

test('a burst of download events shares a scan and a hidden screen stops refreshing', async () => {
  const { listSavedCollections } = require('../../../offline/collections');
  mockSession = { activationId: 'b' };
  listSavedCollections.mockClear();
  let finish;
  listSavedCollections.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let tree;
  await act(async () => { tree = TestRenderer.create(<Probe />); });
  const refresh = mockListener;
  await act(async () => { for (let i = 0; i < 20; i++) refresh(); });
  expect(listSavedCollections).toHaveBeenCalledTimes(1);
  await act(async () => { finish([]); });
  expect(listSavedCollections).toHaveBeenCalledTimes(2);
  await act(async () => { tree.update(<Probe enabled={false} />); refresh(); });
  const calls = listSavedCollections.mock.calls.length;
  await act(async () => { refresh(); });
  expect(listSavedCollections).toHaveBeenCalledTimes(calls);
  await act(async () => { tree.update(<Probe />); });
  expect(listSavedCollections).toHaveBeenCalledTimes(calls + 1);
  await act(async () => tree.unmount());
});
