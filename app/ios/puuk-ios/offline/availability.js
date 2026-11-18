import { updateSetting } from '../shared/storage/settings';
import defaultAudioCache from '../utils/audioCache';
import {
  getOfflineSession,
  isOfflineSessionCurrent,
  notifyOfflineIndex,
} from './session';

export { readStorageBudget } from './budget';
export { readOfflineWaveStatus, subscribeOfflineAvailability } from './wave';
export {
  DEFAULT_OFFLINE_BUDGET_BYTES,
  DEFAULT_WAVE_RESERVE_MINUTES,
} from './policy';

export const setOfflineStorageLimit = (bytes) =>
  updateSetting('offlineBudgetBytes', bytes);
export const setWaveReserveTarget = (minutes) =>
  updateSetting('waveReserveMinutes', minutes);
export const setCellularDownloads = (enabled) =>
  updateSetting('allowCellularDownloads', Boolean(enabled));

export async function clearOrdinaryAudioCache() {
  const session = getOfflineSession();
  const result = await defaultAudioCache.clear();
  if (result.freedBytes > 0 && isOfflineSessionCurrent(session))
    notifyOfflineIndex({ type: 'cache-cleared', session });
  return result;
}
