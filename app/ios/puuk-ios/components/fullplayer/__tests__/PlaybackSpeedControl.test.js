import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Modal } from 'react-native';
import PlaybackSpeedControl from '../PlaybackSpeedControl';

jest.mock('@react-native-community/slider', () => 'SpeedSlider');

test('opens speed control, changes speed while dragging, resets and closes', async () => {
  const onChange = jest.fn();
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PlaybackSpeedControl rate={0.85} onChange={onChange} />,
    );
  });
  const button = (label) =>
    renderer.root.findAll((node) => node.props.accessibilityLabel === label)[0];
  await act(async () =>
    button('Скорость воспроизведения 0.85×').props.onPress(),
  );
  expect(renderer.root.findByType(Modal).props.visible).toBe(true);
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
  await act(async () => button('Обычная скорость 1×').props.onPress());
  expect(onChange).toHaveBeenLastCalledWith(1);
  await act(async () =>
    renderer.root.findByType('SpeedSlider').props.onValueChange(0.755),
  );
  await act(async () => button('Готово').props.onPress());
  expect(onChange).toHaveBeenLastCalledWith(0.755);
  expect(renderer.root.findByType(Modal).props.visible).toBe(false);
  await act(async () => renderer.unmount());
});
