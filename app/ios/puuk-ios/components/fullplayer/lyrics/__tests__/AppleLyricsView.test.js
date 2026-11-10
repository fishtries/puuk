import React from 'react';
import { View, Text, AccessibilityInfo, Dimensions } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import AppleLyricsView from '../AppleLyricsView';
import AnimatedLyricLine from '../AnimatedLyricLine';
import { authFetch } from '../../../../shared/api/api';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-blur', () => ({
  BlurView: 'BlurView',
}));

jest.mock('../../../../shared/api/api', () => ({
  authFetch: jest.fn(),
}));

let lastPanGesture = {};
let mockScrollReaction;
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
          onBegin: (cb) => {
            gesture._onBegin = cb;
            return gesture;
          },
          onStart: (cb) => {
            gesture._onStart = cb;
            lastPanGesture = gesture;
            return gesture;
          },
          onUpdate: (cb) => {
            gesture._onUpdate = cb;
            return gesture;
          },
          onFinalize: (cb) => { gesture._onFinalize = cb; return gesture; },
          onEnd: (cb) => {
            gesture._onEnd = cb;
            return gesture;
          },
        };
        lastPanGesture = gesture;
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
    useReducedMotion: () => false,
    useSharedValue: (init) => require('react').useRef({ value: init }).current,
    useAnimatedStyle: (fn) => {
      const style = require('react').useRef({}).current;
      Object.assign(style, fn());
      return style;
    },
    useAnimatedReaction: (prepare, react) => { mockScrollReaction = { prepare, react }; },
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

describe('AppleLyricsView', () => {
  const estimatedLineHeight = 48 + 33 * (Dimensions.get('window').fontScale || 1);
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
    lyricsViewAnimatedStyle: {},
    lyricsMiniHeaderAnimatedStyle: {},
    lyricsMiniTextAnimatedStyle: {},
    lyricsMiniHeartAnimatedStyle: {},
    lyricsContentAnimatedStyle: {},
    setIsLyricsView: jest.fn(),
    setIsLyricsMounted: jest.fn(),
    lyricsHeaderSwipeGesture: {},
    onClose: jest.fn(),
    onExitCompactMode: jest.fn(),
    onLyricsCompactChange: jest.fn(),
  };

  it('bounds animated rows, preserves measured heights, and follows manual scrolling and backward seeks', async () => {
    const lrc = Array.from({ length: 80 }, (_, i) =>
      `[${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.00]Line ${i}`
    ).join('\n');
    authFetch.mockResolvedValueOnce({ json: async () => ({ lyrics: lrc, isSynced: true }) });
    let renderer;
    await act(async () => { renderer = TestRenderer.create(<AppleLyricsView {...defaultProps} currentTime={40.1} />); });
    expect(renderer.root.findAllByType(AnimatedLyricLine).length).toBeLessThan(35);
    const heights = Array(80).fill(estimatedLineHeight);
    act(() => {
      for (const row of renderer.root.findAllByType(AnimatedLyricLine)) {
        const height = 80 + (row.props.index % 3) * 33;
        heights[row.props.index] = height;
        row.props.onLayout(row.props.index, 0, height);
      }
    });
    let y = 162;
    const layouts = heights.map(height => {
      const layout = { y, height };
      y += height;
      return layout;
    });
    act(() => { jest.advanceTimersByTime(50); });
    const rows = () => renderer.root.findAllByType(AnimatedLyricLine);
    const spacers = () => renderer.root.findAllByType(View).filter(node =>
      node.props.testID?.startsWith('lyric-spacer-'));
    expect(rows().length).toBeLessThan(30);
    expect(rows().some(row => row.props.index === 40)).toBe(true);
    expect(rows().length + spacers().length).toBe(80);
    const preservedHeight = rows().reduce((sum, row) => sum + layouts[row.props.index].height, 0) +
      spacers().reduce((sum, node) => sum + node.props.style.height, 0);
    expect(preservedHeight).toBe(y - 162);
    expect(rows().some(row => row.props.index === 4)).toBe(false);

    const target = rows().find(row => row.props.isActive).props.targetY;
    act(() => { lastPanGesture._onStart(); });
    act(() => {
      lastPanGesture._onUpdate({ translationY: 844 * 0.4 - layouts[4].y - target });
      mockScrollReaction.react(mockScrollReaction.prepare(), 0);
    });
    expect(rows().some(row => row.props.index === 4)).toBe(true);
    expect(rows().some(row => row.props.index === 39)).toBe(true);
    expect(rows().length).toBeLessThan(45);
    act(() => { lastPanGesture._onFinalize(); });
    act(() => { jest.advanceTimersByTime(3000); });
    act(() => { mockScrollReaction.react(mockScrollReaction.prepare(), null); });
    expect(rows().some(row => row.props.index === 4)).toBe(false);
    expect(rows().find(row => row.props.isActive).props.isManualScrolling).toBe(false);
    expect(rows().find(row => row.props.isActive).props.isInitial).toBe(true);

    act(() => { renderer.update(<AppleLyricsView {...defaultProps} currentTime={4.1} />); });
    expect(rows().find(row => row.props.isActive).props.index).toBe(4);
    expect(rows().length).toBeLessThan(35);
    const oldLayoutHandler = rows()[0].props.onLayout;
    // A width change invalidates heights but still mounts only the window.
    act(() => { renderer.update(<AppleLyricsView {...defaultProps} currentTime={4.1} width={430} />); });
    expect(rows().length).toBeLessThan(35);
    const newTarget = rows().find(row => row.props.isActive).props.targetY;
    act(() => { oldLayoutHandler(4, 9999, 400); });
    expect(rows().find(row => row.props.isActive).props.targetY).toBe(newTarget);
    act(() => { renderer.unmount(); });
  });

  it('retains offscreen lyrics for VoiceOver', async () => {
    const reader = jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
    authFetch.mockResolvedValueOnce({ json: async () => ({
      lyrics: Array.from({ length: 40 }, (_, i) => `[00:${String(i).padStart(2, '0')}.00]Line ${i}`).join('\n'),
      isSynced: true,
    }) });
    let renderer;
    await act(async () => { renderer = TestRenderer.create(<AppleLyricsView {...defaultProps} />); });
    act(() => {
      for (const row of renderer.root.findAllByType(AnimatedLyricLine)) {
        row.props.onLayout(row.props.index, row.props.index * 100, 100);
      }
    });
    act(() => { jest.advanceTimersByTime(50); });
    expect(renderer.root.findAllByType(AnimatedLyricLine)).toHaveLength(40);
    act(() => { renderer.unmount(); });
    reader.mockRestore();
  });

  it('preserves glyph props during line motion and still accepts changed text', () => {
    const props = { text: 'static glyphs', index: 0, activeIndex: 0,
      isActive: true, targetY: 0, baseStyle: { fontSize: 23 } };
    let renderer;
    act(() => { renderer = TestRenderer.create(<AnimatedLyricLine {...props} />); });
    const glyphProps = renderer.root.findAllByType(Text).find(node => node.props.children === props.text).props;
    act(() => { renderer.update(<AnimatedLyricLine {...props} activeIndex={1} isActive={false} targetY={-200} />); });
    expect(renderer.root.findAllByType(Text).find(node => node.props.children === props.text).props).toBe(glyphProps);
    act(() => { renderer.update(<AnimatedLyricLine {...props} text="updated glyphs" />); });
    expect(renderer.root.findAllByType(Text).some(node => node.props.children === 'updated glyphs')).toBe(true);
    act(() => { renderer.unmount(); });
  });

  it('keeps the header stable across audio updates and updates changed track details', async () => {
    authFetch.mockResolvedValueOnce({ json: async () => ({ lyrics: '[00:01.00]First', isSynced: true }) });
    let renderer;
    await act(async () => { renderer = TestRenderer.create(<AppleLyricsView {...defaultProps} currentTime={2} />); });
    const title = renderer.root.findAllByType(Text).find(node => node.props.children === defaultProps.displayTitle).props;
    act(() => { renderer.update(<AppleLyricsView {...defaultProps} currentTime={2.1} />); });
    expect(renderer.root.findAllByType(Text).find(node => node.props.children === defaultProps.displayTitle).props).toBe(title);
    act(() => { renderer.update(<AppleLyricsView {...defaultProps} currentTime={2.2} displayTitle="New title" />); });
    expect(renderer.root.findAllByType(Text).some(node => node.props.children === 'New title')).toBe(true);
    act(() => { renderer.unmount(); });
  });

  it('prepares lyric rows behind the player and reuses them when lyrics open', async () => {
    authFetch.mockResolvedValueOnce({ json: async () => ({ lyrics: '[00:01.00]First\n[00:04.00]Next', isSynced: true }) });
    let renderer;
    await act(async () => { renderer = TestRenderer.create(<AppleLyricsView {...defaultProps}
      isLyricsView={false} isLyricsMounted={false} currentTime={2} />); });
    const first = renderer.root.findAllByType(AnimatedLyricLine)[0];
    expect(first.props.isActive).toBe(true);
    act(() => { renderer.update(<AppleLyricsView {...defaultProps} currentTime={2} />); });
    expect(renderer.root.findAllByType(AnimatedLyricLine)[0]).toBe(first);
    act(() => { renderer.update(<AppleLyricsView {...defaultProps}
      isPlayerVisible={false} isLyricsView={false} isLyricsMounted={false} />); });
    expect(renderer.root.findAllByType(AnimatedLyricLine)).toHaveLength(0);
    act(() => { renderer.unmount(); });
  });

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
      renderer = TestRenderer.create(
        <AppleLyricsView {...defaultProps} currentTime={12} />,
      );
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
    const lrcContent = ['[00:05.00]First line', '[00:10.00]Second line'].join(
      '\n',
    );

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

    const texts = renderer.root.findAll(
      (node) => node.type === 'Text' && node.props.children === 'Plain line 1',
    );
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

    const noLyrics = renderer.root.findAll(
      (node) =>
        node.type === 'Text' && node.props.children === 'Lyrics not found',
    );
    expect(noLyrics).toHaveLength(1);
  });

  it('loads lyrics correctly for legacy track_id-only records', async () => {
    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: '[00:01.00]Legacy lyrics line',
        isSynced: true,
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView
          {...defaultProps}
          currentTrack={{ track_id: 'legacy-track-99', title: 'Legacy Song' }}
        />,
      );
    });

    await act(async () => {
      jest.runAllTimers();
    });

    expect(authFetch).toHaveBeenCalledWith(
      '/api/tracks/legacy-track-99/lyrics',
    );
    const lyricLines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lyricLines).toHaveLength(1);
  });

  it('loads lyrics correctly for numeric id 0', async () => {
    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: '[00:01.00]Zero id lyrics line',
        isSynced: true,
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView
          {...defaultProps}
          currentTrack={{ id: 0, title: 'Zero Track' }}
        />,
      );
    });

    await act(async () => {
      jest.runAllTimers();
    });

    expect(authFetch).toHaveBeenCalledWith('/api/tracks/0/lyrics');
    const lyricLines = renderer.root.findAllByType(AnimatedLyricLine);
    expect(lyricLines).toHaveLength(1);
  });

  it('loads lyrics correctly when id is blank whitespace by falling back to track_id', async () => {
    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: '[00:01.00]Whitespace fallback line',
        isSynced: true,
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView
          {...defaultProps}
          currentTrack={{
            id: '   ',
            track_id: 'fallback-77',
            title: 'Fallback Track',
          }}
        />,
      );
    });

    await act(async () => {
      jest.runAllTimers();
    });

    expect(authFetch).toHaveBeenCalledWith('/api/tracks/fallback-77/lyrics');
  });

  it('resets and re-fetches lyrics when currentTrack changes between legacy IDs and id 0', async () => {
    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: '[00:01.00]First track line',
        isSynced: true,
      }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppleLyricsView
          {...defaultProps}
          currentTrack={{ track_id: 'leg-first', title: 'Track 1' }}
        />,
      );
    });

    await act(async () => {
      jest.runAllTimers();
    });

    expect(authFetch).toHaveBeenCalledWith('/api/tracks/leg-first/lyrics');

    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: '[00:02.00]Zero track line',
        isSynced: true,
      }),
    });

    await act(async () => {
      renderer.update(
        <AppleLyricsView
          {...defaultProps}
          currentTrack={{ id: 0, title: 'Zero Track' }}
        />,
      );
    });

    await act(async () => {
      jest.runAllTimers();
    });

    expect(authFetch).toHaveBeenCalledWith('/api/tracks/0/lyrics');
  });

  it('does not invoke onClose when panning or ending pan on synced lyrics', async () => {
    const mockOnClose = jest.fn();
    const lrcContent = [
      '[00:05.00]Line 1',
      '[00:10.00]Line 2',
      '[00:15.00]Line 3',
    ].join('\n');

    authFetch.mockResolvedValueOnce({
      json: async () => ({
        lyrics: lrcContent,
        isSynced: true,
      }),
    });

    await act(async () => {
      TestRenderer.create(
        <AppleLyricsView {...defaultProps} onClose={mockOnClose} />,
      );
    });

    await act(async () => {
      jest.runAllTimers();
    });

    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('keeps controls expanded during speed adjustment and resumes the timer after closing', async () => {
    const onLyricsCompactChange = jest.fn();
    authFetch.mockResolvedValueOnce({
      json: async () => ({ lyrics: '[00:01.00]First', isSynced: true }),
    });
    const props = { ...defaultProps, onLyricsCompactChange };
    let renderer;
    await act(async () => { renderer = TestRenderer.create(<AppleLyricsView {...props} />); });
    act(() => { jest.advanceTimersByTime(2000); });
    act(() => { renderer.update(<AppleLyricsView {...props} isControlsInteractionActive />); });
    act(() => { jest.advanceTimersByTime(10000); });
    expect(onLyricsCompactChange).not.toHaveBeenCalledWith(true);
    act(() => { renderer.update(<AppleLyricsView {...props} />); });
    act(() => { jest.advanceTimersByTime(2999); });
    expect(onLyricsCompactChange).not.toHaveBeenCalledWith(true);
    act(() => { jest.advanceTimersByTime(1); });
    expect(onLyricsCompactChange).toHaveBeenLastCalledWith(true);
    act(() => { renderer.unmount(); });
  });

  it('automatically collapses controls after 3000ms inactivity', async () => {
    const onLyricsCompactChange = jest.fn();
    const lrcContent = '[00:05.00]Line 1\n[00:10.00]Line 2';
    authFetch.mockResolvedValueOnce({
      json: async () => ({ lyrics: lrcContent, isSynced: true }),
    });

    await act(async () => {
      TestRenderer.create(
        <AppleLyricsView
          {...defaultProps}
          onLyricsCompactChange={onLyricsCompactChange}
        />,
      );
    });

    // Initially starts as false
    expect(onLyricsCompactChange).toHaveBeenCalledWith(false);

    // After 2999ms, has not collapsed yet
    await act(async () => {
      jest.advanceTimersByTime(2999);
    });
    expect(onLyricsCompactChange).not.toHaveBeenCalledWith(true);

    // Reaching 3000ms triggers auto-collapse
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(onLyricsCompactChange).toHaveBeenCalledWith(true);
  });

  it('keeps wave motion after a delayed audio update instead of mistaking lag for a seek', async () => {
    authFetch.mockResolvedValueOnce({
      json: async () => ({ lyrics: '[00:01.00]First\n[00:04.00]Next', isSynced: true }),
    });
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<AppleLyricsView {...defaultProps} currentTime={2} />);
    });
    act(() => { jest.advanceTimersByTime(1500); });
    act(() => { renderer.update(<AppleLyricsView {...defaultProps} currentTime={4.2} />); });
    const next = renderer.root.findAllByType(AnimatedLyricLine)[1];
    expect(next.props.isActive).toBe(true);
    expect(next.props.isInitial).toBe(false);
    act(() => { renderer.unmount(); });
  });

  it('commits the new highlight and scroll target together', async () => {
    authFetch.mockResolvedValueOnce({
      json: async () => ({ lyrics: '[00:01.00]First\n[00:04.00]Next', isSynced: true }),
    });
    let renderer;
    const commits = [];
    const render = (time) => (
      <React.Profiler id="lyrics" onRender={() => {
        if (!renderer) return;
        const active = renderer.root.findAllByType(AnimatedLyricLine).find(line => line.props.isActive);
        if (active) commits.push({ index: active.props.index, target: active.props.targetY });
      }}>
        <AppleLyricsView {...defaultProps} currentTime={time} />
      </React.Profiler>
    );
    await act(async () => { renderer = TestRenderer.create(render(2)); });
    act(() => { jest.advanceTimersByTime(300); });
    commits.length = 0;
    act(() => { renderer.update(render(4.1)); });
    const nextCommits = commits.filter(commit => commit.index === 1);
    expect(nextCommits.length).toBeGreaterThan(0);
    for (const commit of nextCommits) {
      expect(commit.target).toBeCloseTo(844 * 0.4 - 162 - estimatedLineHeight * 1.5);
    }
    act(() => { renderer.unmount(); });
  });

  it('resumes following and collapses after a cancelled scroll without spring completion', async () => {
    const onLyricsCompactChange = jest.fn();
    authFetch.mockResolvedValueOnce({
      json: async () => ({ lyrics: '[00:01.00]First\n[00:10.00]Next', isSynced: true }),
    });
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<AppleLyricsView {...defaultProps}
        currentTime={2} onLyricsCompactChange={onLyricsCompactChange} />);
    });
    act(() => { lastPanGesture._onStart(); });
    expect(renderer.root.findAllByType(AnimatedLyricLine)[0].props.isManualScrolling).toBe(true);
    act(() => { lastPanGesture._onFinalize(); });
    act(() => { jest.advanceTimersByTime(3000); });
    expect(renderer.root.findAllByType(AnimatedLyricLine)[0].props.isManualScrolling).toBe(false);
    expect(onLyricsCompactChange).toHaveBeenLastCalledWith(true);
    act(() => { renderer.unmount(); });
  });

  it('returns to the latest active line after native touch completion without a gesture finalizer', async () => {
    const onLyricsCompactChange = jest.fn();
    authFetch.mockResolvedValueOnce({
      json: async () => ({ lyrics: '[00:01.00]First\n[00:04.00]Next', isSynced: true }),
    });
    const props = { ...defaultProps, onLyricsCompactChange };
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(<AppleLyricsView {...props} currentTime={2} />);
    });
    act(() => { lastPanGesture._onStart(); });
    const { View } = require('react-native');
    const surface = renderer.root.findAllByType(View).find(node => node.props.onTouchEnd);
    act(() => { surface.props.onTouchEnd(); });
    // Audio updates continue during the grace period without resetting timers.
    for (let step = 1; step <= 5; step += 1) {
      act(() => { jest.advanceTimersByTime(500); });
      act(() => { renderer.update(<AppleLyricsView {...props} currentTime={2 + step * 0.5} />); });
    }
    expect(renderer.root.findAllByType(AnimatedLyricLine)[1].props.isManualScrolling).toBe(true);
    act(() => { jest.advanceTimersByTime(500); });
    const line = renderer.root.findAllByType(AnimatedLyricLine)[1];
    expect(line.props.isActive).toBe(true);
    expect(line.props.isManualScrolling).toBe(false);
    expect(line.props.targetY).toBeCloseTo(844 * 0.4 - 162 - estimatedLineHeight * 1.5);
    expect(onLyricsCompactChange).toHaveBeenLastCalledWith(true);
    act(() => { renderer.unmount(); });
  });

  it('does NOT expand compact mode when scrolling lyrics', async () => {
    const onLyricsCompactChange = jest.fn();
    let exitCompactFn;
    const onExitCompactMode = jest.fn((fn) => {
      exitCompactFn = fn;
    });

    const lrcContent = '[00:05.00]Line 1\n[00:10.00]Line 2';
    authFetch.mockResolvedValueOnce({
      json: async () => ({ lyrics: lrcContent, isSynced: true }),
    });

    await act(async () => {
      TestRenderer.create(
        <AppleLyricsView
          {...defaultProps}
          onExitCompactMode={onExitCompactMode}
          onLyricsCompactChange={onLyricsCompactChange}
        />,
      );
    });

    // Trigger auto-collapse to compact mode
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(onLyricsCompactChange).toHaveBeenLastCalledWith(true);

    // User starts scrolling lyrics (via pan gesture)
    if (lastPanGesture._onStart) {
      await act(async () => {
        lastPanGesture._onStart();
      });
    }

    // Must NOT have expanded: should still remain compact (true)
    expect(onLyricsCompactChange).toHaveBeenLastCalledWith(true);

    // When explicitly exiting compact mode via exitCompactFn (pull trigger or swipe up)
    expect(exitCompactFn).toBeDefined();
    await act(async () => {
      exitCompactFn();
    });
    expect(onLyricsCompactChange).toHaveBeenLastCalledWith(false);

    // After 3000ms of inactivity, controls automatically collapse back
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(onLyricsCompactChange).toHaveBeenLastCalledWith(true);
  });
});
