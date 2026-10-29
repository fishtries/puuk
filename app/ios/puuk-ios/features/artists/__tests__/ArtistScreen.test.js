import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ActivityIndicator } from 'react-native';
import ArtistScreen from '../ArtistScreen';
import { getArtistDetail } from '../../../shared/api/artists';

jest.mock(
  '../../../shared/api/artists',
  () => ({
    getArtistDetail: jest.fn(),
  }),
  { virtual: true },
);

jest.mock('../../../shared/api/api', () => ({
  SERVER_URL: 'https://puuk.app',
}));

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  return {
    useFocusEffect: (cb) => {
      React.useEffect(() => {
        return cb();
      }, [cb]);
    },
  };
});

describe('ArtistScreen', () => {
  const mockRoute = {
    params: {
      artistId: 'art_123',
    },
  };

  const mockNavigation = {
    navigate: jest.fn(),
    goBack: jest.fn(),
  };

  const sampleArtist = {
    id: 'art_123',
    name: 'Radiohead',
    track_count: 12,
    album_count: 2,
    artwork_version: 1,
    artwork_url: 'https://puuk.app/api/artists/art_123/artwork?v=1',
  };

  const sampleTracks = [
    {
      id: 'trk-1',
      title: 'Karma Police',
      artist: 'Radiohead',
      album: 'OK Computer',
      duration: 261,
      coverArt: 'https://puuk.app/api/cover/trk-1',
    },
    {
      id: 'trk-2',
      title: 'Paranoid Android',
      artist: 'Radiohead',
      album: 'OK Computer',
      duration: 383,
      coverArt: 'https://puuk.app/api/cover/trk-2',
    },
  ];

  const sampleAlbums = [
    {
      id: 'alb-1',
      title: 'OK Computer',
      album_artist: 'Radiohead',
      year: '1997',
      coverArt: 'https://puuk.app/api/cover/trk-1',
    },
    {
      id: 'alb-2',
      title: 'Kid A',
      album_artist: 'Radiohead',
      year: '2000',
      coverArt: 'https://puuk.app/api/cover/trk-3',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('admin can open exact artist correction and missing profile offers back', async () => {
    getArtistDetail.mockResolvedValueOnce({ artist: sampleArtist, popular_tracks: [], albums: [] });
    let renderer;
    await act(async () => { renderer = TestRenderer.create(<ArtistScreen route={mockRoute} navigation={mockNavigation} currentUser={{ role: 'admin' }} />); });
    act(() => renderer.root.findByProps({ testID: 'artist-bulk-button' }).props.onPress());
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ArtistCreditBulk', { artistId: 'art_123', artistName: 'Radiohead' });
    getArtistDetail.mockRejectedValueOnce({ status: 404 });
    await act(async () => { renderer = TestRenderer.create(<ArtistScreen route={mockRoute} navigation={mockNavigation} />); });
    expect(renderer.root.findByProps({ testID: 'not-found-state' })).toBeDefined();
    act(() => renderer.root.findAllByProps({ accessibilityLabel: 'Назад' }).filter((node) => typeof node.props.onPress === 'function').at(-1).props.onPress());
    expect(mockNavigation.goBack).toHaveBeenCalled();
    expect(getArtistDetail).toHaveBeenCalledTimes(2);
  });

  test('отображает индикатор загрузки при первом монтировании', async () => {
    let resolvePromise;
    getArtistDetail.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePromise = resolve;
      }),
    );

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    const loadingStates = renderer.root.findAllByProps({
      testID: 'loading-state',
    });
    expect(loadingStates.length).toBeGreaterThan(0);
    expect(renderer.root.findAllByType(ActivityIndicator).length).toBe(1);

    await act(async () => {
      resolvePromise({
        artist: sampleArtist,
        popular_tracks: sampleTracks,
        albums: sampleAlbums,
      });
    });

    expect(
      renderer.root.findAllByProps({ testID: 'loading-state' }).length,
    ).toBe(0);
  });

  test('загружает данные артиста, отображает имя, обложку, популярные треки и альбомы', async () => {
    getArtistDetail.mockResolvedValueOnce({
      artist: sampleArtist,
      popular_tracks: sampleTracks,
      albums: sampleAlbums,
    });

    const onPlayTrack = jest.fn();

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen
          route={mockRoute}
          navigation={mockNavigation}
          onPlayTrack={onPlayTrack}
        />,
      );
    });

    expect(getArtistDetail).toHaveBeenCalledWith(
      'art_123',
      expect.objectContaining({ signal: expect.any(Object) }),
    );

    // Header and hero display artist name
    expect(
      renderer.root.findAll((n) => n.props.children === 'Radiohead').length,
    ).toBeGreaterThan(0);

    // Artwork rendered with auth CoverImage conventions
    const artworkNode = renderer.root.findByProps({
      testID: 'artist-artwork',
    });
    expect(artworkNode.props.source).toBe(sampleArtist.artwork_url);

    // Stats rendered with Russian pluralization
    expect(
      renderer.root.findAll((n) => n.props.children === '12 треков · 2 альбома')
        .length,
    ).toBeGreaterThan(0);

    // Popular tracks rendered in order
    expect(
      renderer.root.findAll((n) => n.props.children === 'Karma Police').length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Paranoid Android')
        .length,
    ).toBeGreaterThan(0);

    // Press track row -> calls onPlayTrack with normalized track
    const firstTrackRow = renderer.root.findByProps({
      testID: 'track-row-trk-1',
    });
    await act(async () => {
      firstTrackRow.props.onPress();
    });

    expect(onPlayTrack).toHaveBeenCalledTimes(1);
    expect(onPlayTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'trk-1',
        title: 'Karma Police',
      }),
    );

    // Albums rendered and click navigates to Album screen with exact params
    const firstAlbumRow = renderer.root.findByProps({
      testID: 'album-row-alb-1',
    });
    await act(async () => {
      firstAlbumRow.props.onPress();
    });

    expect(mockNavigation.navigate).toHaveBeenCalledWith('Album', {
      albumId: 'alb-1',
      albumTitle: 'OK Computer',
      coverArt: 'https://puuk.app/api/cover/trk-1',
    });
  });

  test('ограничивает популярные треки первыми 10 треками от API', async () => {
    const manyTracks = Array.from({ length: 15 }, (_, i) => ({
      id: `trk-${i + 1}`,
      title: `Song ${i + 1}`,
      artist: 'Radiohead',
    }));

    getArtistDetail.mockResolvedValueOnce({
      artist: sampleArtist,
      popular_tracks: manyTracks,
      albums: [],
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    // Exactly 10 track rows rendered
    const renderedTrackIds = manyTracks
      .map((t) => t.id)
      .filter(
        (id) =>
          renderer.root.findAllByProps({ testID: `track-row-${id}` }).length >
          0,
      );
    expect(renderedTrackIds.length).toBe(10);
    expect(renderedTrackIds).toEqual([
      'trk-1',
      'trk-2',
      'trk-3',
      'trk-4',
      'trk-5',
      'trk-6',
      'trk-7',
      'trk-8',
      'trk-9',
      'trk-10',
    ]);

    for (let i = 1; i <= 10; i++) {
      expect(
        renderer.root.findAllByProps({ testID: `track-row-trk-${i}` }).length,
      ).toBeGreaterThan(0);
    }
    for (let i = 11; i <= 15; i++) {
      expect(
        renderer.root.findAllByProps({ testID: `track-row-trk-${i}` }).length,
      ).toBe(0);
    }
  });

  test('трек-строка не содержит ссылок на артиста', async () => {
    getArtistDetail.mockResolvedValueOnce({
      artist: sampleArtist,
      popular_tracks: sampleTracks,
      albums: [],
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    const trackRow = renderer.root.findByProps({ testID: 'track-row-trk-1' });
    const touchables = trackRow.findAllByType('TouchableOpacity');
    for (const t of touchables) {
      if (t.props.onPress) {
        await act(async () => {
          t.props.onPress();
        });
      }
    }
    expect(mockNavigation.navigate).not.toHaveBeenCalledWith(
      'Artist',
      expect.anything(),
    );
    expect(mockNavigation.navigate).not.toHaveBeenCalledWith(
      'ArtistDetail',
      expect.anything(),
    );
  });

  test('кнопка редактирования артиста видна только для admin роли', async () => {
    getArtistDetail.mockResolvedValue({
      artist: sampleArtist,
      popular_tracks: [],
      albums: [],
    });

    // 1. Обычный пользователь (role: 'user')
    let rendererUser;
    await act(async () => {
      rendererUser = TestRenderer.create(
        <ArtistScreen
          route={mockRoute}
          navigation={mockNavigation}
          currentUser={{ id: 2, role: 'user' }}
        />,
      );
    });
    expect(
      rendererUser.root.findAllByProps({ testID: 'artist-admin-edit-button' })
        .length,
    ).toBe(0);

    // 2. Без авторизации (currentUser = null)
    let rendererAnon;
    await act(async () => {
      rendererAnon = TestRenderer.create(
        <ArtistScreen
          route={mockRoute}
          navigation={mockNavigation}
          currentUser={null}
        />,
      );
    });
    expect(
      rendererAnon.root.findAllByProps({ testID: 'artist-admin-edit-button' })
        .length,
    ).toBe(0);

    // 3. Администратор (role: 'admin')
    let rendererAdmin;
    await act(async () => {
      rendererAdmin = TestRenderer.create(
        <ArtistScreen
          route={mockRoute}
          navigation={mockNavigation}
          currentUser={{ id: 1, role: 'admin' }}
        />,
      );
    });
    const editBtn = rendererAdmin.root.findByProps({
      testID: 'artist-admin-edit-button',
    });
    expect(editBtn).toBeDefined();

    await act(async () => {
      editBtn.props.onPress();
    });
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ArtistEdit', {
      artistId: 'art_123',
      artist: sampleArtist,
    });
  });

  test('состояние no-artwork при отсутствии artwork_url', async () => {
    getArtistDetail.mockResolvedValueOnce({
      artist: {
        ...sampleArtist,
        artwork_url: null,
      },
      popular_tracks: [],
      albums: [],
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    expect(
      renderer.root.findAllByProps({ testID: 'artist-artwork' }).length,
    ).toBe(0);
    expect(
      renderer.root.findAllByProps({ testID: 'artist-no-artwork' }).length,
    ).toBeGreaterThan(0);
  });

  test('состояние no-tracks при действительном отсутствии треков (track_count === 0)', async () => {
    getArtistDetail.mockResolvedValueOnce({
      artist: {
        ...sampleArtist,
        track_count: 0,
      },
      popular_tracks: [],
      albums: sampleAlbums,
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    expect(
      renderer.root.findAllByProps({ testID: 'no-tracks-state' }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Нет треков').length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Нет популярных треков'),
    ).toHaveLength(0);
  });

  test('состояние no-popular-tracks при наличии треков (track_count > 0), но пустом top-10 (cold-start)', async () => {
    getArtistDetail.mockResolvedValueOnce({
      artist: {
        ...sampleArtist,
        track_count: 12,
      },
      popular_tracks: [],
      albums: sampleAlbums,
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    expect(
      renderer.root.findAllByProps({ testID: 'no-popular-tracks-state' }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Нет популярных треков')
        .length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Нет треков'),
    ).toHaveLength(0);

    // Не отображает буквальные нулевые просмотры/прослушивания
    const zeroPlayCounts = renderer.root.findAll((n) => {
      const text = typeof n.props.children === 'string' ? n.props.children : '';
      return (
        text.includes('0 просмотров') ||
        text.includes('0 прослушиваний') ||
        text.includes('0 воспроизведений') ||
        text.includes('0 plays')
      );
    });
    expect(zeroPlayCounts).toHaveLength(0);
  });

  test('состояние no-albums при пустом списке альбомов', async () => {
    getArtistDetail.mockResolvedValueOnce({
      artist: sampleArtist,
      popular_tracks: sampleTracks,
      albums: [],
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    expect(
      renderer.root.findAllByProps({ testID: 'no-albums-state' }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Нет альбомов').length,
    ).toBeGreaterThan(0);
  });

  test('состояние ошибки и кнопка повтора (retry) при сетевой ошибке', async () => {
    getArtistDetail
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({
        artist: sampleArtist,
        popular_tracks: sampleTracks,
        albums: sampleAlbums,
      });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    expect(
      renderer.root.findAllByProps({ testID: 'error-state' }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll(
        (n) => n.props.children === 'Network request failed',
      ).length,
    ).toBeGreaterThan(0);

    // Press retry button
    const retryBtn = renderer.root.findByProps({
      accessibilityLabel: 'Повторить',
    });
    await act(async () => {
      retryBtn.props.onPress();
    });

    expect(getArtistDetail).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByProps({ testID: 'error-state' }).length).toBe(
      0,
    );
    expect(
      renderer.root.findAll((n) => n.props.children === 'Radiohead').length,
    ).toBeGreaterThan(0);
  });

  test('состояние not-found при ошибке 404', async () => {
    const error404 = new Error('HTTP 404: Not found');
    error404.status = 404;
    getArtistDetail.mockRejectedValueOnce(error404);

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    expect(
      renderer.root.findAllByProps({ testID: 'not-found-state' }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Артист не найден')
        .length,
    ).toBeGreaterThan(0);

    // Back button in not found state triggers navigation.goBack()
    const backBtn = renderer.root.findByProps({
      testID: 'artist-back-button',
    });
    await act(async () => {
      backBtn.props.onPress();
    });
    expect(mockNavigation.goBack).toHaveBeenCalled();
  });

  test('состояние not-found при отсутствии artistId в route.params', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={{ params: {} }} navigation={mockNavigation} />,
      );
    });

    expect(
      renderer.root.findAllByProps({ testID: 'not-found-state' }).length,
    ).toBeGreaterThan(0);
    expect(getArtistDetail).not.toHaveBeenCalled();
  });

  test('состояние offline и повтор запроса при недоступности сети', async () => {
    const offlineErr = new Error('The Internet connection appears to be offline');
    offlineErr.type = 'offline';
    getArtistDetail
      .mockRejectedValueOnce(offlineErr)
      .mockResolvedValueOnce({
        artist: sampleArtist,
        popular_tracks: sampleTracks,
        albums: sampleAlbums,
      });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen route={mockRoute} navigation={mockNavigation} />,
      );
    });

    expect(
      renderer.root.findAllByProps({ testID: 'offline-state' }).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Сеть недоступна')
        .length,
    ).toBeGreaterThan(0);

    const retryBtn = renderer.root.findByProps({
      accessibilityLabel: 'Повторить',
    });
    await act(async () => {
      retryBtn.props.onPress();
    });

    expect(getArtistDetail).toHaveBeenCalledTimes(2);
    expect(
      renderer.root.findAllByProps({ testID: 'offline-state' }).length,
    ).toBe(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Radiohead').length,
    ).toBeGreaterThan(0);
  });

  test('cold start popularity: детерминированный порядок без буквальной надписи 0 просмотров', async () => {
    const coldStartTracks = [
      {
        id: 'trk-cold-1',
        title: 'Alpha Song',
        artist: 'Cold Artist',
        album: 'Album Cold',
        duration: 180,
        play_count: 0,
      },
      {
        id: 'trk-cold-2',
        title: 'Beta Song',
        artist: 'Cold Artist',
        album: 'Album Cold',
        duration: 200,
        play_count: 0,
      },
    ];

    getArtistDetail.mockResolvedValueOnce({
      artist: {
        id: 'art_cold',
        name: 'Cold Artist',
        track_count: 2,
        album_count: 1,
        artwork_url: null,
      },
      popular_tracks: coldStartTracks,
      albums: [],
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen
          route={{ params: { artistId: 'art_cold' } }}
          navigation={mockNavigation}
        />,
      );
    });

    // Треки отрендерены в порядке, возвращённом API
    expect(
      renderer.root.findAll((n) => n.props.children === 'Alpha Song').length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Beta Song').length,
    ).toBeGreaterThan(0);

    // Нигде не должно быть буквальной надписи "0 просмотров" или "0 прослушиваний"
    const zeroViews = renderer.root.findAll((n) => {
      const text = typeof n.props.children === 'string' ? n.props.children : '';
      return (
        text.includes('0 просмотров') ||
        text.includes('0 прослушиваний') ||
        text.includes('0 воспроизведений') ||
        text.includes('0 plays')
      );
    });
    expect(zeroViews).toHaveLength(0);
  });

  test('отмена устаревших запросов при переключении артиста и размонтировании (cancellation)', async () => {
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    let resolveSecond;
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    getArtistDetail
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise);

    let renderer;
    // 1. Открываем первого артиста
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen
          route={{ params: { artistId: 'art_first' } }}
          navigation={mockNavigation}
        />,
      );
    });

    expect(getArtistDetail).toHaveBeenCalledWith('art_first', expect.anything());
    const firstCallSignal = getArtistDetail.mock.calls[0][1]?.signal;
    expect(firstCallSignal).toBeDefined();
    expect(firstCallSignal.aborted).toBe(false);

    // 2. Переключаем на второго артиста до завершения первого запроса (re-query)
    await act(async () => {
      renderer.update(
        <ArtistScreen
          route={{ params: { artistId: 'art_second' } }}
          navigation={mockNavigation}
        />,
      );
    });

    expect(getArtistDetail).toHaveBeenCalledWith('art_second', expect.anything());
    const secondCallSignal = getArtistDetail.mock.calls[1][1]?.signal;
    expect(secondCallSignal).toBeDefined();
    expect(secondCallSignal.aborted).toBe(false);

    // Assert: сигнал первого запроса прерван при повторном запросе (re-query abort)
    expect(firstCallSignal.aborted).toBe(true);

    // 3. Второй (актуальный) запрос завершается
    await act(async () => {
      resolveSecond({
        artist: {
          id: 'art_second',
          name: 'Second Artist',
          track_count: 5,
          album_count: 1,
        },
        popular_tracks: [],
        albums: [],
      });
    });

    expect(
      renderer.root.findAll((n) => n.props.children === 'Second Artist').length,
    ).toBeGreaterThan(0);

    // 4. Первый (устаревший) запрос завершается позже
    await act(async () => {
      resolveFirst({
        artist: {
          id: 'art_first',
          name: 'First Artist',
          track_count: 10,
          album_count: 2,
        },
        popular_tracks: [],
        albums: [],
      });
    });

    // Устаревший ответ не перезаписывает новый экран
    expect(
      renderer.root.findAll((n) => n.props.children === 'First Artist'),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll((n) => n.props.children === 'Second Artist').length,
    ).toBeGreaterThan(0);

    // 5. Размонтирование компонента прерывает сигнал активного контроллера (unmount abort)
    await act(async () => {
      renderer.unmount();
    });
    expect(secondCallSignal.aborted).toBe(true);
  });

  test('сигнал AbortController прерывается при размонтировании экрана с запросом в полете', async () => {
    let resolvePending;
    const pendingPromise = new Promise((resolve) => {
      resolvePending = resolve;
    });

    getArtistDetail.mockImplementationOnce(() => pendingPromise);

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen
          route={{ params: { artistId: 'art_inflight' } }}
          navigation={mockNavigation}
        />,
      );
    });

    expect(getArtistDetail).toHaveBeenCalledWith('art_inflight', expect.anything());
    const inFlightSignal = getArtistDetail.mock.calls[0][1]?.signal;
    expect(inFlightSignal).toBeDefined();
    expect(inFlightSignal.aborted).toBe(false);

    // Размонтируем экран
    await act(async () => {
      renderer.unmount();
    });

    // Assert: сигнал прерван при размонтировании (unmount abort)
    expect(inFlightSignal.aborted).toBe(true);

    // Завершаем промис, чтобы очистить асинхронную ссылку
    resolvePending(null);
  });

  test('длинные имена и названия имеют стили и атрибуты обрезки с ellipsis', async () => {
    const longArtistName =
      'A Super Extremely Long Artist Name That Must Be Ellipsized In Header And Hero View';
    const longTrackTitle =
      'A Very Long Track Title That Exceeds Display Boundaries';
    const longAlbumTitle =
      'A Very Long Album Title In The Discography Section';

    getArtistDetail.mockResolvedValueOnce({
      artist: {
        id: 'art_long',
        name: longArtistName,
        track_count: 1,
        album_count: 1,
        artwork_url: null,
      },
      popular_tracks: [
        {
          id: 'trk_long',
          title: longTrackTitle,
          artist: longArtistName,
          album: 'Separate Track Album',
          duration: 120,
        },
      ],
      albums: [
        {
          id: 'alb_long',
          title: longAlbumTitle,
          album_artist: longArtistName,
          year: 2024,
          coverArt: null,
        },
      ],
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ArtistScreen
          route={{ params: { artistId: 'art_long' } }}
          navigation={mockNavigation}
        />,
      );
    });

    // Header title
    const headerTitle = renderer.root.findByProps({
      testID: 'artist-header-title',
    });
    expect(headerTitle.props.ellipsizeMode).toBe('tail');
    expect(headerTitle.props.numberOfLines).toBe(1);

    // Hero artist name
    const heroName = renderer.root.findByProps({
      testID: 'artist-hero-name',
    });
    expect(heroName.props.ellipsizeMode).toBe('tail');
    expect(heroName.props.numberOfLines).toBe(2);

    // Track title
    const trackTitle = renderer.root.findByProps({ children: longTrackTitle });
    expect(trackTitle.props.ellipsizeMode).toBe('tail');
    expect(trackTitle.props.numberOfLines).toBe(1);

    // Album title
    const albumTitle = renderer.root.findByProps({ children: longAlbumTitle });
    expect(albumTitle.props.ellipsizeMode).toBe('tail');
    expect(albumTitle.props.numberOfLines).toBe(1);
  });

  test('маршрутизация работает по artistId и поддерживает legacy id fallback', async () => {
    getArtistDetail.mockResolvedValue({
      artist: sampleArtist,
      popular_tracks: [],
      albums: [],
    });

    // 1. По canonical artistId (contract D-8 & 6.1)
    let renderer1;
    await act(async () => {
      renderer1 = TestRenderer.create(
        <ArtistScreen
          route={{ params: { artistId: 'art_stable_456' } }}
          navigation={mockNavigation}
        />,
      );
    });
    expect(getArtistDetail).toHaveBeenCalledWith('art_stable_456', expect.anything());

    // 2. По legacy id
    let renderer2;
    await act(async () => {
      renderer2 = TestRenderer.create(
        <ArtistScreen
          route={{ params: { id: 'art_legacy_789' } }}
          navigation={mockNavigation}
        />,
      );
    });
    expect(getArtistDetail).toHaveBeenCalledWith('art_legacy_789', expect.anything());
  });
});
