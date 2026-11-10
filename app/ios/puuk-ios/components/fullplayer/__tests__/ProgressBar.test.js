import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { GestureDetector } from 'react-native-gesture-handler';
import ProgressBar from '../ProgressBar';
import styles from '../playerStyles';

jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }) => children,
  Gesture: {
    Pan: () => {
      const gesture = {};
      for (const name of ['onBegin', 'onUpdate', 'onEnd', 'onFinalize']) {
        gesture[name] = (callback) => { gesture[`_${name}`] = callback; return gesture; };
      }
      return gesture;
    },
  },
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  useAnimatedStyle: (fn) => fn(),
  runOnJS: (fn) => fn,
}));

it('keeps a scrub gesture attached through state updates and cancels without seeking', () => {
  const seekTo = jest.fn();
  const props = { styles, seekTo, duration: 100, isSlidingShared: { value: false },
    sliderWidthShared: { value: 100 }, slideProgressShared: { value: 0 },
    durationShared: { value: 100 } };
  let renderer;
  act(() => { renderer = TestRenderer.create(<ProgressBar {...props} currentTime={10} />); });
  const gesture = renderer.root.findByType(GestureDetector).props.gesture;
  act(() => { gesture._onBegin({ x: 25 }); });
  expect(props.isSlidingShared.value).toBe(true);
  expect(renderer.root.findByType(GestureDetector).props.gesture).toBe(gesture);
  act(() => { renderer.update(<ProgressBar {...props} currentTime={10.1} />); });
  expect(renderer.root.findByType(GestureDetector).props.gesture).toBe(gesture);
  act(() => { gesture._onUpdate({ x: 75 }); });
  act(() => { gesture._onFinalize(); });
  expect(props.isSlidingShared.value).toBe(false);
  expect(seekTo).not.toHaveBeenCalled();
  act(() => { gesture._onBegin({ x: 75 }); });
  act(() => { gesture._onEnd(); gesture._onFinalize(); });
  expect(seekTo).toHaveBeenCalledTimes(1);
  expect(seekTo).toHaveBeenCalledWith(75);
  act(() => { renderer.unmount(); });
});
