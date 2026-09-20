/**
 * Depth-of-field & dimming profile for the resting (auto-advancing) field.
 * Apple keeps the active line crisp and renders the past/future into a soft
 * depth of field that deepens with distance.
 */

export interface ProgressiveValues {
  blur: number;
  opacity: number;
  scale: number;
}

export function getProgressiveValues(index: number, activeIndex: number): ProgressiveValues {
  if (activeIndex === -1) {
    const delta = index;
    const blurAmount = Math.min(10, delta * 2.2);
    const opacity = Math.max(0.12, 0.75 - delta * 0.14);
    return {
      blur: Number(blurAmount.toFixed(1)),
      opacity: Number(opacity.toFixed(2)),
      scale: 0.97,
    };
  }

  if (index === activeIndex) {
    return {
      blur: 0,
      opacity: 1,
      scale: 1.03,
    };
  }

  const delta = Math.abs(index - activeIndex);

  let blurAmount: number;
  let opacity: number;
  let scale: number;

  if (delta === 1) {
    blurAmount = 0.5;
    opacity = 0.65;
    scale = 0.985;
  } else if (delta === 2) {
    blurAmount = 2.0;
    opacity = 0.42;
    scale = 0.97;
  } else if (delta === 3) {
    blurAmount = 4.5;
    opacity = 0.25;
    scale = 0.955;
  } else {
    blurAmount = Math.min(8.0, 4.5 + (delta - 3) * 1.5);
    opacity = Math.max(0.08, 0.25 - (delta - 3) * 0.04);
    scale = 0.94;
  }

  return {
    blur: Number(blurAmount.toFixed(1)),
    opacity: Number(opacity.toFixed(2)),
    scale: Number(scale.toFixed(3)),
  };
}

/**
 * Manual-scroll clarity: while the user drives the scroll themselves we drop
 * the per-line dimming and text blur entirely, leaving only the edge vignettes
 * to soften the top/bottom boundaries.
 */
export const SCROLL_CLARITY: ProgressiveValues = { blur: 0, opacity: 1, scale: 1 };

/**
 * Wave-motion profile: traffic-jam-style stagger delays and spring stiffnesses.
 */
export interface WaveSpring {
  delay: number;
  stiffness: number;
  damping: number;
  mass: number;
}

const LEADING_SPRING: WaveSpring = { delay: 0, stiffness: 185, damping: 20, mass: 0.8 };
const MANUAL_SPRING: WaveSpring = { delay: 0, stiffness: 260, damping: 28, mass: 0.55 };

export function getWaveSpring(
  index: number,
  activeIndex: number,
  isInitial: boolean,
  isManualScrolling: boolean
): WaveSpring {
  // While the user scrolls by hand: no wave stagger, synchronous movement
  if (isManualScrolling) {
    return MANUAL_SPRING;
  }

  if (isInitial || activeIndex < 0) {
    return { delay: 0, stiffness: 175, damping: 21, mass: 0.85 };
  }

  if (index === activeIndex) {
    return LEADING_SPRING;
  }

  if (index > activeIndex) {
    // Cars behind: traffic reaction delay & weighted follow-through
    const dist = index - activeIndex;
    let delay: number;
    if (dist === 1) delay = 0.13;
    else if (dist === 2) delay = 0.23;
    else if (dist === 3) delay = 0.31;
    else if (dist === 4) delay = 0.38;
    else delay = Math.min(0.50, 0.38 + (dist - 4) * 0.04);

    return {
      delay,
      stiffness: Math.max(120, 180 - dist * 9),
      damping: Math.min(26, 20 + dist * 0.9),
      mass: Math.min(1.4, 0.8 + dist * 0.1),
    };
  }

  // Cars ahead: elastic cascade pulling upward into the blurred past
  const dist = activeIndex - index;
  let delay: number;
  if (dist === 1) delay = 0.045;
  else if (dist === 2) delay = 0.10;
  else if (dist === 3) delay = 0.16;
  else delay = Math.min(0.38, 0.16 + (dist - 3) * 0.04);

  return { delay, stiffness: 170, damping: 21, mass: 0.85 };
}
