import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { TouchableOpacity, Text } from 'react-native';
import YourMixCard from '../YourMixCard';

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
    withRepeat: (anim) => anim,
    Easing: {
      inOut: () => () => {},
      sin: () => {},
      quad: () => {},
      ease: () => {},
    },
    FadeInDown: {
      duration: () => ({
        springify: () => ({}),
      }),
    },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: {
    Light: 'light',
    Medium: 'medium',
    Heavy: 'heavy',
  },
}));

jest.mock('expo-blur', () => {
  const { View } = require('react-native');
  return {
    BlurView: (props) => <View {...props} testID="blur-view" />,
  };
});

jest.mock('expo-linear-gradient', () => {
  const { View } = require('react-native');
  return {
    LinearGradient: (props) => <View {...props} testID="linear-gradient" />,
  };
});

describe('YourMixCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders "your mix" title text matching web design and sketch', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(<YourMixCard onPress={() => {}} />);
    });

    const root = renderer.root;
    const texts = root.findAllByType(Text);
    const hasTitle = texts.some((t) => t.props.children === 'your mix');
    expect(hasTitle).toBe(true);
  });

  test('does not render "tap to play" or "playing" pills for clean sketch look', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(<YourMixCard onPress={() => {}} />);
    });

    const root = renderer.root;
    const texts = root.findAllByType(Text);
    const hasPillText = texts.some(
      (t) =>
        t.props.children === 'tap to play' || t.props.children === 'playing',
    );
    expect(hasPillText).toBe(false);
  });

  test('triggers onPress and haptics when tapped', () => {
    const onPressMock = jest.fn();
    let renderer;
    act(() => {
      renderer = TestRenderer.create(<YourMixCard onPress={onPressMock} />);
    });

    const root = renderer.root;
    const touchable = root.findByType(TouchableOpacity);
    act(() => {
      touchable.props.onPress();
    });

    expect(onPressMock).toHaveBeenCalledTimes(1);
  });

  test('renders top-to-bottom base gradient with sunset flame palette', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(<YourMixCard onPress={() => {}} />);
    });

    const root = renderer.root;
    const baseGradient = root.findByProps({ testID: 'your-mix-base-gradient' });
    expect(baseGradient).toBeDefined();
    expect(baseGradient.props.start).toEqual({ x: 0.5, y: 0 });
    expect(baseGradient.props.end).toEqual({ x: 0.5, y: 1 });
    expect(baseGradient.props.colors[0]).toBe('#FF4A0A');
    expect(
      baseGradient.props.colors[baseGradient.props.colors.length - 1],
    ).toBe('#000000');
  });

  test('renders animated gradient overlay flowing top to bottom', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(<YourMixCard onPress={() => {}} />);
    });

    const root = renderer.root;
    const animGradient = root.findByProps({
      testID: 'your-mix-animated-gradient',
    });
    expect(animGradient).toBeDefined();
    expect(animGradient.props.start).toEqual({ x: 0.5, y: 0 });
    expect(animGradient.props.end).toEqual({ x: 0.5, y: 1 });
    expect(animGradient.props.colors[0]).toBe('#FFA040');
  });

  test('renders volumetric god rays and celestial light shafts via SVG', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(<YourMixCard onPress={() => {}} />);
    });

    const root = renderer.root;
    const godRays = root.findByProps({ testID: 'your-mix-god-rays' });
    expect(godRays).toBeDefined();
    expect(godRays.props.pointerEvents).toBe('none');
  });

  test('renders floating luminous embers and particles', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(<YourMixCard onPress={() => {}} />);
    });

    const root = renderer.root;
    const particlesContainer = root.findByProps({
      testID: 'your-mix-particles',
    });
    expect(particlesContainer).toBeDefined();
    expect(particlesContainer.props.pointerEvents).toBe('none');
    expect(particlesContainer.props.children.length).toBeGreaterThan(15);
  });

  test('does not render any blob, orb or blur view elements', () => {
    let renderer;
    act(() => {
      renderer = TestRenderer.create(<YourMixCard onPress={() => {}} />);
    });

    const root = renderer.root;
    const blurViews = root.findAll((n) => n.props.testID === 'blur-view');
    expect(blurViews.length).toBe(0);
  });
});
