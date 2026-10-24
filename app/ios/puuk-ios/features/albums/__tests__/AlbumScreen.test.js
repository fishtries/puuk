import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FlatList } from 'react-native';
import AlbumScreen from '../AlbumScreen';
import { authFetch } from '../../../shared/api/api';

jest.mock('../../../shared/api/api', () => ({
  SERVER_URL: 'https://puuk.app',
  authFetch: jest.fn(),
}));

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    useFocusEffect: (cb) => {
      React.useEffect(() => {
        cb();
      }, [cb]);
    },
  };
});

describe('AlbumScreen - Stage 8 Slice 5 track normalization & identity', () => {
  const mockRoute = {
    params: {
      albumId: 'alb-1',
      albumTitle: 'Test Album',
      coverArt: 'https://puuk.app/api/cover/alb-1',
    },
  };

  const mockNavigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('нормализует legacy track_id, сохраняет все поля и генерирует fallback coverArt', async () => {
    const onPlayTrack = jest.fn();
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        album: { id: 'alb-1', title: 'Test Album' },
        tracks: [
          {
            track_id: 'legacy-alb-track-1',
            title: 'Album Song 1',
            artist: 'Album Artist',
            track_number: '1/12',
            duration: 215,
            album_custom: 'preserved_tag',
          },
        ],
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AlbumScreen
          route={mockRoute}
          navigation={mockNavigation}
          onPlayTrack={onPlayTrack}
        />,
      );
    });

    expect(authFetch).toHaveBeenCalledWith('/api/albums/alb-1');

    // Title and artist rendered
    expect(
      renderer.root.findAll((n) => n.props.children === 'Album Song 1').length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Album Artist').length,
    ).toBeGreaterThan(0);

    // Press track
    const trackRow = renderer.root.findAllByProps({ activeOpacity: 0.6 })[0];
    await act(async () => {
      trackRow.props.onPress();
    });

    expect(onPlayTrack).toHaveBeenCalledTimes(1);
    const played = onPlayTrack.mock.calls[0][0];
    expect(played.id).toBe('legacy-alb-track-1');
    expect(played.track_id).toBe('legacy-alb-track-1');
    expect(played.track_number).toBe('1/12');
    expect(played.duration).toBe(215);
    expect(played.album_custom).toBe('preserved_tag');
    expect(played.coverArt).toBe(
      'https://puuk.app/api/cover/legacy-alb-track-1',
    );
  });

  test('корректно обрабатывает числовой ID 0 в списке треков альбома', async () => {
    const onPlayTrack = jest.fn();
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        album: { id: 'alb-0', title: 'Zero Album' },
        tracks: [
          {
            id: 0,
            title: 'Zero ID Track',
            artist: 'Zero Artist',
          },
        ],
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AlbumScreen
          route={mockRoute}
          navigation={mockNavigation}
          onPlayTrack={onPlayTrack}
        />,
      );
    });

    expect(
      renderer.root.findAll((n) => n.props.children === 'Zero ID Track').length,
    ).toBeGreaterThan(0);

    const trackRow = renderer.root.findAllByProps({ activeOpacity: 0.6 })[0];
    await act(async () => {
      trackRow.props.onPress();
    });

    expect(onPlayTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 0,
        track_id: 0,
        coverArt: 'https://puuk.app/api/cover/0',
      }),
    );
  });

  test('игнорирует невалидные записи без идентификатора', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        album: { id: 'alb-1', title: 'Filter Album' },
        tracks: [
          null,
          {},
          { id: '' },
          { id: '   ' },
          { id: 'valid-alb-1', title: 'Valid Song' },
        ],
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AlbumScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    expect(renderer.root.findByProps({ children: 'Valid Song' })).toBeDefined();
    const flatList = renderer.root.findByType(FlatList);
    expect(flatList.props.data).toHaveLength(1);
    expect(flatList.props.data[0].id).toBe('valid-alb-1');
  });
});
