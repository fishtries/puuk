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
    cancelAnimation: jest.fn(),
    Easing: {
      bezier: () => () => {},
    },
    runOnJS: (fn) => fn,
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    LinearTransition: {
      springify: () => ({ damping: () => ({ stiffness: () => ({}) }) }),
    },
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
        />,
      );
    });

    const root = renderer.root;
    // Plus icon should be completely gone
    const plusIcons = root.findAll(
      (n) => n.type === 'Ionicons' && n.props.name === 'add-circle-outline',
    );
    expect(plusIcons.length).toBe(0);

    // Lyrics and queue icons are still present
    const lyricsIcons = root.findAll(
      (n) => n.type === 'Ionicons' && n.props.name === 'text-outline',
    );
    expect(lyricsIcons.length).toBe(1);

    const queueIcons = root.findAll(
      (n) => n.type === 'Ionicons' && n.props.name === 'list',
    );
    expect(queueIcons.length).toBe(1);
  });

  it('renders SymbolView with pause.fill when playing and play.fill when paused', async () => {
    let renderer;
    const mockTogglePlay = jest.fn();

    await act(async () => {
      renderer = TestRenderer.create(
        <PlayerControls
          styles={styles}
          isEffectivelyCompact={false}
          isPlaying={true}
          isLoading={false}
          currentTime={10}
          duration={100}
          togglePlayPause={mockTogglePlay}
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
        />,
      );
    });

    const root = renderer.root;
    const pauseSymbol = root.findByProps({ name: 'pause.fill' });
    expect(pauseSymbol).toBeDefined();
    expect(pauseSymbol.props.tintColor).toBe('#ffffff');
    expect(pauseSymbol.props.size).toBe(48);

    await act(async () => {
      renderer.update(
        <PlayerControls
          styles={styles}
          isEffectivelyCompact={false}
          isPlaying={false}
          isLoading={false}
          currentTime={10}
          duration={100}
          togglePlayPause={mockTogglePlay}
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
        />,
      );
    });

    const playSymbol = root.findByProps({ name: 'play.fill' });
    expect(playSymbol).toBeDefined();
    expect(playSymbol.props.tintColor).toBe('#ffffff');
    expect(playSymbol.props.size).toBe(48);
  });

  it('triggers playPreviousTrack and fetchNextTrack on button presses', async () => {
    let renderer;
    const mockPlayPrev = jest.fn();
    const mockFetchNext = jest.fn();
    const mockTogglePlay = jest.fn();

    await act(async () => {
      renderer = TestRenderer.create(
        <PlayerControls
          styles={styles}
          isEffectivelyCompact={false}
          isPlaying={true}
          isLoading={false}
          currentTime={10}
          duration={100}
          togglePlayPause={mockTogglePlay}
          fetchNextTrack={mockFetchNext}
          playPreviousTrack={mockPlayPrev}
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
        />,
      );
    });

    const root = renderer.root;
    const prevBtn = root.findByProps({ accessibilityLabel: 'Предыдущий трек' });
    const nextBtn = root.findByProps({ accessibilityLabel: 'Следующий трек' });
    const playBtn = root.findByProps({ accessibilityLabel: 'Пауза' });

    expect(prevBtn).toBeTruthy();
    expect(nextBtn).toBeTruthy();
    expect(playBtn).toBeTruthy();

    await act(async () => {
      prevBtn.props.onPress();
    });
    expect(mockPlayPrev).toHaveBeenCalledTimes(1);

    await act(async () => {
      nextBtn.props.onPress();
    });
    expect(mockFetchNext).toHaveBeenCalledTimes(1);

    await act(async () => {
      playBtn.props.onPress();
    });
    expect(mockTogglePlay).toHaveBeenCalledTimes(1);
  });

  it('passes compact sizes and spacing when isEffectivelyCompact is true', async () => {
    let renderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <PlayerControls
          styles={styles}
          isEffectivelyCompact={true}
          isPlaying={false}
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
        />,
      );
    });

    const root = renderer.root;
    const playSymbol = root.findByProps({ name: 'play.fill' });
    expect(playSymbol.props.size).toBe(36);

    const chasingIcons = root.findAllByType('ChasingArrowsIcon');
    expect(chasingIcons.length).toBe(2);
    expect(chasingIcons[0].props.size).toBe(28);
    expect(chasingIcons[0].props.spacing).toBe(14);
    expect(chasingIcons[1].props.size).toBe(28);
    expect(chasingIcons[1].props.spacing).toBe(14);
  });

  it('renders ChasingArrowsIcon for both buttons without ActivityIndicator even when isLoading is true', async () => {
    let renderer;
    const mockFetchNext = jest.fn();

    await act(async () => {
      renderer = TestRenderer.create(
        <PlayerControls
          styles={styles}
          isEffectivelyCompact={false}
          isPlaying={true}
          isLoading={true}
          currentTime={10}
          duration={100}
          togglePlayPause={jest.fn()}
          fetchNextTrack={mockFetchNext}
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
        />,
      );
    });

    const root = renderer.root;
    const nextBtn = root.findByProps({ accessibilityLabel: 'Следующий трек' });
    expect(nextBtn.props.accessibilityRole).toBe('button');

    const chasingIcons = root.findAllByType('ChasingArrowsIcon');
    expect(chasingIcons.length).toBe(2);
    expect(chasingIcons[0].props.direction).toBe('left');
    expect(chasingIcons[1].props.direction).toBe('right');

    await act(async () => {
      nextBtn.props.onPress();
    });
    expect(mockFetchNext).toHaveBeenCalledTimes(1);
  });
});
