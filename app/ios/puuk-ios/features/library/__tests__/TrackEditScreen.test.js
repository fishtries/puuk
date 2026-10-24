import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Alert, DeviceEventEmitter, TouchableOpacity } from 'react-native';
import TrackEditScreen from '../TrackEditScreen';
import { authFetch } from '../../../shared/api/api';

jest.mock('../../../shared/api/api', () => ({
  SERVER_URL: 'https://puuk.app',
  authFetch: jest.fn(),
  parseApiErrorMessage: (err, fallback) => fallback,
}));

jest.mock('../../../shared/storage/settings', () => ({
  getSettings: jest.fn(() => ({ accentColor: '#FFDAB9' })),
  addSettingsListener: jest.fn(() => () => {}),
}));

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

describe('TrackEditScreen - Stage 8 Slice 6 track normalization & identity', () => {
  const mockNavigation = {
    goBack: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert');
  });

  afterEach(() => {
    Alert.alert.mockRestore();
  });

  test('использует канонический URL для legacy track_id, сохраняет поля и эмитит оба ID в PUUK_TRACK_UPDATED', async () => {
    const routeTrack = {
      track_id: 'legacy-edit-123',
      title: 'Legacy Edit Song',
      artist: 'Artist Edit',
      album: 'Edit Album',
      custom_prop: 'preserved_tag_value',
    };

    // 1. Initial track details fetch
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        lyrics: '[00:01.00]Edited lyrics',
      }),
    });

    // 2. PATCH save response
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'updated' }),
    });

    const listener = jest.fn();
    const sub = DeviceEventEmitter.addListener('PUUK_TRACK_UPDATED', listener);

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackEditScreen
          route={{ params: { track: routeTrack } }}
          navigation={mockNavigation}
        />,
      );
    });

    // Verify GET used canonical identifier 'legacy-edit-123'
    expect(authFetch).toHaveBeenCalledWith('/api/tracks/legacy-edit-123');

    // Trigger Save
    const saveText = renderer.root.findByProps({ children: 'Save Changes' });
    let saveButton = saveText.parent;
    while (saveButton && saveButton.type !== TouchableOpacity) {
      saveButton = saveButton.parent;
    }
    await act(async () => {
      await saveButton.props.onPress();
    });

    // Verify PATCH used canonical identifier
    expect(authFetch).toHaveBeenCalledWith(
      '/api/tracks/legacy-edit-123',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.objectContaining({
          title: 'Legacy Edit Song',
          artist: 'Artist Edit',
          album: 'Edit Album',
        }),
      }),
    );

    // Verify PUUK_TRACK_UPDATED event payload
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'legacy-edit-123',
        track_id: 'legacy-edit-123',
        title: 'Legacy Edit Song',
        artist: 'Artist Edit',
        custom_prop: 'preserved_tag_value', // preserved fields
      }),
    );

    expect(Alert.alert).toHaveBeenCalledWith(
      'Success',
      'Track metadata and cover updated successfully',
      expect.any(Array),
    );
    const okButton = Alert.alert.mock.calls[0][2][0];
    okButton.onPress();
    expect(mockNavigation.goBack).toHaveBeenCalled();

    sub.remove();
  });

  test('корректно обрабатывает числовой ID 0 для GET, PATCH и событий', async () => {
    const zeroTrack = {
      id: 0,
      title: 'Zero Song',
      artist: 'Zero Artist',
    };

    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ lyrics: '' }),
    });

    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'updated' }),
    });

    const listener = jest.fn();
    const sub = DeviceEventEmitter.addListener('PUUK_TRACK_UPDATED', listener);

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackEditScreen
          route={{ params: { track: zeroTrack } }}
          navigation={mockNavigation}
        />,
      );
    });

    expect(authFetch).toHaveBeenCalledWith('/api/tracks/0');

    const saveText = renderer.root.findByProps({ children: 'Save Changes' });
    let saveButton = saveText.parent;
    while (saveButton && saveButton.type !== TouchableOpacity) {
      saveButton = saveButton.parent;
    }
    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(authFetch).toHaveBeenCalledWith(
      '/api/tracks/0',
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 0,
        track_id: 0,
        title: 'Zero Song',
      }),
    );

    sub.remove();
  });

  test('удаление трека отправляет DELETE по каноническому URL и эмитит PUUK_TRACK_DELETED', async () => {
    const routeTrack = {
      track_id: 'legacy-del-42',
      title: 'Track to Delete',
    };

    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'deleted' }),
    });

    const deleteListener = jest.fn();
    const sub = DeviceEventEmitter.addListener(
      'PUUK_TRACK_DELETED',
      deleteListener,
    );

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackEditScreen
          route={{ params: { track: routeTrack } }}
          navigation={mockNavigation}
        />,
      );
    });

    // Find Delete button in header
    const trashIcon = renderer.root.findAllByProps({
      name: 'trash-outline',
    })[0];
    let deleteButton = trashIcon.parent;
    while (deleteButton && deleteButton.type !== TouchableOpacity) {
      deleteButton = deleteButton.parent;
    }

    await act(async () => {
      deleteButton.props.onPress();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Delete Track',
      expect.stringContaining('Track to Delete'),
      expect.any(Array),
    );

    const alertButtons = Alert.alert.mock.calls[0][2];
    const confirmDelete = alertButtons.find((b) => b.text === 'Delete');
    expect(confirmDelete).toBeDefined();

    await act(async () => {
      await confirmDelete.onPress();
    });

    expect(authFetch).toHaveBeenCalledWith(
      '/api/tracks/legacy-del-42',
      expect.objectContaining({ method: 'DELETE' }),
    );

    expect(deleteListener).toHaveBeenCalledWith({
      id: 'legacy-del-42',
      track_id: 'legacy-del-42',
    });
    expect(mockNavigation.goBack).toHaveBeenCalled();

    sub.remove();
  });

  test('отклоняет операции сохранения и удаления при невалидном идентификаторе трека', async () => {
    const invalidTrack = { id: '', track_id: '   ' };

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TrackEditScreen
          route={{ params: { track: invalidTrack } }}
          navigation={mockNavigation}
        />,
      );
    });

    // Did not send initial fetch details
    expect(authFetch).not.toHaveBeenCalled();

    // Try save
    const saveText = renderer.root.findByProps({ children: 'Save Changes' });
    let saveButton = saveText.parent;
    while (saveButton && saveButton.type !== TouchableOpacity) {
      saveButton = saveButton.parent;
    }
    await act(async () => {
      await saveButton.props.onPress();
    });

    expect(authFetch).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      'Invalid track identifier',
    );

    // Try delete
    const trashIcon = renderer.root.findAllByProps({
      name: 'trash-outline',
    })[0];
    let deleteButton = trashIcon.parent;
    while (deleteButton && deleteButton.type !== TouchableOpacity) {
      deleteButton = deleteButton.parent;
    }
    await act(async () => {
      deleteButton.props.onPress();
    });

    expect(authFetch).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      'Invalid track identifier',
    );
  });

  describe('App.js PUUK_TRACK_UPDATED/DELETED event reconciliation', () => {
    // Import helper directly to test reconciliation logic matching App.js
    const {
      areTrackIdsEqual,
      getTrackId,
    } = require('../../../shared/domain/trackAdapter');

    test('reconciles PUUK_TRACK_UPDATED across id and track_id forms without false matches on missing IDs', () => {
      const stateTracks = [
        { id: 'track-1', title: 'Song 1 Old' },
        { track_id: 'track-2', title: 'Song 2 Old' },
      ];

      // Update for track-2 sent with canonical id
      const updatePayload1 = { id: 'track-2', title: 'Song 2 Updated' };
      const next1 = stateTracks.map((t) =>
        areTrackIdsEqual(t, updatePayload1) ? { ...t, ...updatePayload1 } : t,
      );
      expect(next1[1].title).toBe('Song 2 Updated');
      expect(next1[0].title).toBe('Song 1 Old');

      // Update sent with missing identity is rejected
      const invalidUpdate = { title: 'Corrupt' };
      expect(getTrackId(invalidUpdate)).toBeNull();

      // No false match on null/missing IDs
      expect(areTrackIdsEqual({ id: null }, invalidUpdate)).toBe(false);
      expect(areTrackIdsEqual({ id: 'track-1' }, invalidUpdate)).toBe(false);
    });

    test('reconciles PUUK_TRACK_DELETED across id and track_id forms', () => {
      const stateTracks = [
        { id: 'del-1', title: 'Track 1' },
        { track_id: 'del-2', title: 'Track 2' },
        { id: 0, title: 'Zero Track' },
      ];

      // Delete by legacy track_id payload { track_id: 'del-1' }
      const payload1 = { track_id: 'del-1' };
      const id1 = getTrackId(payload1);
      const after1 = stateTracks.filter((t) => !areTrackIdsEqual(t, id1));
      expect(after1).toHaveLength(2);
      expect(after1.map((t) => t.id ?? t.track_id)).toEqual(['del-2', 0]);

      // Delete by numeric ID 0 payload { id: 0 }
      const payloadZero = { id: 0 };
      const idZero = getTrackId(payloadZero);
      const afterZero = after1.filter((t) => !areTrackIdsEqual(t, idZero));
      expect(afterZero).toHaveLength(1);
      expect(afterZero[0].track_id).toBe('del-2');

      // Invalid payload is ignored
      const invalidPayload = { id: '' };
      expect(getTrackId(invalidPayload)).toBeNull();
    });
  });
});
