/**
 * Track loudness normalization (EBU R128 / LUFS) for iOS.
 * Computes safe linear gain based on server-analyzed track loudness and applies it
 * to the expo-audio player instance (0.0 to 1.0 volume range in AVPlayer).
 */

export const MIN_NORMALIZATION_GAIN_DB = -12.0;
export const MAX_NORMALIZATION_GAIN_DB = 12.0;

/**
 * Clamps dB gain to safe range [-12 dB, +12 dB].
 * @param {number} gainDb
 * @returns {number}
 */
export function clampGainDb(gainDb) {
  const num = Number(gainDb);
  if (isNaN(num) || !isFinite(num)) return 0;
  return Math.max(MIN_NORMALIZATION_GAIN_DB, Math.min(MAX_NORMALIZATION_GAIN_DB, num));
}

/**
 * Converts dB gain to linear amplitude ratio (10^(dB / 20)).
 * @param {number} gainDb
 * @returns {number}
 */
export function dbToLinear(gainDb) {
  const num = Number(gainDb);
  if (isNaN(num) || !isFinite(num)) return 1.0;
  const clamped = clampGainDb(num);
  return Math.pow(10, clamped / 20);
}

/**
 * Extracts normalization gain in dB from track DTO if sound check is enabled
 * and the track has been analyzed.
 * @param {Object|null|undefined} track
 * @param {boolean} isEnabled
 * @returns {number}
 */
export function computeTrackNormalizationGainDb(track, isEnabled) {
  if (!isEnabled || !track) return 0;
  if (track.loudness_status === 'analyzed' && track.normalization_gain_db != null) {
    const gain = Number(track.normalization_gain_db);
    if (isNaN(gain) || !isFinite(gain)) return 0;
    return clampGainDb(gain);
  }
  return 0;
}

/**
 * Calculates effective player volume (0.0 to 1.0) for AVPlayer.
 * Quiet tracks with positive gain (+dB) are limited to 1.0 in AVPlayer.
 * Loud tracks with negative gain (-dB) are attenuated below 1.0.
 *
 * @param {Object|null|undefined} track
 * @param {boolean} isEnabled
 * @returns {number}
 */
export function computeEffectivePlayerVolume(track, isEnabled) {
  if (!isEnabled || !track) return 1.0;
  const gainDb = computeTrackNormalizationGainDb(track, isEnabled);
  const linear = dbToLinear(gainDb);
  return Math.max(0.0, Math.min(1.0, linear));
}

/**
 * Safely applies volume normalization to an AudioPlayer instance.
 *
 * @param {Object} player
 * @param {Object|null|undefined} track
 * @param {boolean} isEnabled
 * @returns {number} The applied volume level (0.0 to 1.0)
 */
export function applyTrackNormalization(player, track, isEnabled) {
  const effectiveVolume = computeEffectivePlayerVolume(track, isEnabled);
  if (player && typeof player === 'object') {
    try {
      player.volume = effectiveVolume;
    } catch (err) {
      console.warn('[loudness] Failed to set player.volume:', err?.message || err);
    }
  }
  return effectiveVolume;
}
