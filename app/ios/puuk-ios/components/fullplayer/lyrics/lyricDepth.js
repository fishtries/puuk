export const getLyricTarget = (rel) => {
  'worklet';
  const absRel = Math.abs(rel);
  if (absRel === 0) {
    return { scale: 1.0, opacity: 1.0, color: 1.0 };
  } else if (absRel === 1) {
    return { scale: 0.96, opacity: 0.60, color: 0.58 };
  } else if (absRel === 2) {
    return { scale: 0.94, opacity: 0.45, color: 0.38 };
  } else if (absRel === 3) {
    return { scale: 0.92, opacity: 0.32, color: 0.22 };
  } else if (absRel === 4) {
    return { scale: 0.91, opacity: 0.22, color: 0.12 };
  } else if (absRel === 5) {
    return { scale: 0.90, opacity: 0.16, color: 0.06 };
  } else if (absRel === 6) {
    return { scale: 0.89, opacity: 0.11, color: 0.02 };
  } else {
    return { scale: 0.88, opacity: 0.08, color: 0.0 };
  }
};

/**
 * Depth-of-field & dimming profile for the resting (auto-advancing) field.
 * Mirrored directly from web (app/web/src/components/lyrics/lyricsDepth.ts).
 */
export const getProgressiveValues = (index, activeIndex) => {
  'worklet';
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

  let blurAmount;
  let opacity;
  let scale;

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
};

/**
 * Manual-scroll clarity: during manual scroll, field returns to full clarity.
 */
export const SCROLL_CLARITY = { blur: 0, opacity: 1, scale: 1 };

/**
 * Wave-motion profile: traffic-jam-style stagger delays and spring stiffnesses.
 * Exact parity with web version (app/web/src/components/lyrics/lyricsDepth.ts).
 */
export const LEADING_SPRING = { delay: 0, stiffness: 185, damping: 20, mass: 0.8 };
export const MANUAL_SPRING = { delay: 0, stiffness: 260, damping: 28, mass: 0.55 };

export const getWaveSpring = (
  index,
  activeIndex,
  isInitial,
  isManualScrolling
) => {
  'worklet';
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
    let delay;
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
  let delay;
  if (dist === 1) delay = 0.045;
  else if (dist === 2) delay = 0.10;
  else if (dist === 3) delay = 0.16;
  else delay = Math.min(0.38, 0.16 + (dist - 3) * 0.04);

  return { delay, stiffness: 170, damping: 21, mass: 0.85 };
};

export const computeActiveLyricIndex = (lyricsList, curTime) => {
  if (!lyricsList || lyricsList.length === 0) return -1;
  const firstWithTime = lyricsList.find(l => l.time !== null);
  if (!firstWithTime) return -2; // unsynced
  if (curTime < firstWithTime.time) return -1; // intro before first line
  return lyricsList.findIndex((line, i) => {
    if (line.time === null) return false;
    if (curTime < line.time) return false;
    const nextLine = lyricsList.slice(i + 1).find(l => l.time !== null);
    if (!nextLine) return true;
    return curTime < nextLine.time;
  });
};
