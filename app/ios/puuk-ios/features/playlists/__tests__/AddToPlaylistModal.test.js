import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Alert, TouchableOpacity } from 'react-native';
import AddToPlaylistModal from '../AddToPlaylistModal';
import { authFetch } from '../../../shared/api/api';

jest.mock('../../../shared/api/api', () => ({
  authFetch: jest.fn(),
}));

describe('AddToPlaylistModal - Stage 8 Slice 5 payload & validation', () => {
  const samplePlaylists = [
    { id: 101, name: 'Driving Vibes' },
    { id: 102, name: 'Night Drive' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert');
  });

  afterEach(() => {
    Alert.alert.mockRestore();
  });

  test('отправляет track_id: getTrackId(track) при добавлении трека с legacy track_id', async () => {
    // 1. Initial playlists load
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => samplePlaylists,
    });

    // 2. Add track POST response
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'added' }),
    });

    const onClose = jest.fn();
    const legacyTrack = {
      track_id: 'legacy-add-99',
      title: 'Legacy Song',
      album: 'Old Album',
    };

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AddToPlaylistModal
          visible={true}
          track={legacyTrack}
          onClose={onClose}
        />,
      );
    });

    expect(authFetch).toHaveBeenCalledWith('/api/playlists');

    // Click first playlist row
    const rows = renderer.root.findAll(
      (n) =>
        n.props.style &&
        n.props.style.flexDirection === undefined &&
        typeof n.props.onPress === 'function' &&
        n.props.children &&
        Array.isArray(n.props.children),
    );
    const playlistRow = renderer.root.findAll(
      (n) =>
        n.type === TouchableOpacity &&
        n.props.onPress &&
        renderer.root.findAll((c) => c.props.children === 'Driving Vibes')
          .length > 0,
    )[0];

    // Find TouchableOpacity containing Driving Vibes text
    const drivingVibesNode = renderer.root.findByProps({
      children: 'Driving Vibes',
    });
    let clickableRow = drivingVibesNode.parent;
    while (clickableRow && clickableRow.type !== TouchableOpacity) {
      clickableRow = clickableRow.parent;
    }
    expect(clickableRow).toBeDefined();

    await act(async () => {
      await clickableRow.props.onPress();
    });

    expect(authFetch).toHaveBeenCalledWith(
      '/api/playlists/101/tracks',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track_id: 'legacy-add-99' }),
      }),
    );
    expect(Alert.alert).toHaveBeenCalledWith(
      'Success',
      'Track added to playlist!',
    );
    expect(onClose).toHaveBeenCalled();
  });

  test('отправляет track_id: 0 для трека с числовым ID 0', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => samplePlaylists,
    });
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'added' }),
    });

    const onClose = jest.fn();
    const zeroTrack = { id: 0, title: 'Zero Track' };

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AddToPlaylistModal
          visible={true}
          track={zeroTrack}
          onClose={onClose}
        />,
      );
    });

    const drivingVibesNode = renderer.root.findByProps({
      children: 'Driving Vibes',
    });
    let clickableRow = drivingVibesNode.parent;
    while (clickableRow && clickableRow.type !== TouchableOpacity) {
      clickableRow = clickableRow.parent;
    }

    await act(async () => {
      await clickableRow.props.onPress();
    });

    expect(authFetch).toHaveBeenCalledWith(
      '/api/playlists/101/tracks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ track_id: 0 }),
      }),
    );
  });

  test('отклоняет добавление невалидного трека без отправки сетевого запроса', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => samplePlaylists,
    });

    const onClose = jest.fn();
    const invalidTrack = { id: '', track_id: '   ' };

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AddToPlaylistModal
          visible={true}
          track={invalidTrack}
          onClose={onClose}
        />,
      );
    });

    const drivingVibesNode = renderer.root.findByProps({
      children: 'Driving Vibes',
    });
    let clickableRow = drivingVibesNode.parent;
    while (clickableRow && clickableRow.type !== TouchableOpacity) {
      clickableRow = clickableRow.parent;
    }

    // Attempt to add invalid track
    await act(async () => {
      await clickableRow.props.onPress();
    });

    // Only initial fetch playlists was called; no POST request was sent!
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/tracks'),
      expect.anything(),
    );
    expect(Alert.alert).toHaveBeenCalledWith('Error', 'Invalid track.');
    expect(onClose).not.toHaveBeenCalled();
  });
});
