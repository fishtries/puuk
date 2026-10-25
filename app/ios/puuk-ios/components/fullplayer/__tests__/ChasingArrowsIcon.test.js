import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ChasingArrowsIcon from '../ChasingArrowsIcon';

jest.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

jest.mock('expo-symbols', () => ({
  SymbolView: 'SymbolView',
}));

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: {
      createAnimatedComponent: (Comp) => Comp,
      View,
    },
    useAnimatedStyle: (fn) => fn(),
    interpolate: (val, input, output) => {
      if (val <= input[0]) return output[0];
      if (val >= input[input.length - 1]) return output[output.length - 1];
      const ratio = (val - input[0]) / (input[input.length - 1] - input[0]);
      return output[0] + ratio * (output[output.length - 1] - output[0]);
    },
    Extrapolation: { CLAMP: 'clamp' },
  };
});

describe('ChasingArrowsIcon', () => {
  it('renders 3 arrow symbols for direction="right"', async () => {
    const progress = { value: 0 };
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ChasingArrowsIcon
          progress={progress}
          direction="right"
          size={34}
          spacing={17}
          color="#ffffff"
        />,
      );
    });

    const root = renderer.root;
    const symbols = root.findAll((n) => n.type === 'SymbolView');
    expect(symbols.length).toBe(3);
    symbols.forEach((sym) => {
      expect(sym.props.name).toBe('play.fill');
      expect(sym.props.size).toBe(34);
      expect(sym.props.tintColor).toBe('#ffffff');
    });
  });

  it('renders 3 arrow symbols with flipped scaleX for direction="left"', async () => {
    const progress = { value: 0 };
    let renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ChasingArrowsIcon
          progress={progress}
          direction="left"
          size={28}
          spacing={14}
          color="#ffffff"
        />,
      );
    });

    const root = renderer.root;
    const symbols = root.findAll((n) => n.type === 'SymbolView');
    expect(symbols.length).toBe(3);
    symbols.forEach((sym) => {
      expect(sym.props.name).toBe('play.fill');
      expect(sym.props.size).toBe(28);
    });
  });
});
