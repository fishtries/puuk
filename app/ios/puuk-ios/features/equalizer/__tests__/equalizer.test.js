jest.mock('expo', () => ({
  requireOptionalNativeModule: () => ({ configure: jest.fn() }),
}));
import {
  applyEqualizer,
  curveFor,
  nativeEQ,
  normalizeEQ,
  presets,
} from '../equalizer';

test('restores old settings as disabled and validates all seven saved gains', () => {
  expect(normalizeEQ(null)).toMatchObject({ enabled: false, preset: 'flat' });
  const eq = normalizeEQ({
    enabled: true,
    preset: 'custom',
    custom: [20, -14, NaN, null, 0, 2.4, 6],
  });
  expect(curveFor(eq)).toEqual([12, -12, 0, 0, 0, 2, 6]);
  expect(normalizeEQ({ preset: 'x', custom: [2] }).custom).toEqual(
    presets.flat,
  );
});

test('bypass, presets and returning to the saved custom curve reach the native processor', () => {
  const eq = {
    enabled: true,
    preset: 'custom',
    custom: [3, 4, 1, 0, -1, 0, -2],
  };
  for (const [config, expected] of [
    [eq, eq.custom],
    [{ ...eq, preset: 'bass' }, presets.bass],
    [{ ...eq, enabled: false }, presets.flat],
    [eq, eq.custom],
  ]) {
    applyEqualizer(config);
    expect(nativeEQ.configure).toHaveBeenLastCalledWith(expected);
  }
});
