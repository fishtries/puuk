import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import MiniPlayerBar from '../MiniPlayerBar';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('../../../shared/media/CoverImage', () => 'CoverImage');

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureDetector: ({ children }) => <View>{children}</View>,
    Gesture: {
      Pan: () => {
        const gesture = {
          activeOffsetY: () => gesture,
          activeOffsetX: () => gesture,
          failOffsetX: () => gesture,
          failOffsetY: () => gesture,
          onStart: () => gesture,
          onUpdate: () => gesture,
          onEnd: () => gesture,
        };
        return gesture;
      },
    },
  };
});

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Comp) => Comp,
      View,
      Text,
    },
    useAnimatedStyle: (fn) => fn(),
    interpolate: () => 1,
    Extrapolation: { CLAMP: 'clamp' },
  };
});

describe('MiniPlayerBar', () => {
  const mockCurrent = { id: 1, title: 'Current Song', artist: 'Current Artist', coverArt: 'http://c.jpg' };
  const mockPrev = { id: 0, title: 'Prev Song', artist: 'Prev Artist', coverArt: 'http://p.jpg' };
  const mockNext = { id: 2, title: 'Next Song', artist: 'Next Artist', coverArt: 'http://n.jpg' };

  it('renders prepared next and previous tracks along with the current track', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MiniPlayerBar
          currentTrack={mockCurrent}
          previousTrack={mockPrev}
          nextTrack={mockNext}
          trackSwipeX={{ value: 0 }}
          expandProgress={{ value: 0 }}
          isPlaying={true}
        />
      );
    });

    const root = renderer.root;
    const textNodes = root.findAllByType('Text');
    const renderedTexts = textNodes.map((n) => n.props.children);

    expect(renderedTexts).toContain('Current Song');
    expect(renderedTexts).toContain('Current Artist');
    expect(renderedTexts).toContain('Prev Song');
    expect(renderedTexts).toContain('Prev Artist');
    expect(renderedTexts).toContain('Next Song');
    expect(renderedTexts).toContain('Next Artist');
  });

  it('renders like button to the left of play/pause and handles like toggle', async () => {
    const onToggleLike = jest.fn();
    const togglePlayPause = jest.fn();

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MiniPlayerBar
          currentTrack={mockCurrent}
          previousTrack={mockPrev}
          nextTrack={mockNext}
          trackSwipeX={{ value: 0 }}
          isPlaying={false}
          togglePlayPause={togglePlayPause}
          onToggleLike={onToggleLike}
          isLiked={true}
        />
      );
    });

    const root = renderer.root;
    const likeButton = root.findByProps({ testID: 'mini-like-button' });
    const playButton = root.findByProps({ testID: 'mini-play-button' });
    expect(likeButton).toBeTruthy();
    expect(playButton).toBeTruthy();

    // Verify like button has heart icon with active color
    const likeIcon = likeButton.findByType('Ionicons');
    expect(likeIcon.props.name).toBe('heart');
    expect(likeIcon.props.color).toBe('#ff2d55');

    // Toggle like
    act(() => {
      likeButton.props.onPress({ stopPropagation: jest.fn() });
    });
    expect(onToggleLike).toHaveBeenCalledTimes(1);

    // Toggle play
    act(() => {
      playButton.props.onPress({ stopPropagation: jest.fn() });
    });
    expect(togglePlayPause).toHaveBeenCalledTimes(1);
  });
});
