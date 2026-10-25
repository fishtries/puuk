import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DeviceEventEmitter, TouchableOpacity, Text } from 'react-native';
import HomeScreen from '../HomeScreen';
import YourMixCard from '../YourMixCard';

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
  };
});

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
});
