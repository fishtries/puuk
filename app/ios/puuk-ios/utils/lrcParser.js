export function isLrcSynced(lrcString) {
  if (!lrcString) return false;
  return /\[\d{2}:\d{2}\.\d{2,3}\]/.test(lrcString);
}

export function extractPlainLyrics(lrcString) {
  if (!lrcString) return '';
  const timeRegex = /\[\d{2}:\d{2}\.\d{2,3}\]/g;
  const metaRegex = /^\[(ar|ti|al|by|offset|length|re|ve):/i;
  const lines = lrcString.split('\n');
  const result = [];
  for (let line of lines) {
    const trimmed = line.trim();
    if (metaRegex.test(trimmed)) {
      continue;
    }
    const stripped = trimmed.replace(timeRegex, '').trim();
    result.push(stripped);
  }
  return result.join('\n').replace(/^\n+|\n+$/g, '');
}

export function parseLrc(lrcString) {
  if (!lrcString) return [];
  const lines = lrcString.split('\n');
  const parsed = [];
  
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
  const metaRegex = /^\[(ar|ti|al|by|offset|length|re|ve):/i;
  
  for (let line of lines) {
    const trimmed = line.trim();
    if (metaRegex.test(trimmed)) {
      continue;
    }
    const match = timeRegex.exec(line);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const milliseconds = match[3].length === 2 ? parseInt(match[3], 10) * 10 : parseInt(match[3], 10);
      
      const timeInSeconds = minutes * 60 + seconds + milliseconds / 1000;
      const text = line.replace(timeRegex, '').trim();
      
      parsed.push({ time: timeInSeconds, text });
    } else if (trimmed !== '') {
      parsed.push({ time: null, text: trimmed });
    }
  }
  
  const hasSynced = parsed.some(p => p.time !== null);
  if (hasSynced) {
    parsed.sort((a, b) => {
      if (a.time === null && b.time === null) return 0;
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      return a.time - b.time;
    });
  }
  
  return parsed;
}

