export const DEFAULT_OFFLINE_BUDGET_BYTES = 5 * 1024 ** 3;
export const DEFAULT_WAVE_RESERVE_MINUTES = 60;
export const OFFLINE_DISK_MARGIN_BYTES = 50 * 1024 ** 2;

const positiveInteger = (value, max, fallback) =>
  Number.isSafeInteger(value) && value > 0 && value <= max ? value : fallback;

export function normalizeOfflineSetting(key, value) {
  if (key === 'offlineBudgetBytes')
    return positiveInteger(
      value,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_OFFLINE_BUDGET_BYTES,
    );
  if (key === 'waveReserveMinutes')
    return positiveInteger(value, 24 * 60, DEFAULT_WAVE_RESERVE_MINUTES);
  return value;
}
