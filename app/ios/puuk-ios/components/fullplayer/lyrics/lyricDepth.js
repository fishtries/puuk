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
