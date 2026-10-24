import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { TextInput, TouchableOpacity } from 'react-native';
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
});
