import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import Svg, { Path } from 'react-native-svg';
import { PixelRatio } from 'react-native';
import GlowTrackBoundary from '../GlowTrackBoundary';

test('reuses the filtered SVG for subpixel ticks and updates for progress, seeks and track colors', () => {
  let renderer;
  const render = (currentTime, accentColor = '#FFDAB9') =>
    <GlowTrackBoundary currentTime={currentTime} duration={1000} width={390} accentColor={accentColor} />;
  act(() => { renderer = TestRenderer.create(render(500)); });
  const initial = renderer.root.findByType(Svg).props;
  const offset = () => renderer.root.findAllByType(Path)
    .find(node => node.props.strokeDashoffset !== undefined)?.props.strokeDashoffset;
  const middleOffset = offset();
  act(() => { renderer.update(render(500.000001)); });
  expect(renderer.root.findByType(Svg).props).toBe(initial);
  act(() => { renderer.update(render(600)); });
  expect(offset()).toBeLessThan(middleOffset);
  act(() => { renderer.update(render(200)); });
  expect(offset()).toBeGreaterThan(middleOffset);
  const beforeColor = renderer.root.findByType(Svg).props;
  act(() => { renderer.update(render(200, '#ff0000')); });
  expect(renderer.root.findByType(Svg).props).not.toBe(beforeColor);
  act(() => { renderer.update(render(1000)); });
  expect(offset()).toBe(0);
  act(() => { renderer.update(render(0)); });
  expect(offset()).toBeUndefined();
  act(() => { renderer.unmount(); });
});

test('a short track can still cross a physical pixel on every 100ms audio tick', () => {
  const density = jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
  let renderer;
  const render = time => <GlowTrackBoundary currentTime={time} duration={104.856} width={390} />;
  try {
    act(() => { renderer = TestRenderer.create(render(20)); });
    let previous = renderer.root.findByType(Svg).props;
    let changes = 0;
    for (let i = 1; i <= 10; i++) {
      act(() => { renderer.update(render(20 + i * 0.1)); });
      const current = renderer.root.findByType(Svg).props;
      if (current !== previous) changes++;
      previous = current;
    }
    expect(changes).toBe(10);
  } finally {
    act(() => { renderer?.unmount(); });
    density.mockRestore();
  }
});

test('live position updates reuse native props and unsubscribe when the player covers the boundary', () => {
  const callbacks = new Set();
  const remove = jest.fn();
  const player = {
    currentStatus: { currentTime: 500, duration: 1000 },
    addListener: jest.fn((_name, callback) => {
      callbacks.add(callback);
      return { remove: () => { callbacks.delete(callback); remove(); } };
    }),
  };
  const emit = patch => {
    player.currentStatus = { ...player.currentStatus, ...patch };
    act(() => { for (const callback of callbacks) callback(player.currentStatus); });
  };
  let renderer;
  act(() => { renderer = TestRenderer.create(<GlowTrackBoundary player={player} isVisible width={390} />); });
  const first = renderer.root.findByType(Svg).props;
  emit({ currentTime: 500.000001 });
  expect(renderer.root.findByType(Svg).props).toBe(first);
  emit({ currentTime: 0, duration: 200 });
  expect(renderer.root.findAllByType(Path).filter(node => node.props.strokeDashoffset !== undefined)).toHaveLength(0);
  act(() => { renderer.update(<GlowTrackBoundary player={player} isVisible={false} width={390} />); });
  expect(remove).toHaveBeenCalledTimes(1);
  const hidden = renderer.root.findByType(Svg).props;
  emit({ currentTime: 80 });
  expect(renderer.root.findByType(Svg).props).toBe(hidden);
  act(() => { renderer.update(<GlowTrackBoundary player={player} isVisible width={430} />); });
  expect(renderer.root.findByType(Svg).props.width).toBe(430);
  expect(renderer.root.findAllByType(Path).some(node => node.props.strokeDashoffset > 0)).toBe(true);
  act(() => { renderer.unmount(); });
  expect(remove).toHaveBeenCalledTimes(2);
});
