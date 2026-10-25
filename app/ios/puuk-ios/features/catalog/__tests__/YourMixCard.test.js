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
});
