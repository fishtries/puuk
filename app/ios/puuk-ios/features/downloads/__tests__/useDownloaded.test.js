import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import useDownloaded from '../useDownloaded';
let mockSession = { activationId: 'a' },
  mockListener,
  mockStatusListener,
  mockStatus = 'available';
jest.mock('../../../offline', () => ({
  FAVORITES_COLLECTION: { kind: 'favorites', collectionId: 'favorites' },
  getOfflineSession: () => mockSession,
  isOfflineSessionCurrent: (s) => s === mockSession,
  readCollection: jest.fn(async () => ({ title: 'Private', tracks: [] })),
  subscribeOfflineIndex: (cb) => {
    mockListener = cb;
    return () => {};
  },
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
  subscribeBackgroundDownloadStatus: (cb) => {
    mockStatusListener = cb;
    return () => {};
  },
}));
jest.mock('../../../offline/availability', () => ({
  readStorageBudget: async () => ({}),
  readOfflineWaveStatus: async () => ({}),
  subscribeOfflineAvailability: () => () => {},
}));
function Probe() {
  const data = useDownloaded();
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
    mockStatusListener();
  });
  expect(tree.toJSON()).toBe('Private:unsupported');
  await act(async () => {
    mockSession = null;
    mockListener({ type: 'closed' });
  });
  expect(tree.toJSON()).toBe('Unavailable');
});
