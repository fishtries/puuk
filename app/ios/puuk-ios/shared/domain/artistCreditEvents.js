import { DeviceEventEmitter } from 'react-native';

export const ARTIST_CREDITS_UPDATED = 'PUUK_ARTIST_CREDITS_UPDATED';
export const emitArtistCreditsUpdated = (payload) => DeviceEventEmitter.emit(ARTIST_CREDITS_UPDATED, payload);
export const subscribeArtistCreditsUpdated = (listener) => {
  const subscription = DeviceEventEmitter.addListener(ARTIST_CREDITS_UPDATED, listener);
  return () => subscription.remove();
};
