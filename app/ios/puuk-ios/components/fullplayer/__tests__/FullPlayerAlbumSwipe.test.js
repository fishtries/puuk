import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import FullPlayerModal from '../../FullPlayerModal';
import * as Haptics from 'expo-haptics';
import * as CoverImageModule from '../../../shared/media/CoverImage';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
}));

jest.mock('../../../shared/media/CoverImage', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockCover = (props) => <View testID="cover-image" {...props} />;
  MockCover.prefetchCover = jest.fn();
  return {
    __esModule: true,
    default: MockCover,
    prefetchCover: jest.fn(),
  };
});

jest.mock('../lyrics/AppleLyricsView', () => 'AppleLyricsView');
jest.mock('../QueuePanel', () => 'QueuePanel');
jest.mock('../PlayerControls', () => 'PlayerControls');
jest.mock('../PlayerNetworkBanner', () => 'PlayerNetworkBanner');
jest.mock('../ChasingArrowsIcon', () => 'ChasingArrowsIcon');
jest.mock('../ProgressBar', () => 'ProgressBar');
jest.mock('../TrackLoadingBadge', () => 'TrackLoadingBadge');
jest.mock('../AmbientBackground', () => 'AmbientBackground');

jest.mock('@react-native-menu/menu', () => {
  const { View } = require('react-native');
  return {
    MenuView: (props) => <View testID="native-menu-view" {...props} />,
  };
});

jest.mock('react-native-safe-area-context', () => ({
  initialWindowMetrics: {
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  },
}));

let mockPanGestures = [];
jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureDetector: ({ children, gesture }) => (
      <View testID="gesture-detector">{children}</View>
    ),
    GestureHandlerRootView: ({ children }) => <View>{children}</View>,
    Gesture: {
      Simultaneous: () => ({}),
      Race: (...gestures) => ({ type: 'Race', gestures }),
      Pan: () => {
        const gesture = {
          _type: 'Pan',
          enabled: jest.fn(() => gesture),
          activeOffsetY: jest.fn(() => gesture),
          activeOffsetX: jest.fn(() => gesture),
          failOffsetX: jest.fn(() => gesture),
          failOffsetY: jest.fn(() => gesture),
          onStart: jest.fn((cb) => {
            gesture._onStart = cb;
            return gesture;
          }),
          onUpdate: jest.fn((cb) => {
            gesture._onUpdate = cb;
            return gesture;
          }),
          onEnd: jest.fn((cb) => {
            gesture._onEnd = cb;
            return gesture;
          }),
          onFinalize: jest.fn((cb) => {
            gesture._onFinalize = cb;
            return gesture;
          }),
        };
        mockPanGestures.push(gesture);
        return gesture;
      },
    },
  };
});

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  const createChain = () => {
    const chain = {
      springify: () => chain,
      damping: () => chain,
      stiffness: () => chain,
      duration: () => chain,
      easing: () => chain,
    };
    return chain;
  };
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Comp) => Comp,
      View,
      Text,
    },
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    withSpring: (to, config, cb) => {
      if (typeof cb === 'function') cb(true);
      return to;
    },
    withTiming: (to, config, cb) => {
      if (typeof cb === 'function') cb(true);
      return to;
    },
    withSequence: (...args) => args[0],
    cancelAnimation: jest.fn(),
    runOnJS: (fn) => fn,
    interpolate: () => 1,
    Extrapolation: { CLAMP: 'clamp' },
    Easing: {
      bezier: () => () => {},
    },
    ReduceMotion: {
      System: 'system',
      Always: 'always',
      Never: 'never',
    },
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    LinearTransition: createChain(),
  };
});

describe('FullPlayerModal - Album Swipe to switch next/prev track', () => {
  const mockCurrentTrack = {
    id: 'track-1',
    title: 'Current Song',
    artist: 'Artist One',
    coverArt: 'https://puuk.app/cover1.jpg',
  };

  const mockNextTrack = {
    id: 'track-2',
    title: 'Next Song',
    artist: 'Artist Two',
    coverArt: 'https://puuk.app/cover2.jpg',
  };

  const mockPrevTrack = {
    id: 'track-0',
    title: 'Previous Song',
    artist: 'Artist Zero',
    coverArt: 'https://puuk.app/cover0.jpg',
  };

  beforeEach(() => {
    mockPanGestures = [];
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  it('renders album art with accessibility attributes for VoiceOver', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockCurrentTrack}
          nextTrack={mockNextTrack}
          previousTrack={mockPrevTrack}
        />,
      );
    });

    const root = renderer.root;
    const albumView = root.find(
      (n) =>
        n.props?.accessibilityRole === 'image' &&
        n.props?.accessibilityHint?.includes('Swipe left'),
    );
    expect(albumView).toBeTruthy();
    expect(albumView.props.accessibilityLabel).toContain('Current Song');
    expect(albumView.props.accessibilityLabel).toContain('Artist One');
  });

  it('prefetches next and previous cover images', async () => {
    await act(async () => {
      TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockCurrentTrack}
          nextTrack={mockNextTrack}
          previousTrack={mockPrevTrack}
        />,
      );
    });

    expect(CoverImageModule.prefetchCover).toHaveBeenCalledWith(
      'https://puuk.app/cover2.jpg',
    );
    expect(CoverImageModule.prefetchCover).toHaveBeenCalledWith(
      'https://puuk.app/cover0.jpg',
    );
  });

  it('swiping left on album triggers fetchNextTrack and light haptic feedback', async () => {
    const fetchNextTrack = jest.fn();
    const playPreviousTrack = jest.fn();

    await act(async () => {
      TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockCurrentTrack}
          nextTrack={mockNextTrack}
          previousTrack={mockPrevTrack}
          fetchNextTrack={fetchNextTrack}
          playPreviousTrack={playPreviousTrack}
        />,
      );
    });

    // Find the horizontal album swipe gesture (has activeOffsetX([-12, 12]))
    const horizontalGesture = mockPanGestures.find((g) =>
      g.activeOffsetX.mock.calls.some(
        (c) => Array.isArray(c[0]) && c[0][0] === -12,
      ),
    );
    expect(horizontalGesture).toBeTruthy();

    // Start gesture
    horizontalGesture._onStart?.();

    // Swipe left (negative translationX exceeding threshold)
    horizontalGesture._onUpdate?.({ translationX: -150 });

    // End gesture with release velocity
    act(() => {
      horizontalGesture._onEnd?.({ translationX: -150, velocityX: -400 });
    });

    expect(Haptics.impactAsync).toHaveBeenCalledWith('light');
    expect(fetchNextTrack).toHaveBeenCalledTimes(1);
    expect(playPreviousTrack).not.toHaveBeenCalled();
  });

  it('swiping right on album triggers playPreviousTrack with force: true and light haptic feedback', async () => {
    const fetchNextTrack = jest.fn();
    const playPreviousTrack = jest.fn();

    await act(async () => {
      TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockCurrentTrack}
          nextTrack={mockNextTrack}
          history={[mockPrevTrack]}
          fetchNextTrack={fetchNextTrack}
          playPreviousTrack={playPreviousTrack}
        />,
      );
    });

    const horizontalGesture = mockPanGestures.find((g) =>
      g.activeOffsetX.mock.calls.some(
        (c) => Array.isArray(c[0]) && c[0][0] === -12,
      ),
    );
    expect(horizontalGesture).toBeTruthy();

    horizontalGesture._onStart?.();
    horizontalGesture._onUpdate?.({ translationX: 150 });

    act(() => {
      horizontalGesture._onEnd?.({ translationX: 150, velocityX: 400 });
    });

    expect(Haptics.impactAsync).toHaveBeenCalledWith('light');
    expect(playPreviousTrack).toHaveBeenCalledWith({ force: true });
    expect(fetchNextTrack).not.toHaveBeenCalled();
  });

  it('swiping right when there is no previous track does not trigger playPreviousTrack', async () => {
    const playPreviousTrack = jest.fn();

    await act(async () => {
      TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockCurrentTrack}
          nextTrack={mockNextTrack}
          history={[]}
          previousTrack={null}
          playPreviousTrack={playPreviousTrack}
        />,
      );
    });

    const horizontalGesture = mockPanGestures.find((g) =>
      g.activeOffsetX.mock.calls.some(
        (c) => Array.isArray(c[0]) && c[0][0] === -12,
      ),
    );
    expect(horizontalGesture).toBeTruthy();

    horizontalGesture._onStart?.();
    horizontalGesture._onUpdate?.({ translationX: 150 });

    act(() => {
      horizontalGesture._onEnd?.({ translationX: 150, velocityX: 400 });
    });

    expect(playPreviousTrack).not.toHaveBeenCalled();
  });

  it('smoothly springs in new track when currentTrack updates after swipe', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockCurrentTrack}
          nextTrack={mockNextTrack}
        />,
      );
    });

    const horizontalGesture = mockPanGestures.find((g) =>
      g.activeOffsetX.mock.calls.some(
        (c) => Array.isArray(c[0]) && c[0][0] === -12,
      ),
    );
    expect(horizontalGesture).toBeTruthy();

    horizontalGesture._onStart?.();
    horizontalGesture._onUpdate?.({ translationX: -150 });
    act(() => {
      horizontalGesture._onEnd?.({ translationX: -150, velocityX: -400 });
    });

    // Parent updates currentTrack to mockNextTrack
    await act(async () => {
      renderer.update(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={mockNextTrack}
          nextTrack={null}
          previousTrack={mockCurrentTrack}
        />,
      );
    });

    const root = renderer.root;
    const albumView = root.find(
      (n) =>
        n.props?.accessibilityRole === 'image' &&
        n.props?.accessibilityHint?.includes('Swipe left'),
    );
    expect(albumView.props.accessibilityLabel).toContain('Next Song');
    expect(albumView.props.accessibilityLabel).toContain('Artist Two');
  });

  it('does not create duplicate adjacent cards when nextTrack has equivalent numeric/string ID', async () => {
    const fetchNextTrack = jest.fn();
    const currentTrackNumeric = {
      id: 42,
      title: 'Track 42',
      artist: 'Artist',
      coverArt: 'https://puuk.app/cover42.jpg',
    };
    const nextTrackString = {
      id: '42',
      title: 'Track 42 String',
      artist: 'Artist',
      coverArt: 'https://puuk.app/cover42_str.jpg',
    };

    await act(async () => {
      TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={currentTrackNumeric}
          nextTrack={nextTrackString}
          upNextQueue={[]}
          fetchNextTrack={fetchNextTrack}
        />,
      );
    });

    // nextTrackString should NOT be prefetched because it's equivalent to currentTrack
    expect(CoverImageModule.prefetchCover).not.toHaveBeenCalledWith(
      'https://puuk.app/cover42_str.jpg',
    );

    const horizontalGesture = mockPanGestures.find((g) =>
      g.activeOffsetX.mock.calls.some(
        (c) => Array.isArray(c[0]) && c[0][0] === -12,
      ),
    );
    expect(horizontalGesture).toBeTruthy();

    horizontalGesture._onStart?.();
    horizontalGesture._onUpdate?.({ translationX: -150 });
    act(() => {
      horizontalGesture._onEnd?.({ translationX: -150, velocityX: -400 });
    });

    // Swiping left should not trigger fetchNextTrack because effectiveNextTrack is null
    expect(fetchNextTrack).not.toHaveBeenCalled();
  });

  it('recognizes legacy track_id with blank id and treats matching nextTrack as duplicate', async () => {
    const currentLegacyTrack = {
      id: '   ',
      track_id: 'legacy-99',
      title: 'Legacy Current',
      artist: 'Artist',
    };
    const nextCanonicalTrack = {
      id: 'legacy-99',
      title: 'Canonical Next',
      artist: 'Artist',
      coverArt: 'https://puuk.app/cover-dup.jpg',
    };

    await act(async () => {
      TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={currentLegacyTrack}
          nextTrack={nextCanonicalTrack}
          upNextQueue={[]}
        />,
      );
    });

    expect(CoverImageModule.prefetchCover).not.toHaveBeenCalledWith(
      'https://puuk.app/cover-dup.jpg',
    );
  });

  it('preserves numeric zero in identity equivalence and avoids duplicate adjacent cards', async () => {
    const currentZero = {
      id: 0,
      title: 'Zero Current',
      artist: 'Artist',
    };
    const nextZero = {
      track_id: '0',
      title: 'Zero Next',
      artist: 'Artist',
      coverArt: 'https://puuk.app/cover-zero.jpg',
    };

    await act(async () => {
      TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={currentZero}
          nextTrack={nextZero}
          upNextQueue={[]}
        />,
      );
    });

    expect(CoverImageModule.prefetchCover).not.toHaveBeenCalledWith(
      'https://puuk.app/cover-zero.jpg',
    );
  });

  it('allows nextTrack when IDs are distinct even if one uses legacy track_id with blank id', async () => {
    const currentLegacy = {
      id: '   ',
      track_id: 'legacy-alpha',
      title: 'Alpha',
      artist: 'Artist',
    };
    const nextDistinct = {
      id: 'canonical-beta',
      title: 'Beta',
      artist: 'Artist',
      coverArt: 'https://puuk.app/cover-beta.jpg',
    };

    await act(async () => {
      TestRenderer.create(
        <FullPlayerModal
          isPlayerVisible={true}
          currentTrack={currentLegacy}
          nextTrack={nextDistinct}
        />,
      );
    });

    expect(CoverImageModule.prefetchCover).toHaveBeenCalledWith(
      'https://puuk.app/cover-beta.jpg',
    );
  });
});
