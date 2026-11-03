import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DeviceEventEmitter, TouchableOpacity, Text, FlatList } from 'react-native';
import HomeScreen from '../HomeScreen';
import YourMixCard from '../YourMixCard';
import { useRecentlyListened } from '../useRecentlyListened';

jest.mock('../useRecentlyListened', () => ({
  useRecentlyListened: jest.fn(() => ({
    tracks: [],
    isLoading: false,
    refresh: jest.fn(),
  })),
}));

jest.mock('../YourMixCard', () => {
  const { View } = require('react-native');
  return jest.fn((props) => <View {...props} testID="mock-your-mix-card" />);
});

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Comp) => Comp,
      View,
      Text,
    },
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    withSpring: (to) => to,
    withTiming: (to) => to,
    FadeInDown: {
      delay: () => ({
        duration: () => ({}),
      }),
    },
    FadeInRight: {
      delay: () => ({
        duration: () => ({}),
      }),
    },
  };
});

jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Medium: 'medium' },
}));

describe('HomeScreen', () => {
  const mockTracks = [
    {
      id: 'tr-1',
      title: 'Song One',
      artist: 'Artist One',
      coverArt: 'https://puuk.app/cov1.jpg',
    },
    {
      id: 'tr-2',
      title: 'Song Two',
      artist: 'Artist Two',
      coverArt: 'https://puuk.app/cov2.jpg',
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders YourMixCard and tracks list directly below it', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <HomeScreen
          tracks={mockTracks}
          isPlaying={false}
          currentTrack={null}
          onStartWave={() => {}}
        />,
      );
    });

    const root = renderer.root;
    const card = root.findByType(YourMixCard);
    expect(card).toBeTruthy();

    const texts = root.findAllByType(Text);
    const hasSongOne = texts.some((t) => t.props.children === 'Song One');
    const hasSongTwo = texts.some((t) => t.props.children === 'Song Two');
    expect(hasSongOne).toBe(true);
    expect(hasSongTwo).toBe(true);
  });

  test('passes onPlayTrack when a track row is tapped', () => {
    const onPlayTrackMock = jest.fn();
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <HomeScreen
          tracks={mockTracks}
          isPlaying={false}
          currentTrack={null}
          onPlayTrack={onPlayTrackMock}
          onStartWave={() => {}}
        />,
      );
    });

    const root = renderer.root;
    const touchables = root.findAllByType(TouchableOpacity);
    // Find the touchable for the first track
    const firstTrackTouchable = touchables.find((t) => {
      const textChildren = t.findAllByType(Text);
      return textChildren.some((child) => child.props.children === 'Song One');
    });

    expect(firstTrackTouchable).toBeTruthy();
    act(() => {
      firstTrackTouchable.props.onPress();
    });

    expect(onPlayTrackMock).toHaveBeenCalledWith(mockTracks[0]);
  });

  test('passes onStartWave callback to YourMixCard', () => {
    const onStartWaveMock = jest.fn();
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <HomeScreen
          tracks={mockTracks}
          isPlaying={false}
          currentTrack={null}
          onStartWave={onStartWaveMock}
        />,
      );
    });

    const root = renderer.root;
    const card = root.findByType(YourMixCard);
    act(() => {
      card.props.onPress();
    });

    expect(onStartWaveMock).toHaveBeenCalledTimes(1);
  });

  test('listens to PUUK_SCROLL_TO_TOP_HOME event safely', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <HomeScreen
          tracks={mockTracks}
          isPlaying={false}
          currentTrack={null}
        />,
      );
    });

    expect(() => {
      act(() => {
        DeviceEventEmitter.emit('PUUK_SCROLL_TO_TOP_HOME');
      });
    }).not.toThrow();

    expect(() => {
      act(() => {
        renderer.unmount();
      });
    }).not.toThrow();
  });

  test('renders GenreMixesSection with "made for you" under YourMixCard', () => {
    const mockGenreMixes = [
      {
        id: 'genre-rock',
        genre: 'Rock',
        title: 'Rock for you',
        tracks: [{ id: 'tr-1', title: 'Rock Song', artist: 'Rocker' }],
      },
      {
        id: 'genre-ambient',
        genre: 'Ambient',
        title: 'Ambient for you',
        tracks: [{ id: 'tr-2', title: 'Space Wind', artist: 'Sky' }],
      },
    ];

    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <HomeScreen
          tracks={mockTracks}
          isPlaying={false}
          currentTrack={null}
          genreMixes={mockGenreMixes}
        />,
      );
    });

    const root = renderer.root;
    const texts = root.findAllByType(Text).map((t) => t.props.children);

    expect(texts).toContain('Genre Mixes');
    expect(texts).toContain('made for you');
    expect(texts).toContain('Rock Mix');
    expect(texts).toContain('Ambient Mix');
  });

  test('renders header dimming scrim with pointerEvents="none"', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <HomeScreen
          tracks={mockTracks}
          isPlaying={false}
          currentTrack={null}
        />,
      );
    });

    const root = renderer.root;
    const scrim = root.findByProps({ testID: 'home-header-scrim' });
    expect(scrim).toBeTruthy();
    expect(scrim.props.pointerEvents).toBe('none');
  });

  test('renders RecentlyListenedSection in header when history exists', () => {
    useRecentlyListened.mockReturnValueOnce({
      tracks: [
        { id: 'rec-1', title: 'Recent Song 1', artist: 'Recent Artist 1' },
      ],
      isLoading: false,
      refresh: jest.fn(),
    });

    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <HomeScreen
          tracks={mockTracks}
          isPlaying={false}
          currentTrack={null}
        />,
      );
    });

    const root = renderer.root;
    const section = root.findByProps({ testID: 'recently-listened-section' });
    expect(section).toBeTruthy();

    const texts = root.findAllByType(Text).map((t) => t.props.children);
    expect(texts).toContain('Recently listened');
    expect(texts).toContain('Recent Song 1');

    // Verify ordering in header: Section Header Tracks is rendered after Recently listened
    const tracksHeader = texts.indexOf('Tracks');
    const recentlyListenedIndex = texts.indexOf('Recently listened');
    expect(recentlyListenedIndex).toBeLessThan(tracksHeader);
  });

  test('tapping RecentlyListened card calls onPlayTrack, ellipsis calls onPressEllipsis', () => {
    const onPlayTrack = jest.fn();
    const onPressEllipsis = jest.fn();

    const recentTrack = { id: 'rec-1', title: 'Recent Song 1', artist: 'Recent Artist 1' };
    useRecentlyListened.mockReturnValue({
      tracks: [recentTrack],
      isLoading: false,
      refresh: jest.fn(),
    });

    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <HomeScreen
          tracks={mockTracks}
          isPlaying={false}
          currentTrack={null}
          onPlayTrack={onPlayTrack}
          onPressEllipsis={onPressEllipsis}
        />,
      );
    });

    const root = renderer.root;
    const card = root.findByProps({ testID: 'recently-listened-card-rec-1' });
    act(() => {
      card.props.onPress();
    });
    expect(onPlayTrack).toHaveBeenCalledWith(recentTrack);

    const ellipsis = root.findByProps({ testID: 'recently-listened-ellipsis-rec-1' });
    act(() => {
      ellipsis.props.onPress({ stopPropagation: jest.fn() });
    });
    expect(onPressEllipsis).toHaveBeenCalledWith(recentTrack);
  });

  test('pagination triggers onLoadMoreTracks when scrolling near end', () => {
    const onLoadMoreTracks = jest.fn();
    let renderer;
    act(() => {
      renderer = TestRenderer.create(
        <HomeScreen
          tracks={mockTracks}
          isPlaying={false}
          currentTrack={null}
          hasMoreTracks={true}
          isLoadingMoreTracks={false}
          onLoadMoreTracks={onLoadMoreTracks}
        />,
      );
    });

    const root = renderer.root;
    const flatList = root.findByType(FlatList);
    act(() => {
      flatList.props.onEndReached();
    });
    expect(onLoadMoreTracks).toHaveBeenCalledTimes(1);
  });
});
