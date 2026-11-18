import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FlatList, Alert } from 'react-native';
import AlbumScreen from '../AlbumScreen';
import { authFetch } from '../../../shared/api/api';

jest.mock('../../../shared/api/api', () => ({
  SERVER_URL: 'https://puuk.app',
  authFetch: jest.fn(),
}));

jest.mock('../../../shared/storage/settings', () => ({
  getSettings: jest.fn(() => ({ accentColor: '#FFDAB9' })),
  addSettingsListener: jest.fn(() => () => {}),
}));

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');

const mockSession = {};
const mockListeners = new Set();
let mockSnapshot;
jest.mock('../../../offline', () => ({
  FAVORITES_COLLECTION: { kind: 'favorites', collectionId: 'favorites' },
  getOfflineSession: () => mockSession,
  isOfflineSessionCurrent: value => value === mockSession,
  readCollection: async () => mockSnapshot,
  readFavoriteDownloads: async () => ({ ready: [] }),
  subscribeOfflineIndex: listener => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  },
}));
jest.mock('../../../offline/collections', () => ({
  isCollectionSaved: async () => true,
  collectionProgress: async (_, tracks) => ({ total: tracks.length, ready: tracks.length }),
}));
jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return { useFocusEffect: cb => React.useEffect(cb, [cb]) };
});

test('mounted album reflects a newly committed offline snapshot when connectivity returns', async () => {
  mockSnapshot = { tracks: [{ id: 'b' }, { id: 'a' }] };
  authFetch.mockResolvedValue({ ok: false, status: 503 });
  const props = {
    route: { params: { albumId: 'saved', albumTitle: 'Saved' } },
    navigation: { goBack() {} }, onPlayTrackList() {},
  };
  let renderer;
  await act(async () => { renderer = TestRenderer.create(<AlbumScreen {...props} />); });
  try {
    const tracks = () => renderer.root.findByType(FlatList).props.data.map(({ id }) => id);
    expect(tracks()).toEqual(['b', 'a']);
    mockSnapshot = { tracks: [{ id: 'a' }, { id: 'c' }, { id: 'b' }, { id: 'a' }] };
    await act(async () => {
      mockListeners.forEach(listener => listener({ type: 'collection', kind: 'album', collectionId: 'saved', session: mockSession }));
    });
    expect(tracks()).toEqual(['a', 'c', 'b', 'a']);
  } finally {
    await act(async () => renderer.unmount());
  }
});
