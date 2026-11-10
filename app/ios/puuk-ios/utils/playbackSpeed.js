export const MIN_PLAYBACK_RATE = 0.75;
export const MAX_PLAYBACK_RATE = 1.5;
export const PLAYBACK_RATE_STEP = 0.005;

export function normalizePlaybackRate(value) {
  if (!Number.isFinite(value)) return null;
  const clamped = Math.min(
    MAX_PLAYBACK_RATE,
    Math.max(MIN_PLAYBACK_RATE, value),
  );
  return Number(
    (Math.round(clamped / PLAYBACK_RATE_STEP) * PLAYBACK_RATE_STEP).toFixed(3),
  );
}
