import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { GestureDetector } from 'react-native-gesture-handler';
import ProgressBar, { PlaybackProgressClock } from '../ProgressBar';
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
  withTiming: (to) => to,
  Easing: { linear: value => value },
}));

it('updates exact progress without parent renders and leaves scrubbing in control', () => {
  let listener;
  const player = {
    currentStatus: { currentTime: 0, duration: 100 },
    addListener: (_name, callback) => {
      listener = callback;
      return { remove: jest.fn() };
    },
  };
  const isSlidingShared = { value: false };
  const slideProgressShared = { value: 0 };
  let renderer;
  act(() => {
    renderer = TestRenderer.create(<PlaybackProgressClock player={player}
      isPlayerVisible isSlidingShared={isSlidingShared} slideProgressShared={slideProgressShared} />);
  });
  const emit = (currentTime) => {
    player.currentStatus = { currentTime, duration: 100 };
    act(() => { listener(player.currentStatus); });
  };
  emit(0.15);
  expect(slideProgressShared.value).toBeCloseTo(0.0015);
  isSlidingShared.value = true;
  slideProgressShared.value = 0.8;
  emit(0.25);
  expect(slideProgressShared.value).toBe(0.8);
  isSlidingShared.value = false;
  emit(80.1);
  expect(slideProgressShared.value).toBeCloseTo(0.801);
  emit(20.2);
  expect(slideProgressShared.value).toBeCloseTo(0.202);
  act(() => { renderer.unmount(); });
});

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
