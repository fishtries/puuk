export const ROW_TYPES = {
  STANZA: 'stanza',
  HEADER: 'header',
  LYRIC: 'lyric',
};

const HEADER_REGEX = /^\[.+\]$/;

/**
 * Maps plain / unsynced lyric text into explicit stanza, header, and lyric rows.
 *
 * @param {string} text - Raw plain lyric text
 * @returns {Array<{ type: 'stanza' | 'header' | 'lyric', text?: string }>}
 */
export function parsePlainLyrics(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }

  const lines = text.split('\n');
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return { type: ROW_TYPES.STANZA };
    }
    const isHeader = HEADER_REGEX.test(trimmed);
    if (isHeader) {
      return {
        type: ROW_TYPES.HEADER,
        text: trimmed.replace(/^\[|\]$/g, ''),
      };
    }
    return {
      type: ROW_TYPES.LYRIC,
      text: trimmed,
    };
  });
}
