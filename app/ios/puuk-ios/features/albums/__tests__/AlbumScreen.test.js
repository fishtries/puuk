import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { FlatList, TouchableOpacity } from 'react-native';
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

  test('делает только album artist кликабельным при наличии stable ID и сохраняет год в meta', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        album: {
          id: 'alb-1',
          title: 'Test Album',
          album_artist: 'Artist A',
          artist_id: 'art_123',
          year: 2024,
          track_count: 8,
        },
        tracks: [{ id: 'track-1', title: 'Song', artist: 'Track Guest' }],
      }),
    });
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AlbumScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });
    const albumArtist = renderer.root.findAll(
      (node) => node.type === 'Text' && node.props.children === 'Artist A',
    )[0];
    let artistControl = albumArtist.parent;
    while (artistControl && artistControl.type !== TouchableOpacity) {
      artistControl = artistControl.parent;
    }
    expect(artistControl).toBeDefined();
    expect(artistControl.props.accessibilityRole).toBe('button');
    expect(artistControl.props.accessibilityLabel).toBe(
      'Страница артиста Artist A',
    );
    await act(async () => artistControl.props.onPress());

    expect(mockNavigation.navigate).toHaveBeenCalledWith('ArtistDetail', {
      artistId: 'art_123',
    });

    // EV-15: Year and track count remain visible when album artist is tappable
    const yearNodes = renderer.root.findAll(
      (node) => node.type === 'Text' && node.props.children === '2024',
    );
    expect(yearNodes.length).toBeGreaterThan(0);

    const trackCountNodes = renderer.root.findAll(
      (node) => node.type === 'Text' && node.props.children === '8 трек(ов)',
    );
    expect(trackCountNodes.length).toBeGreaterThan(0);

    const trackArtist = renderer.root.findByProps({ children: 'Track Guest' });
    expect(trackArtist.parent.type).not.toBe('TouchableOpacity');
  });

  test('не создает tappable artist control без artist_id и рендерит обычный meta-текст', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        album: {
          id: 'alb-2',
          title: 'Plain Album',
          album_artist: 'Artist B',
          artist_id: null,
          year: 2023,
          track_count: 5,
        },
        tracks: [{ id: 'track-2', title: 'Song 2', artist: 'Artist B' }],
      }),
    });
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AlbumScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    const metaNodes = renderer.root.findAll(
      (node) =>
        node.type === 'Text' &&
        node.props.children === 'Artist B · 2023 · 5 трек(ов)',
    );
    expect(metaNodes.length).toBeGreaterThan(0);

    const artistButtons = renderer.root.findAll(
      (node) =>
        node.props?.accessibilityRole === 'button' &&
        node.props?.accessibilityLabel === 'Страница артиста Artist B',
    );
    expect(artistButtons).toHaveLength(0);

    expect(mockNavigation.navigate).not.toHaveBeenCalledWith(
      'ArtistDetail',
      expect.anything(),
    );
  });

  test('строки треков не являются интерактивными для навигации на артиста', async () => {
    const onPlayTrack = jest.fn();
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        album: {
          id: 'alb-3',
          title: 'Album 3',
          album_artist: 'Main Artist',
          artist_id: 'art_main',
          year: 2021,
        },
        tracks: [{ id: 'track-3', title: 'Song 3', artist: 'Guest Star' }],
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

    const guestText = renderer.root.findByProps({ children: 'Guest Star' });
    expect(guestText.parent.type).not.toBe('TouchableOpacity');

    const trackRow = renderer.root.findAllByProps({ activeOpacity: 0.6 })[0];
    await act(async () => {
      trackRow.props.onPress();
    });

    expect(onPlayTrack).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).not.toHaveBeenCalledWith(
      'ArtistDetail',
      expect.anything(),
    );
  });
});
