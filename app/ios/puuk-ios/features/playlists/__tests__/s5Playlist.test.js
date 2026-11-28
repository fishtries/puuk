import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FlatList, Alert, TouchableOpacity } from 'react-native';
import PlaylistScreen from '../PlaylistScreen';
import { authFetch } from '../../../shared/api/api';
import { readPlayableIds } from '../../../offline';
import CoverImage from '../../../shared/media/CoverImage';

jest.mock('../../../shared/api/api', () => ({
  SERVER_URL: 'https://puuk.app',
  authFetch: jest.fn(),
}));

jest.mock('../../../shared/storage/settings', () => ({
  getSettings: jest.fn(() => ({ accentColor: '#FFDAB9' })),
  addSettingsListener: jest.fn(() => () => {}),
}));

jest.mock('../../../shared/media/CoverImage', () => jest.fn(() => null));

const mockSession = {};
const mockListeners = new Set();
let mockSnapshot;
jest.mock('../../../offline', () => ({
  FAVORITES_COLLECTION: { kind: 'favorites', collectionId: 'favorites' },
  getOfflineSession: () => mockSession,
  isOfflineSessionCurrent: value => value === mockSession,
  readCollection: async () => mockSnapshot,
  readPlayableIds: jest.fn(async () => new Set()),
  subscribeOfflineIndex: listener => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  },
}));
jest.mock('../../../offline/collections', () => ({
  isCollectionSaved: async () => true,
}));
jest.mock('../../../offline/foreground', () => ({
  saveFavoriteOffline: async () => {},
}));

test('mounted playlist reflects a newly committed offline snapshot when connectivity returns', async () => {
  mockSnapshot = { tracks: [{ id: 'b' }, { id: 'a' }] };
  authFetch.mockResolvedValue({ ok: false, status: 503 });
  const props = {
    route: { params: { playlistId: 'saved', playlistName: 'Saved' } },
    navigation: { goBack() {} }, onPlayTrackList() {},
  };
  let renderer;
  await act(async () => { renderer = TestRenderer.create(<PlaylistScreen {...props} />); });
  try {
    const tracks = () => renderer.root.findByType(FlatList).props.data.map(({ id }) => id);
    expect(tracks()).toEqual(['b', 'a']);
    mockSnapshot = { tracks: [{ id: 'a' }, { id: 'c' }, { id: 'b' }, { id: 'a' }] };
    await act(async () => {
      mockListeners.forEach(listener => listener({ type: 'collection', kind: 'playlist', collectionId: 'saved', session: mockSession }));
    });
    expect(tracks()).toEqual(['a', 'c', 'b', 'a']);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test('favorites check only listed track IDs and use the same result for the count and buttons', async () => {
  readPlayableIds.mockClear();
  readPlayableIds.mockResolvedValueOnce(new Set(['0']));
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlaylistScreen
        route={{
          params: {
            playlistId: 'favorites',
            playlistName: 'Favorites',
            tracks: [
              { id: 0, title: 'Ready', coverArt: 'ready-cover' },
              { id: 1, title: 'Pending', coverArt: 'pending-cover' },
              { id: 2, title: 'Unchanged', coverArt: 'unchanged-cover' },
            ],
          },
        }}
        navigation={{ goBack() {} }}
      />,
    );
  });
  try {
    const button = (label) => renderer.root.findAllByType(TouchableOpacity)
      .find((node) => node.props.accessibilityLabel === label);
    expect(readPlayableIds).toHaveBeenCalledTimes(1);
    expect(readPlayableIds).toHaveBeenCalledWith(mockSession, ['0', '1', '2']);
    expect(button('Ready скачан').props.disabled).toBe(true);
    expect(button('Скачать Pending').props.disabled).toBe(false);
    expect(renderer.root.findAll(({ props }) =>
      Array.isArray(props.children) && props.children.join('') === 'Скачано 1 из 3',
    ).length).toBeGreaterThan(0);

    // The count stays at one, but the saved marker moves to the other track.
    CoverImage.mockClear();
    readPlayableIds.mockResolvedValueOnce(new Set(['1']));
    await act(async () => {
      mockListeners.forEach((listener) =>
        listener({ type: 'version', session: mockSession, trackId: '0' }),
      );
    });
    expect(button('Скачать Ready').props.disabled).toBe(false);
    expect(button('Pending скачан').props.disabled).toBe(true);
    const rowCovers = CoverImage.mock.calls
      .map(([props]) => props)
      .filter(({ style }) => style.width === 40)
      .map(({ source }) => source);
    expect(rowCovers.sort()).toEqual(['pending-cover', 'ready-cover']);
  } finally {
    await act(async () => renderer.unmount());
  }
});
