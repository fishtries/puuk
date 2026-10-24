import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FlatList, Alert } from 'react-native';
import PlaylistScreen from '../PlaylistScreen';
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

describe('PlaylistScreen - Stage 8 Slice 5 track normalization & removal', () => {
  const mockNavigation = {
    goBack: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(Alert, 'alert');
  });

  afterEach(() => {
    jest.useRealTimers();
    Alert.alert.mockRestore();
  });

  test('нормализует legacy track_id и сохраняет все поля в плейлисте', async () => {
    const onPlayTrack = jest.fn();
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tracks: [
          {
            track_id: 'legacy-pl-track-1',
            title: 'Playlist Song 1',
            artist: 'Playlist Artist',
            album: 'Cool Mixtape',
            custom_field: 'playlist_preserved',
          },
        ],
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PlaylistScreen
          route={{ params: { playlistId: 'pl-10', playlistName: 'My Mix' } }}
          navigation={mockNavigation}
          onPlayTrack={onPlayTrack}
        />,
      );
    });

    expect(authFetch).toHaveBeenCalledWith('/api/playlists/pl-10');

    const flatList = renderer.root.findByType(FlatList);
    expect(flatList.props.data).toHaveLength(1);
    const track = flatList.props.data[0];
    expect(track.id).toBe('legacy-pl-track-1');
    expect(track.track_id).toBe('legacy-pl-track-1');
    expect(track.title).toBe('Playlist Song 1');
    expect(track.album).toBe('Cool Mixtape');
    expect(track.custom_field).toBe('playlist_preserved');
    expect(track.coverArt).toBe('https://puuk.app/api/cover/legacy-pl-track-1');
  });

  test('обрабатывает числовой ID 0 и генерирует fallback coverArt', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tracks: [
          {
            id: 0,
            title: 'Zero Playlist Song',
            artist: 'Zero Artist',
          },
        ],
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PlaylistScreen
          route={{ params: { playlistId: 'pl-10', playlistName: 'Zero Mix' } }}
          navigation={mockNavigation}
        />,
      );
    });

    const flatList = renderer.root.findByType(FlatList);
    expect(flatList.props.data).toHaveLength(1);
    const track = flatList.props.data[0];
    expect(track.id).toBe(0);
    expect(track.track_id).toBe(0);
    expect(track.coverArt).toBe('https://puuk.app/api/cover/0');
  });

  test('удаляет трек с legacy track_id по каноническому идентификатору', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tracks: [
          { track_id: 'legacy-del-1', title: 'To Delete' },
          { id: 'keep-2', title: 'To Keep' },
        ],
      }),
    });

    // Mock DELETE endpoint response
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PlaylistScreen
          route={{ params: { playlistId: 'pl-20', playlistName: 'Mix' } }}
          navigation={mockNavigation}
        />,
      );
    });

    const flatListBefore = renderer.root.findByType(FlatList);
    expect(flatListBefore.props.data).toHaveLength(2);

    // Find delete button on first track (trash-outline)
    const trashButtons = renderer.root.findAll(
      (n) => n.props.hitSlop && n.props.hitSlop.top === 12,
    );
    expect(trashButtons.length).toBeGreaterThan(0);

    // Click trash button on first track
    await act(async () => {
      trashButtons[0].props.onPress();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Remove Track',
      'Are you sure you want to remove this track from the playlist?',
      expect.any(Array),
    );

    // Confirm removal in Alert dialog
    const alertButtons = Alert.alert.mock.calls[0][2];
    const removeBtn = alertButtons.find((b) => b.text === 'Remove');
    expect(removeBtn).toBeDefined();

    await act(async () => {
      await removeBtn.onPress();
    });

    // Verify DELETE request sent with canonical id 'legacy-del-1'
    expect(authFetch).toHaveBeenCalledWith(
      '/api/playlists/pl-20/tracks/legacy-del-1',
      expect.objectContaining({ method: 'DELETE' }),
    );

    // Verify removed from FlatList state
    const flatListAfter = renderer.root.findByType(FlatList);
    expect(flatListAfter.props.data).toHaveLength(1);
    expect(flatListAfter.props.data[0].id).toBe('keep-2');
  });

  test('удаляет трек с числовым ID 0 из избранного (/api/favorites)', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 0, title: 'Zero Favorite' }],
    });

    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PlaylistScreen
          route={{
            params: { playlistId: 'favorites', playlistName: 'Favorites' },
          }}
          navigation={mockNavigation}
        />,
      );
    });

    expect(authFetch).toHaveBeenCalledWith('/api/favorites');

    const trashButtons = renderer.root.findAll(
      (n) => n.props.hitSlop && n.props.hitSlop.top === 12,
    );
    await act(async () => {
      trashButtons[0].props.onPress();
    });

    const alertButtons = Alert.alert.mock.calls[0][2];
    const removeBtn = alertButtons.find((b) => b.text === 'Remove');
    await act(async () => {
      await removeBtn.onPress();
    });

    expect(authFetch).toHaveBeenCalledWith(
      '/api/tracks/0/like',
      expect.objectContaining({ method: 'DELETE' }),
    );

    const flatListAfter = renderer.root.findByType(FlatList);
    expect(flatListAfter.props.data).toHaveLength(0);
  });
});
