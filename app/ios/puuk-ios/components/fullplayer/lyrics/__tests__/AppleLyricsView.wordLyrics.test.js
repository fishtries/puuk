import React from 'react';
import { View } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import TestRenderer, { act } from 'react-test-renderer';
import AppleLyricsView from '../AppleLyricsView';
import AnimatedLyricLine, { wordSweepProgress } from '../AnimatedLyricLine';
import { authFetch } from '../../../../shared/api/api';
import syntheticFixture from './fixtures/word_lyrics_synthetic.json';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-blur', () => ({
  BlurView: 'BlurView',
}));

jest.mock('../../../../shared/api/api', () => ({
  authFetch: jest.fn(),
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
          onFinalize: () => gesture,
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
    useSharedValue: (init) => require('react').useRef({ value: init }).current,
    useAnimatedStyle: (fn) => fn(),
    useAnimatedReaction: () => {},
    useReducedMotion: () => false,
    withSpring: (to) => to,
    withTiming: (to) => to,
    withDelay: (_delay, anim) => anim,
    withDecay: (config) => config?.velocity || 0,
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

describe('AppleLyricsView with wordLyrics (Contract v1)', () => {
  const defaultProps = {
    isLyricsView: true,
    isLyricsMounted: true,
    currentTrack: { id: 'test-track-001', title: 'Test Track', artist: 'Artist' },
    currentTime: 0,
    isPlayerVisible: true,
    isQueueVisible: false,
    seekTo: jest.fn(),
    onToggleLike: jest.fn(),
    trackIsLiked: false,
    displayTitle: 'Test Track',
    displayArtist: 'Artist',
    insets: { top: 40, bottom: 30 },
    width: 375,
    height: 812,
    contentAnimatedStyle: {},
    lyricsTransition: { value: 1 },
    lyricsRotation: { value: 0 },
    lyricsViewAnimatedStyle: {},
    lyricsMiniHeaderAnimatedStyle: {},
    lyricsMiniTextAnimatedStyle: {},
    lyricsMiniHeartAnimatedStyle: {},
    lyricsContentAnimatedStyle: {},
    setIsLyricsView: jest.fn(),
    setIsLyricsMounted: jest.fn(),
    lyricsHeaderSwipeGesture: {},
    onClose: jest.fn(),
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('moves the gradient continuously through word time and resets on seek', () => {
    const segment = { startMs: 1000, endMs: 2000 };
    expect(wordSweepProgress(segment, 999)).toBe(0);
    expect(wordSweepProgress(segment, 1000)).toBe(0);
    expect(wordSweepProgress(segment, 1250)).toBe(0.25);
    expect(wordSweepProgress(segment, 1500)).toBe(0.5);
    expect(wordSweepProgress(segment, 2000)).toBe(1);
    expect(wordSweepProgress(segment, 2500)).toBe(1);
    expect(wordSweepProgress(segment, 1100)).toBe(0.1);
  });

  it('allocates masks only for sounding words, including overlaps and backward seeks', () => {
    const segments = Array.from({ length: 100 }, (_, i) => ({
      id: String(i), text: 'word', isWord: true, startMs: i * 1000, endMs: i * 1000 + 1500,
    }));
    const playbackMs = { value: 1250 };
    const props = { text: 'words', index: 0, activeIndex: 0,
      segments, hasWordTimings: true, playbackMs };
    let renderer;
    act(() => { renderer = TestRenderer.create(<AnimatedLyricLine {...props} currentMs={1250} />); });
    expect(renderer.root.findAllByType(MaskedView)).toHaveLength(0);
    const measureWords = () => {
      act(() => {
        renderer.root.findAllByType(View).filter(node =>
          node.props.accessible === false && node.props.onLayout
        ).forEach(node => node.props.onLayout({ nativeEvent: { layout: { width: 50 } } }));
      });
    };
    measureWords();
    expect(renderer.root.findAllByType(MaskedView)).toHaveLength(2);
    act(() => { renderer.update(<AnimatedLyricLine {...props} currentMs={101000} />); });
    expect(renderer.root.findAllByType(MaskedView)).toHaveLength(0);
    act(() => { renderer.update(<AnimatedLyricLine {...props} currentMs={250} />); });
    // The measured word survives completion and a backward seek.
    expect(renderer.root.findAllByType(MaskedView)).toHaveLength(1);
    measureWords();
    expect(renderer.root.findAllByType(MaskedView)).toHaveLength(1);
    act(() => { renderer.unmount(); });
  });

  it('keeps the measured word mounted when entering and leaving its interval', () => {
    const segment = { id: 'word', text: 'hello', isWord: true, startMs: 1000, endMs: 2000 };
    const props = { text: 'hello', index: 0, activeIndex: 0, segments: [segment],
      hasWordTimings: true, playbackMs: { value: 1250 } };
    let renderer;
    act(() => { renderer = TestRenderer.create(<AnimatedLyricLine {...props} currentMs={0} />); });
    const measuredWord = renderer.root.findAllByType(View).find(node =>
      node.props.accessible === false && node.props.onLayout);
    act(() => { measuredWord.props.onLayout({ nativeEvent: { layout: { width: 100 } } }); });
    act(() => { renderer.update(<AnimatedLyricLine {...props} currentMs={1250} />); });
    expect(renderer.root.findAllByType(MaskedView)).toHaveLength(1);
    const reveal = renderer.root.findAllByType(View).find(node =>
      Array.isArray(node.props.style) && node.props.style[0]?.width === 300);
    // A quarter-filled word must never expose a whole white word.
    expect(reveal.props.style[0].transform[0].translateX).toBe(-210);
    expect(reveal.props.style[1].transform[0].translateX).toBe(-180);
    expect(reveal.props.style[1].width).toBeUndefined();
    act(() => { renderer.update(<AnimatedLyricLine {...props} currentMs={2100} />); });
    expect(renderer.root.findAllByType(View).find(node =>
      node.props.accessible === false && node.props.onLayout)).toBe(measuredWord);
    expect(renderer.root.findAllByType(MaskedView)).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

  it('renders word-level lyrics from synthetic fixture with 4 lines', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        lyrics: null,
        wordLyrics: syntheticFixture,
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView {...defaultProps} currentTime={1.2} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const lines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lines).toHaveLength(4);

    // At 1.2s, line 0 ("Hello, world! 🎶") is active [1.0s, 2.8s)
    expect(lines[0].props.isActive).toBe(true);
    expect(lines[1].props.isActive).toBe(false);
    expect(lines[0].props.hasWordTimings).toBe(true);

    // Line 0 words: word 0 ("Hello,") is active at 1200ms
    const activeLine = lines[0];
    expect(activeLine.props.currentMs).toBe(1000);
    expect(activeLine.props.playbackMs.value).toBe(1200);
  });

  it('identifies word states inside active line: active, gap, and next word', async () => {
    authFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        lyrics: null,
        wordLyrics: syntheticFixture,
      }),
    });

    let renderer;
    // 1. Inside first word (1.2s -> 1200ms, word-0001: 1000..1800ms)
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView {...defaultProps} currentTime={1.2} />,
      );
    });
    await act(async () => { await Promise.resolve(); });

    let lines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lines[0].props.isActive).toBe(true);
    expect(lines[0].props.currentMs).toBe(1000);
    const firstWordProps = lines[0].props;
    await act(async () => {
      jest.advanceTimersByTime(300);
      renderer.update(<AppleLyricsView {...defaultProps} currentTime={1.4} />);
    });
    const stableProps = renderer.root.findAllByType(AnimatedLyricLine)[0].props;
    await act(async () => {
      renderer.update(<AppleLyricsView {...defaultProps} currentTime={1.5} />);
    });
    expect(renderer.root.findAllByType(AnimatedLyricLine)[0].props).toBe(stableProps);
    expect(stableProps.playbackMs).toBe(firstWordProps.playbackMs);
    expect(stableProps.playbackMs.value).toBe(1500);

    // 2. In gap between words (1.85s -> 1850ms, gap between 1800ms and 1900ms)
    await act(async () => {
      renderer.update(<AppleLyricsView {...defaultProps} currentTime={1.85} />);
    });
    lines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lines[0].props.isActive).toBe(true);
    expect(lines[0].props.currentMs).toBe(1000);
    expect(lines[0].props.playbackMs.value).toBe(1850);

    // 3. Inside second word (2.0s -> 2000ms, word-0002: 1900..2500ms)
    await act(async () => {
      renderer.update(<AppleLyricsView {...defaultProps} currentTime={2.0} />);
    });
    lines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lines[0].props.currentMs).toBe(1900);
    expect(lines[0].props.playbackMs.value).toBe(2000);
    await act(async () => {
      renderer.update(<AppleLyricsView {...defaultProps} currentTime={1.4} />);
    });
    expect(renderer.root.findAllByType(AnimatedLyricLine)[0].props.currentMs).toBe(1000);
  });

  it('renders line with repeating words and preserves distinct word occurrences', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        wordLyrics: syntheticFixture,
      }),
    });

    let renderer;
    // At 3.2s, line 1 ("Part of me, part of me") is active
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView {...defaultProps} currentTime={3.2} />,
      );
    });
    await act(async () => { await Promise.resolve(); });

    const lines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lines[1].props.isActive).toBe(true);
    expect(lines[1].props.words).toHaveLength(6);
    expect(lines[1].props.words[0].id).toBe('word-0004');
    expect(lines[1].props.words[3].id).toBe('word-0007');
    expect(lines[1].props.words[0].text).toBe('Part');
    expect(lines[1].props.words[3].text).toBe('part');
  });

  it('renders line with overlapping words (line 2)', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        wordLyrics: syntheticFixture,
      }),
    });

    let renderer;
    // At 5.9s (5900ms), line 2 ("Overlapping vocal bridge") is active
    // word-0010: 5200..6000ms, word-0011: 5800..6500ms overlap at 5900ms!
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView {...defaultProps} currentTime={5.9} />,
      );
    });
    await act(async () => { await Promise.resolve(); });

    const lines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lines[2].props.isActive).toBe(true);
    expect(lines[2].props.currentMs).toBe(5800);
    expect(lines[2].props.playbackMs.value).toBe(5900);
  });

  it('renders fallback line with words: [] without crashing', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        wordLyrics: syntheticFixture,
      }),
    });

    let renderer;
    // At 9.0s, line 3 ("Строка без слов с акцентом") is active
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView {...defaultProps} currentTime={9.0} />,
      );
    });
    await act(async () => { await Promise.resolve(); });

    const lines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lines[3].props.isActive).toBe(true);
    expect(lines[3].props.hasWordTimings).toBe(false);
    expect(lines[3].props.words).toEqual([]);
    expect(lines[3].props.text).toBe('Строка без слов с акцентом');
  });

  it('tapping on a line triggers seekTo with startMs converted to seconds', async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        wordLyrics: syntheticFixture,
      }),
    });

    const seekMock = jest.fn();
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView {...defaultProps} seekTo={seekMock} currentTime={0} />,
      );
    });
    await act(async () => { await Promise.resolve(); });

    const lines = renderer.root.findAllByType(AnimatedLyricLine);
    // Tap line 1 (startMs: 3000 -> 3.0s)
    act(() => {
      lines[1].props.onPress();
    });

    expect(seekMock).toHaveBeenCalledWith(3.0);
  });

  it('falls back to standard LRC when wordLyrics schema is invalid', async () => {
    const corruptedWordLyrics = {
      ...syntheticFixture,
      schemaVersion: 999, // unsupported
    };

    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        lyrics: '[00:02.00]Fallback LRC line',
        isSynced: true,
        wordLyrics: corruptedWordLyrics,
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView {...defaultProps} currentTime={2.5} />,
      );
    });
    await act(async () => { await Promise.resolve(); });

    const lines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lines).toHaveLength(1);
    expect(lines[0].props.text).toBe('Fallback LRC line');
    expect(lines[0].props.hasWordTimings).toBe(false);
  });

  it('handles race conditions (A -> B -> A) and ignores stale responses', async () => {
    let resolveTrackA;
    const pendingPromiseA = new Promise((resolve) => {
      resolveTrackA = resolve;
    });

    // Request for Track A starts and hangs
    authFetch.mockReturnValueOnce(pendingPromiseA);

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView
          {...defaultProps}
          currentTrack={{ id: 'track-A', title: 'Track A' }}
        />,
      );
    });

    // Now switch to Track B
    authFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        lyrics: '[00:01.00]Track B line',
        isSynced: true,
      }),
    });

    await act(async () => {
      renderer.update(
        <AppleLyricsView
          {...defaultProps}
          currentTrack={{ id: 'track-B', title: 'Track B' }}
        />,
      );
      await Promise.resolve();
    });

    // Now stale response for Track A arrives
    await act(async () => {
      resolveTrackA({
        ok: true,
        status: 200,
        json: async () => ({
          lyrics: '[00:01.00]Track A Stale line',
          isSynced: true,
        }),
      });
      await Promise.resolve();
    });

    // Current view should remain on Track B!
    const lines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lines).toHaveLength(1);
    expect(lines[0].props.text).toBe('Track B line');
  });
});
