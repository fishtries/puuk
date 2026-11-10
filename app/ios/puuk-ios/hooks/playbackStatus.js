import { useCallback, useSyncExternalStore } from 'react';

const EMPTY = Object.freeze({ currentTime: 0, duration: 0, playing: false });
const stores = new WeakMap();
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

// One native subscription per player. React's transport consumers observe
// whole seconds and semantic changes; progress consumers observe exact audio
// positions. Snapshots stay cached between notifications (useSyncExternalStore).
function getStore(player) {
  let store = stores.get(player);
  if (store) return store;
  let latest = player.currentStatus || EMPTY;
  let state = latest;
  let position = { currentTime: latest.currentTime || 0, duration: latest.duration || 0 };
  let subscription;
  const stateListeners = new Set();
  const positionListeners = new Set();
  const receive = (event) => {
    const previous = latest;
    latest = event;
    const keys = new Set([...Object.keys(previous), ...Object.keys(event)]);
    const stateChanged = Math.floor(previous.currentTime || 0) !== Math.floor(event.currentTime || 0) ||
      [...keys].some(key => key !== 'currentTime' && key !== 'currentOffsetFromLive' &&
        !Object.is(previous[key], event[key]));
    const positionChanged = position.currentTime !== (event.currentTime || 0) ||
      position.duration !== (event.duration || 0);
    if (stateChanged) state = event;
    if (positionChanged) position = { currentTime: event.currentTime || 0, duration: event.duration || 0 };
    if (stateChanged) for (const listener of stateListeners) listener();
    if (positionChanged) for (const listener of positionListeners) listener();
  };
  const subscribe = (listeners, listener) => {
    listeners.add(listener);
    if (!subscription) {
      subscription = player.addListener('playbackStatusUpdate', receive);
      // Catch changes between render and subscription, including a remount.
      if (player.currentStatus) receive(player.currentStatus);
    }
    return () => {
      listeners.delete(listener);
      if (stateListeners.size === 0 && positionListeners.size === 0) {
        subscription?.remove();
        subscription = undefined;
      }
    };
  };
  store = {
    state: () => state,
    position: () => position,
    latest: () => latest,
    subscribeState: listener => subscribe(stateListeners, listener),
    subscribePosition: listener => subscribe(positionListeners, listener),
  };
  stores.set(player, store);
  return store;
}

export function getPlaybackSnapshot(player) {
  return player ? getStore(player).latest() : EMPTY;
}

export function usePlaybackState(player) {
  const store = player ? getStore(player) : null;
  return useSyncExternalStore(store?.subscribeState || noopSubscribe, store?.state || emptySnapshot);
}

export function usePlaybackPosition(player, enabled = true) {
  const store = player && enabled ? getStore(player) : null;
  const subscribe = useCallback(listener => store ? store.subscribePosition(listener) : () => {}, [store]);
  return useSyncExternalStore(subscribe, store?.position || emptySnapshot);
}
