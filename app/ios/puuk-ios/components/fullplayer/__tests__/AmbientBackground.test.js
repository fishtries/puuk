import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import AmbientBackground from '../AmbientBackground';
import * as apiModule from '../../../shared/api/api';

jest.mock('../../../shared/media/CoverImage', () => {
  const React = require('react');
  const { View } = require('react-native');
  return (props) => <View testID="ambient-cover-image" {...props} />;
});

jest.mock('expo-blur', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    BlurView: (props) => <View testID="ambient-blur-view" {...props} />,
  };
});

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: (props) => (
      <View testID="ambient-linear-gradient" {...props} />
    ),
  };
});

const mockCancelAnimation = jest.fn();
const mockWithTiming = jest.fn((to, config, cb) => {
  if (typeof cb === 'function') cb(true);
  return to;
});
const mockWithRepeat = jest.fn((anim) => anim);
const mockWithSequence = jest.fn((...anims) => anims[0]);

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {
      View: (props) => <View {...props} />,
    },
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    withTiming: (to, config, cb) => mockWithTiming(to, config, cb),
    withRepeat: (anim, count, reverse) => mockWithRepeat(anim, count, reverse),
    withSequence: (...anims) => mockWithSequence(...anims),
    cancelAnimation: (val) => mockCancelAnimation(val),
    runOnJS: (fn) => fn,
    interpolate: (val, input, output) => {
      if (val <= input[0]) return output[0];
      if (val >= input[1]) return output[1];
      return (
        output[0] +
        ((val - input[0]) / (input[1] - input[0])) * (output[1] - output[0])
      );
    },
    Extrapolation: { CLAMP: 'clamp' },
    Easing: {
      bezier: () => () => {},
    },
    ReduceMotion: {
      System: 'system',
    },
  };
});

jest.mock('../../../shared/api/api', () => ({
  authFetch: jest.fn(),
}));

describe('AmbientBackground - Apple Music Style Full Player Ambient Background', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const trackA = {
    id: 101,
    title: 'Track A',
    artist: 'Artist A',
    coverArt: 'https://puuk.fun/api/cover/101',
    cover_color: '#ff5500',
  };

  const trackB = {
    id: 102,
    title: 'Track B',
    artist: 'Artist B',
    coverArt: 'https://puuk.fun/api/cover/102',
    cover_color: '#00cc88',
  };

  const trackWithoutColor = {
    id: 103,
    title: 'Track C',
    artist: 'Artist C',
    coverArt: 'https://puuk.fun/api/cover/103',
  };

  it('renders with pointerEvents="none" and accessibility elements hidden', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AmbientBackground
          currentTrack={trackA}
          isPlaying={true}
          isPlayerVisible={true}
        />,
      );
    });

    const root = renderer.root;
    const outerViews = root.findAllByType(require('react-native').View);
    const container = outerViews[0];

    expect(container.props.pointerEvents).toBe('none');
    expect(container.props.accessibilityElementsHidden).toBe(true);
    expect(container.props.importantForAccessibility).toBe(
      'no-hide-descendants',
    );
  });

  it('renders hardware BlurView and multi-stop contrast vignette gradient', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AmbientBackground
          currentTrack={trackA}
          isPlaying={true}
          isPlayerVisible={true}
        />,
      );
    });

    const root = renderer.root;
    const blurView = root.findByProps({ testID: 'ambient-blur-view' });
    expect(blurView).toBeDefined();
    expect(blurView.props.tint).toBe('dark');

    const gradient = root.findByProps({ testID: 'ambient-linear-gradient' });
    expect(gradient).toBeDefined();
    expect(gradient.props.colors.length).toBe(4);
  });

  it('renders dual blurred CoverImage layers with heavy blurRadius', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AmbientBackground
          currentTrack={trackA}
          isPlaying={true}
          isPlayerVisible={true}
        />,
      );
    });

    const root = renderer.root;
    // Query host View elements with testID to match exact component instances
    const covers = root.findAll(
      (n) => n.type === 'View' && n.props.testID === 'ambient-cover-image',
    );
    expect(covers.length).toBe(2);
    expect(covers[0].props.source).toBe(trackA.coverArt);
    expect(covers[0].props.blurRadius).toBeGreaterThanOrEqual(45);
    expect(covers[1].props.blurRadius).toBeGreaterThanOrEqual(35);
  });

  it('uses vibrant track.cover_color for soft SVG radial gradient accent pools', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AmbientBackground
          currentTrack={trackA}
          isPlaying={true}
          isPlayerVisible={true}
        />,
      );
    });

    const root = renderer.root;
    const softOrbs = root.findAll(
      (n) => n.type === 'View' && n.props.testID === 'ambient-soft-orb',
    );
    expect(softOrbs.length).toBe(2);

    const stops = root.findAllByType(require('react-native-svg').Stop);
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0].props.stopColor).toBe(trackA.cover_color);
  });

  it('asynchronously requests /api/color/{id} when cover_color is absent and renders orbs once resolved', async () => {
    apiModule.authFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ color: '#9933ff' }),
    });

    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AmbientBackground
          currentTrack={trackWithoutColor}
          isPlaying={true}
          isPlayerVisible={true}
        />,
      );
    });

    expect(apiModule.authFetch).toHaveBeenCalledWith('/api/color/103');

    // Wait for promise resolution
    await act(async () => {
      await Promise.resolve();
    });

    const root = renderer.root;
    const softOrbs = root.findAll(
      (n) => n.type === 'View' && n.props.testID === 'ambient-soft-orb',
    );
    expect(softOrbs.length).toBe(2);

    const stops = root.findAllByType(require('react-native-svg').Stop);
    expect(stops[0].props.stopColor).toBe('#9933ff');
  });

  it('triggers double-buffered crossfade when switching tracks', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AmbientBackground
          currentTrack={trackA}
          isPlaying={true}
          isPlayerVisible={true}
        />,
      );
    });

    mockWithTiming.mockClear();

    await act(async () => {
      renderer.update(
        <AmbientBackground
          currentTrack={trackB}
          isPlaying={true}
          isPlayerVisible={true}
        />,
      );
    });

    // withTiming should be called with duration 650 for the crossfade
    expect(mockWithTiming).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ duration: 650 }),
      expect.any(Function),
    );
  });

  it('cancels motion animations when isPlayerVisible is false', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AmbientBackground
          currentTrack={trackA}
          isPlaying={true}
          isPlayerVisible={false}
        />,
      );
    });

    expect(mockCancelAnimation).toHaveBeenCalled();
  });

  it('runs breathing and drifting animations when isPlaying and isPlayerVisible are true', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AmbientBackground
          currentTrack={trackA}
          isPlaying={true}
          isPlayerVisible={true}
        />,
      );
    });

    expect(mockWithRepeat).toHaveBeenCalled();
  });

  it('gently returns to resting scale when paused', async () => {
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AmbientBackground
          currentTrack={trackA}
          isPlaying={false}
          isPlayerVisible={true}
        />,
      );
    });

    // Resting scale 1.2 with 1200ms easing
    expect(mockWithTiming).toHaveBeenCalledWith(
      1.2,
      expect.objectContaining({ duration: 1200 }),
      undefined,
    );
  });
});
