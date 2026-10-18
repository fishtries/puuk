import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import AppleLyricsView from '../AppleLyricsView';
import AnimatedLyricLine from '../AnimatedLyricLine';
import { authFetch } from '../../../../utils/api';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-blur', () => ({
  BlurView: 'BlurView',
}));

jest.mock('../../../../utils/api', () => ({
  authFetch: jest.fn(),
}));

jest.mock('../../BlurOverlays', () => ({
  TopBlurOverlay: 'TopBlurOverlay',
  BottomBlurOverlay: 'BottomBlurOverlay',
}));

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
          onBegin: () => gesture,
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
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    withSpring: (to) => to,
    withTiming: (to) => to,
    withDelay: (_delay, anim) => anim,
    interpolateColor: () => '#ffffff',
    cancelAnimation: jest.fn(),
    runOnJS: (fn) => fn,
    Easing: {
      bezier: () => (t) => t,
      out: (fn) => fn,
      cubic: (t) => t,
      back: () => (t) => t,
    },
  };
});

describe('AppleLyricsView', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const defaultProps = {
    isLyricsView: true,
    isLyricsMounted: true,
    currentTrack: { id: 42, title: 'Test Song', artist: 'Test Artist' },
    currentTime: 12,
    isPlayerVisible: true,
    isQueueVisible: false,
    seekTo: jest.fn(),
    onToggleLike: jest.fn(),
    trackIsLiked: false,
    displayTitle: 'Test Song',
    displayArtist: 'Test Artist',
    insets: { top: 47, bottom: 34 },
    width: 390,
    height: 844,
    contentAnimatedStyle: {},
    lyricsTransition: { value: 1 },
    lyricsRotation: { value: 360 },
    animatedBgStyle: {},
    lyricsViewAnimatedStyle: {},
    lyricsMiniHeaderAnimatedStyle: {},
    lyricsMiniTextAnimatedStyle: {},
    lyricsMiniHeartAnimatedStyle: {},
    lyricsOverlaysAnimatedStyle: {},
    lyricsContentAnimatedStyle: {},
    setIsLyricsView: jest.fn(),
    setIsLyricsMounted: jest.fn(),
    lyricsHeaderSwipeGesture: {},
    onClose: jest.fn(),
    onExitCompactMode: jest.fn(),
    onLyricsCompactChange: jest.fn(),
  };

  it('renders synced lyrics with AnimatedLyricLine and identifies active line', async () => {
    const lrcContent = [
      '[00:05.00]First lyric line',
      '[00:10.00]Second lyric line',
      '[00:15.00]Third lyric line',
    ].join('\n');

    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: lrcContent,
        isSynced: true,
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<AppleLyricsView {...defaultProps} currentTime={12} />);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      jest.runAllTimers();
    });

    const lyricLines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lyricLines).toHaveLength(3);

    // At 12s, second line (index 1: 10s -> 15s) is active
    expect(lyricLines[0].props.isActive).toBe(false);
    expect(lyricLines[1].props.isActive).toBe(true);
    expect(lyricLines[2].props.isActive).toBe(false);

    // Passes wave targets and index
    expect(lyricLines[1].props.index).toBe(1);
    expect(lyricLines[1].props.activeIndex).toBe(1);
    expect(typeof lyricLines[1].props.targetY).toBe('number');
  });

  it('tapping on a line triggers seekTo', async () => {
    const lrcContent = [
      '[00:05.00]First line',
      '[00:10.00]Second line',
    ].join('\n');

    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: lrcContent,
        isSynced: true,
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<AppleLyricsView {...defaultProps} />);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      jest.runAllTimers();
    });

    const lyricLines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lyricLines).toHaveLength(2);

    act(() => {
      lyricLines[1].props.onPress();
    });

    expect(defaultProps.seekTo).toHaveBeenCalledWith(10);
  });

  it('renders plain lyrics when lyrics are not synced', async () => {
    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: 'Plain line 1\nPlain line 2',
        isSynced: false,
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<AppleLyricsView {...defaultProps} />);
    });

    await act(async () => {
      jest.runAllTimers();
    });

    const animatedLines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(animatedLines).toHaveLength(0);

    const texts = renderer.root.findAll((node) => node.type === 'Text' && node.props.children === 'Plain line 1');
    expect(texts.length).toBeGreaterThan(0);
  });

  it('renders "Lyrics not found" when track has no lyrics', async () => {
    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: '',
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<AppleLyricsView {...defaultProps} />);
    });

    await act(async () => {
      jest.runAllTimers();
    });

    const noLyrics = renderer.root.findAll((node) => node.type === 'Text' && node.props.children === 'Lyrics not found');
    expect(noLyrics).toHaveLength(1);
  });
});
