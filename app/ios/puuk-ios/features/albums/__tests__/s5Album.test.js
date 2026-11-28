import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FlatList, Alert } from 'react-native';
import AlbumScreen from '../AlbumScreen';
import { authFetch } from '../../../shared/api/api';
import { readPlayableIds } from '../../../offline';

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
  readPlayableIds: jest.fn(async (_, ids) => new Set(ids)),
  subscribeOfflineIndex: listener => {
    mockListeners.add(listener);
    return () => mockListeners.delete(listener);
  },
}));
jest.mock('../../../offline/collections', () => ({
  isCollectionSaved: async () => true,
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

test('album skips unrelated offline events and coalesces updates during a read', async () => {
  mockSnapshot = { tracks: [{ id: 0 }, { id: 0 }] };
  authFetch.mockResolvedValue({ ok: false, status: 503 });
  const emit = (event) =>
    mockListeners.forEach((listener) => listener({ session: mockSession, ...event }));
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AlbumScreen
        route={{ params: { albumId: 'saved', albumTitle: 'Saved' } }}
        navigation={{ goBack() {} }}
      />,
    );
  });
  try {
    readPlayableIds.mockClear();
    await act(async () => {
      emit({ type: 'published', mediaKey: { trackId: 'other' } });
      emit({ type: 'collection', kind: 'playlist', collectionId: 'saved' });
      emit({ type: 'missing', session: {}, mediaKey: { trackId: '0' } });
    });
    expect(readPlayableIds).not.toHaveBeenCalled();

    let finishRead;
    readPlayableIds
      .mockImplementationOnce(
        () => new Promise((resolve) => { finishRead = resolve; }),
      )
      .mockResolvedValueOnce(new Set(['0']));
    await act(async () => {
      emit({ type: 'published', mediaKey: { trackId: '0' } });
      emit({ type: 'version', trackId: '0' });
      emit({ type: 'missing' });
    });
    expect(readPlayableIds).toHaveBeenCalledTimes(1);
    expect(readPlayableIds).toHaveBeenCalledWith(mockSession, ['0']);

    await act(async () => {
      finishRead(new Set());
    });
    expect(readPlayableIds).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAll(({ props }) =>
      Array.isArray(props.children) && props.children.join('') === 'Скачано 2 из 2',
    ).length).toBeGreaterThan(0);
  } finally {
    await act(async () => renderer.unmount());
  }
});
