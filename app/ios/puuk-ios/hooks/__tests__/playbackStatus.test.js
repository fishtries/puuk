import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { getPlaybackSnapshot, usePlaybackPosition, usePlaybackState } from '../playbackStatus';

function nativePlayer() {
  const callbacks = new Set();
  const player = {
    currentStatus: { currentTime: 0, duration: 100, playing: true, isLoaded: true,
      nativeEvent: 'progress', sourceAttemptId: 'A' },
    removals: 0,
    addListener: jest.fn((_name, cb) => {
      callbacks.add(cb);
      return { remove: () => { callbacks.delete(cb); player.removals++; } };
    }),
    emit: patch => {
      player.currentStatus = { ...player.currentStatus, ...patch };
      for (const cb of callbacks) cb(player.currentStatus);
    },
  };
  return player;
}

test('one native subscription isolates exact positions from transport renders and preserves semantic events', () => {
  const player = nativePlayer();
  let state, position, stateRenders = 0, positionRenders = 0;
  function State() { state = usePlaybackState(player); stateRenders++; return null; }
  function Position() { position = usePlaybackPosition(player); positionRenders++; return null; }
  let renderer;
  act(() => { renderer = TestRenderer.create(<><State /><Position /></>); });
  expect(player.addListener).toHaveBeenCalledTimes(1);
  const initialRenders = stateRenders;
  const initialPositionRenders = positionRenders;
  for (let i = 1; i <= 9; i++) {
    act(() => { player.emit({ currentTime: i / 10 }); });
  }
  expect(stateRenders).toBe(initialRenders);
  expect(positionRenders).toBe(initialPositionRenders + 9);
  expect(state.currentTime).toBe(0);
  expect(position.currentTime).toBe(0.9);
  expect(getPlaybackSnapshot(player).currentTime).toBe(0.9);
  act(() => { player.emit({ currentTime: 1 }); });
  expect(stateRenders).toBe(initialRenders + 1);
  act(() => { player.emit({ playing: false, currentTime: 1.05 }); });
  expect(state.playing).toBe(false);
  act(() => { player.emit({ currentTime: 0.2, nativeEvent: 'seekIntent' }); });
  expect(state.currentTime).toBe(0.2);
  expect(position.currentTime).toBe(0.2);
  act(() => { player.emit({ sourceAttemptId: 'B', duration: 200, currentTime: 0 }); });
  expect(state.sourceAttemptId).toBe('B');
  expect(position).toEqual({ currentTime: 0, duration: 200 });
  act(() => { player.emit({ didJustFinish: true, currentTime: 200 }); });
  expect(state.didJustFinish).toBe(true);
  act(() => { player.emit({ error: { message: 'test' } }); });
  expect(state.error.message).toBe('test');
  act(() => { renderer.unmount(); });
  expect(player.removals).toBe(1);
});

test('hidden progress unsubscribes, resumes at the latest position, and switches players without stale snapshots', () => {
  const first = nativePlayer();
  const second = nativePlayer();
  second.currentStatus = { ...second.currentStatus, currentTime: 25 };
  let position;
  function Position({ player, visible }) {
    position = usePlaybackPosition(player, visible);
    return null;
  }
  let renderer;
  act(() => { renderer = TestRenderer.create(<Position player={first} visible />); });
  act(() => { renderer.update(<Position player={first} visible={false} />); });
  expect(first.removals).toBe(1);
  first.emit({ currentTime: 12.5 });
  act(() => { renderer.update(<Position player={first} visible />); });
  expect(position.currentTime).toBe(12.5);
  act(() => { renderer.update(<Position player={second} visible />); });
  expect(position.currentTime).toBe(25);
  act(() => { first.emit({ currentTime: 50 }); });
  expect(position.currentTime).toBe(25);
  act(() => { renderer.unmount(); });
  expect(second.removals).toBe(1);
});
