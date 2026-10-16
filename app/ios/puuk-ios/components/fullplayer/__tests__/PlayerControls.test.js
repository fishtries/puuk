import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import PlayerControls from '../PlayerControls';
import styles from '../playerStyles';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('../ChasingArrowsIcon', () => 'ChasingArrowsIcon');
jest.mock('../ProgressBar', () => 'ProgressBar');

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureDetector: ({ children }) => <View>{children}</View>,
    Gesture: {
      Simultaneous: () => ({}),
      Pan: () => ({
        enabled: () => ({
          activeOffsetY: () => ({
            failOffsetY: () => ({
              onEnd: () => ({}),
            }),
          }),
        }),
      }),
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
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    withSpring: (to) => to,
    withTiming: (to) => to,
    withSequence: (...args) => args[0],
    runOnJS: (fn) => fn,
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    LinearTransition: { springify: () => ({ damping: () => ({ stiffness: () => ({}) }) }) },
  };
});

describe('PlayerControls - bottom plus icon removed', () => {
  it('does NOT render the add-circle-outline plus icon', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <PlayerControls
          styles={styles}
          isEffectivelyCompact={false}
          isPlaying={true}
          isLoading={false}
          currentTime={10}
          duration={100}
          togglePlayPause={jest.fn()}
          fetchNextTrack={jest.fn()}
          playPreviousTrack={jest.fn()}
          seekTo={jest.fn()}
          isLyricsView={false}
          isQueueVisible={false}
          isSliding={false}
          setIsSliding={jest.fn()}
          setSlideValue={jest.fn()}
          isSlidingShared={{ value: false }}
          sliderWidthShared={{ value: 1 }}
          slideProgressShared={{ value: 0 }}
          durationShared={{ value: 100 }}
          slideValue={0}
          bottomSwipeGesture={{}}
          exitCompactMode={jest.fn()}
          triggerExitCompactMode={jest.fn()}
          onToggleQueue={jest.fn()}
          onToggleLyrics={jest.fn()}
        />
      );
    });

    const root = renderer.root;
    // Plus icon should be completely gone
    const plusIcons = root.findAll((n) => n.type === 'Ionicons' && n.props.name === 'add-circle-outline');
    expect(plusIcons.length).toBe(0);

    // Lyrics and queue icons are still present
    const lyricsIcons = root.findAll((n) => n.type === 'Ionicons' && n.props.name === 'text-outline');
    expect(lyricsIcons.length).toBe(1);

    const queueIcons = root.findAll((n) => n.type === 'Ionicons' && n.props.name === 'list');
    expect(queueIcons.length).toBe(1);
  });
});
