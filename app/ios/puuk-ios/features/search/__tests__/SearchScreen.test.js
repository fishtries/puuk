import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { TextInput, TouchableOpacity, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import SearchScreen from '../SearchScreen';
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

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Comp) => Comp,
      View,
    },
    FadeIn: {
      duration: () => ({}),
    },
    FadeInDown: {
      duration: () => ({ delay: () => ({}) }),
      delay: () => ({ duration: () => ({}) }),
    },
    FadeInRight: {
      duration: () => ({ delay: () => ({}) }),
      delay: () => ({ duration: () => ({}) }),
    },
    LinearTransition: {
      springify: () => ({}),
    },
  };
});

describe('SearchScreen - Stage 8 Slice 4 track normalization & identity', () => {
  const mockNavigation = {
    navigate: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('нормализует legacy track_id, сохраняет все поля и генерирует fallback coverArt', async () => {
    const onPlayTrack = jest.fn();
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tracks: [
          {
            track_id: 'legacy-search-99',
            title: 'Legacy Search Track',
            artist: 'Search Artist',
            album: 'Search Album',
            bpm: 124,
            year: 2021,
            custom_field: 'preserved_val',
          },
        ],
        albums: [],
        artists: [],
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SearchScreen navigation={mockNavigation} onPlayTrack={onPlayTrack} />,
      );
    });

    // Enter search query
    const input = renderer.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText('legacy');
      jest.advanceTimersByTime(400); // 350ms debounce
    });

    // Verify rendered track
    expect(
      renderer.root.findAll((n) => n.props.children === 'Legacy Search Track')
        .length,
    ).toBeGreaterThan(0);

    // Verify fallback coverArt
    const coverImage = renderer.root.findByProps({
      source: 'https://puuk.app/api/cover/legacy-search-99',
    });
    expect(coverImage).toBeDefined();

    // Verify onPlayTrack receives canonical track with preserved fields
    const trackRowTouchable = renderer.root.findAllByProps({
      activeOpacity: 0.65,
    })[0];
    await act(async () => {
      trackRowTouchable.props.onPress();
    });

    expect(onPlayTrack).toHaveBeenCalledTimes(1);
    const playedTrack = onPlayTrack.mock.calls[0][0];
    expect(playedTrack.id).toBe('legacy-search-99');
    expect(playedTrack.track_id).toBe('legacy-search-99');
    expect(playedTrack.album).toBe('Search Album');
    expect(playedTrack.bpm).toBe(124);
    expect(playedTrack.year).toBe(2021);
    expect(playedTrack.custom_field).toBe('preserved_val');
    expect(playedTrack.coverArt).toBe(
      'https://puuk.app/api/cover/legacy-search-99',
    );
  });

  test('корректно формирует fallback coverArt для трека с числовым ID 0', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 0,
          title: 'Zero Search Track',
          artist: 'Zero Artist',
        },
      ],
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SearchScreen navigation={mockNavigation} />,
      );
    });

    const input = renderer.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText('zero');
      jest.advanceTimersByTime(400);
    });

    expect(
      renderer.root.findAll((n) => n.props.children === 'Zero Search Track')
        .length,
    ).toBeGreaterThan(0);
    const coverImage = renderer.root.findByProps({
      source: 'https://puuk.app/api/cover/0',
    });
    expect(coverImage).toBeDefined();
  });

  test('отсутствующие ID не считаются играющими при невалидном currentTrack, а совпадающие ID подсвечиваются', async () => {
    authFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tracks: [
          {
            id: 'search-playing',
            title: 'Playing Search Song',
            artist: 'Artist',
          },
          { id: 'search-other', title: 'Other Search Song', artist: 'Artist' },
        ],
        albums: [],
        artists: [],
      }),
    });

    // 1. С невалидным currentTrack ({ id: null })
    let rendererInvalid;
    await act(async () => {
      rendererInvalid = TestRenderer.create(
        <SearchScreen
          navigation={mockNavigation}
          currentTrack={{ id: null }}
          isPlaying={true}
        />,
      );
    });

    const inputInvalid = rendererInvalid.root.findByType(TextInput);
    await act(async () => {
      inputInvalid.props.onChangeText('song');
      jest.advanceTimersByTime(400);
    });

    // Ни один трек не должен показывать иконку громкости (активного воспроизведения)
    const volumeIconsInvalid = rendererInvalid.root.findAll(
      (n) => n.type === Ionicons && n.props.name === 'volume-high',
    );
    expect(volumeIconsInvalid).toHaveLength(0);

    // Ни один трек не должен иметь цвет подсвеченного заголовка
    const titleInvalid = rendererInvalid.root.findByProps({
      children: 'Playing Search Song',
    });
    expect(titleInvalid.props.style).not.toContainEqual(
      expect.objectContaining({ color: '#FFDAB9' }),
    );

    // 2. С валидным currentTrack в форме track_id, совпадающим с canonical id
    let rendererPlaying;
    await act(async () => {
      rendererPlaying = TestRenderer.create(
        <SearchScreen
          navigation={mockNavigation}
          currentTrack={{ track_id: 'search-playing' }}
          isPlaying={true}
        />,
      );
    });

    const inputPlaying = rendererPlaying.root.findByType(TextInput);
    await act(async () => {
      inputPlaying.props.onChangeText('song');
      jest.advanceTimersByTime(400);
    });

    // Трек с совпадающим ID показывает иконку громкости
    const volumeIconsValid = rendererPlaying.root.findAll(
      (n) => n.type === Ionicons && n.props.name === 'volume-high',
    );
    expect(volumeIconsValid).toHaveLength(1);

    // Заголовок играющего трека подсвечен
    const titlePlaying = rendererPlaying.root.findByProps({
      children: 'Playing Search Song',
    });
    expect(titlePlaying.props.style).toContainEqual(
      expect.objectContaining({ color: '#FFDAB9' }),
    );

    // Неиграющий трек не подсвечен
    const titleOther = rendererPlaying.root.findByProps({
      children: 'Other Search Song',
    });
    expect(titleOther.props.style).not.toContainEqual(
      expect.objectContaining({ color: '#FFDAB9' }),
    );
  });

  test('игнорирует записи без валидного идентификатора в результатах поиска', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        tracks: [
          null,
          {},
          { id: '' },
          { id: '   ' },
          { id: 'valid-search-1', title: 'Only Valid Track' },
        ],
        albums: [],
        artists: [],
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SearchScreen navigation={mockNavigation} />,
      );
    });

    const input = renderer.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText('valid');
      jest.advanceTimersByTime(400);
    });

    const validNode = renderer.root.findByProps({
      children: 'Only Valid Track',
    });
    expect(validNode).toBeDefined();

    const trackCovers = renderer.root.findAllByType('CoverImage');
    expect(trackCovers).toHaveLength(1);
  });

  test('переходит в ArtistDetail по stable artist_id вместо повторного поиска, сохраняя запрос и результаты', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        artists: [{ id: 'art_123', artist_id: 'art_123', name: 'Artist A', track_count: 2 }],
        albums: [],
        tracks: [],
      }),
    });
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<SearchScreen navigation={mockNavigation} />);
    });
    const input = renderer.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText('artist');
      jest.advanceTimersByTime(400);
    });
    const artistCard = renderer.root.findAllByProps({ activeOpacity: 0.7 })[0];
    await act(async () => artistCard.props.onPress());

    // Проверяем навигацию с artistId (контракт 6.2)
    expect(mockNavigation.navigate).toHaveBeenCalledWith('ArtistDetail', { artistId: 'art_123' });
    // Повторный поиск запрещён: authFetch вызван ровно 1 раз
    expect(authFetch).toHaveBeenCalledTimes(1);
    // Запрос в строке поиска и результаты сохранились
    expect(renderer.root.findByType(TextInput).props.value).toBe('artist');
    expect(renderer.root.findAllByProps({ children: 'Artist A' }).length).toBeGreaterThan(0);
  });

  test('устаревший ответ не может перезаписать более новый поисковый запрос (debounce & cancellation)', async () => {
    let resolveFirst;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    let resolveSecond;
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    authFetch
      .mockImplementationOnce(() => firstPromise)
      .mockImplementationOnce(() => secondPromise);

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<SearchScreen navigation={mockNavigation} />);
    });

    const input = renderer.root.findByType(TextInput);

    // 1. Вводим первый запрос "art"
    await act(async () => {
      input.props.onChangeText('art');
      jest.advanceTimersByTime(400);
    });
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(authFetch.mock.calls[0][0]).toContain('q=art');

    // 2. Вводим второй запрос "radio"
    await act(async () => {
      input.props.onChangeText('radio');
      jest.advanceTimersByTime(400);
    });
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(authFetch.mock.calls[1][0]).toContain('q=radio');

    // 3. Второй (актуальный) запрос завершается раньше первого
    await act(async () => {
      resolveSecond({
        ok: true,
        status: 200,
        json: async () => ({
          artists: [{ id: 'art_radio', artist_id: 'art_radio', name: 'Radiohead', track_count: 50 }],
          albums: [],
          tracks: [],
        }),
      });
    });

    expect(renderer.root.findAllByProps({ children: 'Radiohead' }).length).toBeGreaterThan(0);

    // 4. Первый (устаревший) запрос завершается позже
    await act(async () => {
      resolveFirst({
        ok: true,
        status: 200,
        json: async () => ({
          artists: [{ id: 'art_stale', artist_id: 'art_stale', name: 'Stale Artist', track_count: 1 }],
          albums: [],
          tracks: [],
        }),
      });
    });

    // Устаревший ответ не должен перезаписать результаты более нового запроса
    expect(renderer.root.findAllByProps({ children: 'Stale Artist' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ children: 'Radiohead' }).length).toBeGreaterThan(0);
  });

  test('очистка поиска отменяет устаревший ответ и не даёт ему отрисовать результаты', async () => {
    let resolveSearch;
    const pendingPromise = new Promise((resolve) => {
      resolveSearch = resolve;
    });

    authFetch.mockImplementationOnce(() => pendingPromise);

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<SearchScreen navigation={mockNavigation} />);
    });

    const input = renderer.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText('slow');
      jest.advanceTimersByTime(400);
    });
    expect(authFetch).toHaveBeenCalledTimes(1);

    // Очищаем поиск кнопкой сброса
    const clearBtn = renderer.root.findByProps({ accessibilityLabel: 'Clear search' });
    await act(async () => {
      clearBtn.props.onPress();
    });

    // Теперь медленный ответ возвращается
    await act(async () => {
      resolveSearch({
        ok: true,
        status: 200,
        json: async () => ({
          artists: [{ id: 'art_slow', artist_id: 'art_slow', name: 'Slow Artist', track_count: 1 }],
          albums: [],
          tracks: [],
        }),
      });
    });

    // Результаты очищены, стартовый экран отображается
    expect(renderer.root.findAllByProps({ children: 'Slow Artist' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ children: 'Find your music' }).length).toBeGreaterThan(0);
  });

  test('чётко разделяет пустое состояние и состояние ошибки с возможностью повтора', async () => {
    // 1. Пустой результат
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        artists: [],
        albums: [],
        tracks: [],
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<SearchScreen navigation={mockNavigation} />);
    });

    const input = renderer.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText('unknown');
      jest.advanceTimersByTime(400);
    });

    expect(renderer.root.findAllByProps({ testID: 'empty-state' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ children: 'No results found' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'error-state' })).toHaveLength(0);

    // 2. Ошибка сервера (HTTP 500)
    authFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    await act(async () => {
      input.props.onChangeText('error-query');
      jest.advanceTimersByTime(400);
    });

    expect(renderer.root.findAllByProps({ testID: 'error-state' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ children: 'Search unavailable' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'empty-state' })).toHaveLength(0);

    // 3. Повтор поиска (Try again)
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        artists: [{ id: 'art_recovered', artist_id: 'art_recovered', name: 'Recovered Artist', track_count: 3 }],
        albums: [],
        tracks: [],
      }),
    });

    const retryBtn = renderer.root.findByProps({ accessibilityLabel: 'Retry search' });
    await act(async () => {
      retryBtn.props.onPress();
    });

    expect(renderer.root.findAllByProps({ testID: 'error-state' }).length).toBe(0);
    expect(renderer.root.findAllByProps({ children: 'Recovered Artist' }).length).toBeGreaterThan(0);
  });

  test('содержит доступные подписи (accessibility) и стили для обрезки длинных имён', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        artists: [
          {
            id: 'art_long',
            artist_id: 'art_long',
            name: 'A Very Long Artist Name That Should Ellipsize Cleanly Without Overlapping Layout',
            track_count: 10,
          },
        ],
        albums: [
          {
            id: 'alb_long',
            title: 'A Very Long Album Title That Exceeds Container Width',
            artist: 'Album Artist',
            coverArt: 'https://puuk.app/cover.jpg',
          },
        ],
        tracks: [
          {
            id: 'trk_long',
            title: 'A Very Long Track Title That Should Truncate',
            artist: 'Track Artist',
          },
        ],
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<SearchScreen navigation={mockNavigation} />);
    });

    const input = renderer.root.findByType(TextInput);
    expect(input.props.accessibilityLabel).toBe('Search music');

    await act(async () => {
      input.props.onChangeText('long');
      jest.advanceTimersByTime(400);
    });

    // ArtistCard
    const artistCard = renderer.root.findByProps({ testID: 'artist-card-art_long' });
    expect(artistCard.props.accessibilityRole).toBe('button');
    expect(artistCard.props.accessibilityLabel).toContain('A Very Long Artist Name');
    expect(artistCard.props.accessibilityLabel).toContain('10 tracks');

    const artistNameText = renderer.root.findByProps({
      children: 'A Very Long Artist Name That Should Ellipsize Cleanly Without Overlapping Layout',
    });
    expect(artistNameText.props.numberOfLines).toBe(1);
    expect(artistNameText.props.ellipsizeMode).toBe('tail');

    // AlbumCard
    const albumCard = renderer.root.findByProps({ testID: 'album-card-alb_long' });
    expect(albumCard.props.accessibilityRole).toBe('button');
    expect(albumCard.props.accessibilityLabel).toBe('Album A Very Long Album Title That Exceeds Container Width by Album Artist');

    const albumTitleText = renderer.root.findByProps({
      children: 'A Very Long Album Title That Exceeds Container Width',
    });
    expect(albumTitleText.props.numberOfLines).toBe(1);
    expect(albumTitleText.props.ellipsizeMode).toBe('tail');

    // TrackRow
    const trackTitleText = renderer.root.findByProps({
      children: 'A Very Long Track Title That Should Truncate',
    });
    expect(trackTitleText.props.numberOfLines).toBe(1);
    expect(trackTitleText.props.ellipsizeMode).toBe('tail');

    // Clear button
    const clearBtn = renderer.root.findByProps({ accessibilityLabel: 'Clear search' });
    expect(clearBtn.props.accessibilityRole).toBe('button');
  });
});
