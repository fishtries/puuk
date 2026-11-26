import { requireOptionalNativeModule } from 'expo';

export const frequencies = [60, 150, 400, 1000, 2400, 6000, 14000];
export const presets = {
  flat: [0, 0, 0, 0, 0, 0, 0],
  bass: [5, 4, 1, 0, 0, 0, 0],
  vocal: [-2, -1, 0, 2, 3, 1, 0],
};
export const nativeEQ = requireOptionalNativeModule('PuukEqualizer');

export function normalizeEQ(value) {
  const custom =
    Array.isArray(value?.custom) && value.custom.length === frequencies.length
      ? value.custom.map((db) =>
          Number.isFinite(db) ? Math.max(-12, Math.min(12, Math.round(db))) : 0,
        )
      : presets.flat;
  const preset = ['flat', 'bass', 'vocal', 'custom'].includes(value?.preset)
    ? value.preset
    : 'flat';
  return { enabled: value?.enabled === true, preset, custom };
}

export function curveFor(eq) {
  return eq.preset === 'custom' ? eq.custom : presets[eq.preset];
}

export function applyEqualizer(value) {
  const eq = normalizeEQ(value);
  nativeEQ?.configure(eq.enabled ? curveFor(eq) : presets.flat);
}
