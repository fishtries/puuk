import {
  CORNER_RADIUS,
  SVG_PAD_TOP,
  SVG_PAD_BOTTOM,
  SVG_HEIGHT,
  getBoundaryTotalLength,
  getBoundaryPathD,
  getPointOnBoundary,
  getProgressFromX,
} from '../boundaryGeometry';

describe('boundaryGeometry', () => {
  const W = 390;
  const R = 32;

  test('has correct constants with top headroom for glow without clipping', () => {
    expect(CORNER_RADIUS).toBe(32);
    expect(SVG_PAD_TOP).toBe(50);
    expect(SVG_PAD_BOTTOM).toBe(2);
    expect(SVG_HEIGHT).toBe(84);
  });

  test('calculates correct total boundary length', () => {
    const total = getBoundaryTotalLength(W, R);
    const expected = Math.PI * R + (W - 2 * R);
    expect(total).toBeCloseTo(expected, 4);
    expect(total).toBeGreaterThan(W);
  });

  test('generates valid SVG path d string with default padding', () => {
    const pathD = getBoundaryPathD(W, R);
    expect(pathD).toContain(`M 0 50`);
    expect(pathD).toContain(`A ${R} ${R} 0 0 0 ${R} 82`);
    expect(pathD).toContain(`L ${W - R} 82`);
    expect(pathD).toContain(`A ${R} ${R} 0 0 0 ${W} 50`);
  });

  test('generates valid SVG path d string with explicit custom yPad', () => {
    const pathD = getBoundaryPathD(W, R, 2);
    expect(pathD).toContain(`M 0 2`);
    expect(pathD).toContain(`A ${R} ${R} 0 0 0 ${R} 34`);
    expect(pathD).toContain(`L ${W - R} 34`);
    expect(pathD).toContain(`A ${R} ${R} 0 0 0 ${W} 2`);
  });

  test('returns exact endpoints and normal angles for progress 0.0, 0.5, 1.0', () => {
    const p0 = getPointOnBoundary(0, W, R, 2);
    expect(p0.x).toBeCloseTo(0, 2);
    expect(p0.y).toBeCloseTo(2, 2);
    expect(p0.angle).toBeCloseTo(-90, 1);

    const pHalf = getPointOnBoundary(0.5, W, R, 2);
    expect(pHalf.x).toBeCloseTo(W / 2, 2);
    expect(pHalf.y).toBeCloseTo(R + 2, 2);
    expect(pHalf.angle).toBe(0);

    const p1 = getPointOnBoundary(1, W, R, 2);
    expect(p1.x).toBeCloseTo(W, 2);
    expect(p1.y).toBeCloseTo(2, 2);
    expect(p1.angle).toBeCloseTo(90, 1);
  });

  test('converts touch X coordinate back to progress with high fidelity', () => {
    const testCases = [0.0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1.0];
    for (const p of testCases) {
      const pt = getPointOnBoundary(p, W, R, 2);
      const recoveredP = getProgressFromX(pt.x, W, R);
      expect(recoveredP).toBeCloseTo(p, 4);
    }
  });

  test('clamps out-of-range values gracefully', () => {
    const neg = getPointOnBoundary(-0.5, W, R, 2);
    expect(neg.x).toBeCloseTo(0, 2);

    const over = getPointOnBoundary(1.5, W, R, 2);
    expect(over.x).toBeCloseTo(W, 2);

    expect(getProgressFromX(-50, W, R)).toBe(0);
    expect(getProgressFromX(W + 50, W, R)).toBe(1);
  });
});
