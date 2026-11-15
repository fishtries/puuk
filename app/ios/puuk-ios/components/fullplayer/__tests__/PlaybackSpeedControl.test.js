import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Modal } from 'react-native';
import PlaybackSpeedControl from '../PlaybackSpeedControl';

let mockCloseCompletion;

jest.mock('@react-native-community/slider', () => 'SpeedSlider');
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  ReduceMotion: { System: 'system' },
  runOnUI: (fn) => fn,
  runOnJS: (fn) => fn,
  useSharedValue: (value) => ({ value }),
  useAnimatedStyle: (factory) => factory(),
  withSpring: (value) => value,
  withTiming: (value, _config, callback) => {
    if (callback) mockCloseCompletion = callback;
    return value;
  },
}));

test('opens speed control, changes speed while dragging, resets and closes', async () => {
  const onChange = jest.fn();
  const onVisibilityChange = jest.fn();
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlaybackSpeedControl
        rate={0.85}
        onChange={onChange}
        onVisibilityChange={onVisibilityChange}
      />,
      {
        createNodeMock: () => ({
          measureInWindow: (callback) => callback(150, 600, 44, 44),
        }),
      },
    );
  });
  renderer.root.findByProps({ collapsable: false }).instance.measureInWindow = (
    callback,
  ) => callback(150, 600, 44, 44);
  const button = (label) =>
    renderer.root.findAll((node) => node.props.accessibilityLabel === label)[0];
  await act(async () =>
    button('Скорость воспроизведения 0.85×').props.onPress(),
  );
  expect(renderer.root.findByType(Modal).props.visible).toBe(true);
  await act(async () => renderer.root.findByType(Modal).props.onShow());
  expect(onVisibilityChange).toHaveBeenLastCalledWith(true);
  await act(async () =>
    renderer.root.findByType('SpeedSlider').props.onValueChange(1.125),
  );
  expect(onChange).toHaveBeenLastCalledWith(1.125, { commit: false });
  const slider = renderer.root.findByType('SpeedSlider');
  expect(slider.props.minimumValue).toBe(0.75);
  expect(slider.props.maximumValue).toBe(1.5);
  expect(slider.props.step).toBe(0.005);
  expect(slider.props.accessibilityValue.text).toBe('1.125×');
  await act(async () => slider.props.onSlidingComplete(1.125));
  expect(onChange).toHaveBeenLastCalledWith(1.125);
  await act(async () => button('Замедлить на 0,005').props.onPress());
  expect(onChange).toHaveBeenLastCalledWith(1.12);
  await act(async () => button('Ускорить на 0,005').props.onPress());
  expect(onChange).toHaveBeenLastCalledWith(1.125);
  await act(async () =>
    button('Скорость 1.125×. Сбросить до 1×').props.onPress(),
  );
  expect(onChange).toHaveBeenLastCalledWith(1);
  await act(async () =>
    renderer.root.findByType('SpeedSlider').props.onValueChange(0.755),
  );
  await act(async () => button('Закрыть настройку скорости').props.onPress());
  expect(onChange).toHaveBeenLastCalledWith(0.755);
  expect(renderer.root.findAllByType(Modal)).toHaveLength(1);
  await act(async () => mockCloseCompletion(true));
  expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
  expect(onVisibilityChange).toHaveBeenLastCalledWith(false);
  await act(async () => renderer.unmount());
});

test('places the popover below a button near the top of the screen', async () => {
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlaybackSpeedControl rate={1} onChange={jest.fn()} />,
    );
  });
  renderer.root.findByProps({ collapsable: false }).instance.measureInWindow = (
    callback,
  ) => callback(270, 80, 44, 44);
  await act(async () => {
    renderer.root
      .findAll(
        (node) =>
          node.props.accessibilityLabel === 'Скорость воспроизведения 1×',
      )[0]
      .props.onPress();
  });
  const panel = renderer.root.findByProps({ accessibilityViewIsModal: true });
  expect(panel.props.style[1].top).toBe(132);
  await act(async () => renderer.unmount());
});
