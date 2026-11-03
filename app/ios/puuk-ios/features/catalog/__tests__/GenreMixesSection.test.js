import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import GenreMixesSection, {
  GenreMixCard,
  formatMixTitle,
} from '../GenreMixesSection';
import { fetchPersonalizedRecommendations } from '../../../shared/api/recommendations';

jest.mock('../../../shared/api/recommendations', () => ({
  fetchPersonalizedRecommendations: jest.fn(),
}));

jest.mock('../../../shared/storage/settings', () => ({
  getSettings: jest.fn(() => ({ accentColor: '#FFDAB9', hapticsEnabled: true })),
  addSettingsListener: jest.fn(() => () => {}),
}));

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Comp) => Comp,
      View,
    },
    FadeInRight: {
      delay: () => ({
        duration: () => ({}),
      }),
    },
  };
});

describe('GenreMixesSection', () => {
  const mockNavigation = {
    navigate: jest.fn(),
  };

  const sampleSections = [
    {
      id: 'genre-rock',
      type: 'genre',
      title: 'Rock for you',
      genre: 'Rock',
      description: 'Personalized Rock mix',
      tracks: [
        {
          id: 'tr-1',
          title: 'Rock Anthem',
          artist: 'Rocker',
          coverArt: 'https://puuk.app/cov1.jpg',
        },
      ],
    },
    {
      id: 'genre-electronic',
      type: 'genre',
      title: 'Electronic for you',
      genre: 'Electronic',
      description: 'Personalized Electronic mix',
      tracks: [
        {
          id: 'tr-2',
          title: 'Synth Drift',
          artist: 'Electro',
          coverArt: 'https://puuk.app/cov2.jpg',
        },
      ],
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('formatMixTitle helper', () => {
    test('formats genre title to "<Genre> Mix"', () => {
      expect(formatMixTitle({ genre: 'rock' })).toBe('Rock Mix');
      expect(formatMixTitle({ genre: 'Ambient' })).toBe('Ambient Mix');
    });

    test('falls back to section.title if genre is missing', () => {
      expect(formatMixTitle({ title: 'My Custom Mix' })).toBe('My Custom Mix');
    });

    test('returns "Mix" if section is empty', () => {
      expect(formatMixTitle(null)).toBe('Mix');
      expect(formatMixTitle({})).toBe('Mix');
    });
  });

  test('returns null when sections list is empty', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <GenreMixesSection sections={[]} />,
      );
    });

    expect(renderer.toJSON()).toBeNull();
  });

  test('renders section header with "made for you" caption', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <GenreMixesSection
          sections={sampleSections}
          navigation={mockNavigation}
        />,
      );
    });

    const root = renderer.root;
    const texts = root.findAllByType(Text).map((t) => t.props.children);

    expect(texts).toContain('Genre Mixes');
    expect(texts).toContain('made for you');
  });

  test('renders cards for each genre mix with "made for you" subtitle', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <GenreMixesSection
          sections={sampleSections}
          navigation={mockNavigation}
        />,
      );
    });

    const root = renderer.root;
    const cards = root.findAllByType(TouchableOpacity).filter((t) => t.props.testID && t.props.testID.startsWith('genre-mix-card'));
    expect(cards).toHaveLength(2);

    const texts = root.findAllByType(Text).map((t) => t.props.children);
    expect(texts).toContain('Rock Mix');
    expect(texts).toContain('Electronic Mix');

    // Both cards and section header have "made for you"
    const madeForYouMatches = texts.filter((t) => t === 'made for you');
    expect(madeForYouMatches.length).toBeGreaterThanOrEqual(3);
  });

  test('tapping card navigates to Playlist screen with preloaded tracks and made for you subtitle', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <GenreMixesSection
          sections={sampleSections}
          navigation={mockNavigation}
        />,
      );
    });

    const root = renderer.root;
    const firstCard = root.findByProps({ testID: 'genre-mix-card-genre-rock' });

    act(() => {
      firstCard.props.onPress();
    });

    expect(mockNavigation.navigate).toHaveBeenCalledWith('Playlist', {
      playlistId: 'genre-rock',
      playlistName: 'Rock Mix',
      tracks: sampleSections[0].tracks,
      subtitle: 'made for you',
      coverArt: 'https://puuk.app/cov1.jpg',
      isReadOnly: true,
    });
  });

  test('tapping play button overlay starts playback of the mix', () => {
    const onPlayTrackListMock = jest.fn();
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <GenreMixesSection
          sections={sampleSections}
          navigation={mockNavigation}
          onPlayTrackList={onPlayTrackListMock}
        />,
      );
    });

    const root = renderer.root;
    const playBtn = root.findByProps({ testID: 'genre-mix-play-genre-rock' });

    act(() => {
      playBtn.props.onPress({ stopPropagation: jest.fn() });
    });

    expect(onPlayTrackListMock).toHaveBeenCalledWith(sampleSections[0].tracks, 0);
  });

  test('fetches recommendations on mount when currentUser is provided', async () => {
    fetchPersonalizedRecommendations.mockResolvedValueOnce({
      sections: sampleSections,
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <GenreMixesSection
          currentUser={{ id: 42, username: 'tester' }}
          navigation={mockNavigation}
        />,
      );
    });

    expect(fetchPersonalizedRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, sections: 3 }),
    );

    const root = renderer.root;
    const cards = root.findAllByType(TouchableOpacity).filter((t) => t.props.testID && t.props.testID.startsWith('genre-mix-card'));
    expect(cards).toHaveLength(2);
  });

  test('renders fallback cover when no coverArt is available on tracks', () => {
    const sectionWithoutCover = [
      {
        id: 'genre-jazz',
        genre: 'Jazz',
        tracks: [{ id: 'tr-jazz', title: 'Jazz Tune', artist: 'Miles' }],
      },
    ];

    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <GenreMixesSection
          sections={sectionWithoutCover}
          navigation={mockNavigation}
        />,
      );
    });

    const root = renderer.root;
    const texts = root.findAllByType(Text).map((t) => t.props.children);
    expect(texts).toContain('Jazz Mix');
    expect(texts).toContain('Jazz');
  });
});
