import {
  validateAndParseWordLyrics,
  getWordState,
  computeActiveWordLineIndex,
  getCodePoints,
  sliceCodePoints,
  buildLineSegments,
} from '../wordLyricsParser';
import syntheticFixture from './fixtures/word_lyrics_synthetic.json';

describe('wordLyricsParser', () => {
  describe('Unicode & Code Points', () => {
    it('correctly counts code points for emoji and Cyrillic', () => {
      const text = 'Hello 🎶 world!';
      const codePoints = getCodePoints(text);
      expect(codePoints.length).toBe(14);
      expect(sliceCodePoints(codePoints, 6, 7)).toBe('🎶');
    });

    it('builds line segments with inter-word whitespace and punctuation', () => {
      const words = [
        { id: 'w1', from: 0, to: 5, startMs: 100, endMs: 500 },
        { id: 'w2', from: 7, to: 12, startMs: 600, endMs: 900 },
      ];
      const segments = buildLineSegments('Hello, world!', words);
      expect(segments).toEqual([
        { isWord: true, id: 'w1', text: 'Hello', startMs: 100, endMs: 500 },
        { isWord: false, text: ', ' },
        { isWord: true, id: 'w2', text: 'world', startMs: 600, endMs: 900 },
        { isWord: false, text: '!' },
      ]);
    });
  });

  describe('Contract v1 Validation on Synthetic Fixture', () => {
    it('parses valid synthetic fixture completely', () => {
      const parsed = validateAndParseWordLyrics(syntheticFixture, 'test-track-001');
      expect(parsed).not.toBeNull();
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.lines).toHaveLength(4);

      // Line 0: Hello, world! 🎶
      expect(parsed.lines[0].words).toHaveLength(3);
      expect(parsed.lines[0].words[2].text).toBe('🎶');

      // Line 3: fallback line with words: []
      expect(parsed.lines[3].words).toHaveLength(0);
      expect(parsed.lines[3].hasWordTimings).toBe(false);
      expect(parsed.lines[3].text).toBe('Строка без слов с акцентом');
    });

    it('rejects payload when expectedTrackId mismatches', () => {
      const parsed = validateAndParseWordLyrics(syntheticFixture, 'different-track-id');
      expect(parsed).toBeNull();
    });

    it('rejects payload with schemaVersion != 1', () => {
      const bad = { ...syntheticFixture, schemaVersion: 2 };
      expect(validateAndParseWordLyrics(bad)).toBeNull();
    });

    it('rejects payload with overlapping word character ranges', () => {
      const bad = JSON.parse(JSON.stringify(syntheticFixture));
      // make word 2 overlap word 1
      bad.lines[0].words[1].from = 3;
      expect(validateAndParseWordLyrics(bad)).toBeNull();
    });

    it('preserves inverted word times and textual occurrence order', () => {
      const bad = JSON.parse(JSON.stringify(syntheticFixture));
      bad.lines[0].words[1].startMs = 500;
      bad.lines[0].startMs = 500;
      const parsed = validateAndParseWordLyrics(bad);
      expect(parsed.lines[0].words.map((word) => word.startMs)).toEqual([1000, 500, 2500]);
    });

    it.each(['duplicate-line', 'duplicate-word', 'line-bounds', 'audio-hash'])('rejects %s', (issue) => {
      const bad = JSON.parse(JSON.stringify(syntheticFixture));
      if (issue === 'duplicate-line') bad.lines[1].id = bad.lines[0].id;
      if (issue === 'duplicate-word') bad.lines[0].words[1].id = bad.lines[0].words[0].id;
      if (issue === 'line-bounds') bad.lines[0].startMs = 0;
      if (issue === 'audio-hash') bad.audioSha256 = 'z'.repeat(64);
      expect(validateAndParseWordLyrics(bad)).toBeNull();
    });

    it('preserves text order with decreasing line startMs', () => {
      const bad = JSON.parse(JSON.stringify(syntheticFixture));
      bad.lines[1].startMs = 500;
      bad.lines[1].words[0].startMs = 500;
      expect(validateAndParseWordLyrics(bad).lines[1].startMs).toBe(500);
    });
  });

  describe('Word State Calculations', () => {
    const word = { id: 'w1', startMs: 1000, endMs: 2000 };

    it('returns future when before startMs', () => {
      expect(getWordState(word, 999)).toBe('future');
    });

    it('returns active at startMs inclusive', () => {
      expect(getWordState(word, 1000)).toBe('active');
    });

    it('returns active inside interval', () => {
      expect(getWordState(word, 1500)).toBe('active');
    });

    it('returns past at endMs (half-open [startMs, endMs))', () => {
      expect(getWordState(word, 2000)).toBe('past');
    });

    it('returns past after endMs', () => {
      expect(getWordState(word, 2001)).toBe('past');
    });

    it('handles gap between words correctly', () => {
      const word1 = { id: 'w1', startMs: 1000, endMs: 1500 };
      const word2 = { id: 'w2', startMs: 1700, endMs: 2200 };
      const gapMs = 1600;

      expect(getWordState(word1, gapMs)).toBe('past');
      expect(getWordState(word2, gapMs)).toBe('future');
      // Neither word is active
    });

    it('handles overlapping words: both are active during overlap', () => {
      const word1 = { id: 'w1', startMs: 1000, endMs: 1800 };
      const word2 = { id: 'w2', startMs: 1500, endMs: 2200 };
      const overlapMs = 1650;

      expect(getWordState(word1, overlapMs)).toBe('active');
      expect(getWordState(word2, overlapMs)).toBe('active');
    });
  });

  describe('Line Selection (computeActiveWordLineIndex)', () => {
    const lines = [
      { id: 'l1', time: 1.0, startMs: 1000, endMs: 2800 },
      { id: 'l2', time: 3.0, startMs: 3000, endMs: 5000 },
      { id: 'l3', time: 5.2, startMs: 5200, endMs: 7200 },
      { id: 'l4', time: 5.2, startMs: 5200, endMs: 8000 }, // same start time tiebreak
    ];

    it('returns -1 before the first line starts', () => {
      expect(computeActiveWordLineIndex(lines, 0.5)).toBe(-1);
    });

    it('returns 0 at first line start', () => {
      expect(computeActiveWordLineIndex(lines, 1.0)).toBe(0);
      expect(computeActiveWordLineIndex(lines, 2.0)).toBe(0);
    });

    it('returns latest started line during inter-line pause', () => {
      expect(computeActiveWordLineIndex(lines, 2.9)).toBe(0);
    });

    it('advances to next line at its start time', () => {
      expect(computeActiveWordLineIndex(lines, 3.0)).toBe(1);
    });

    it('tiebreak: selects later original index when start times are equal', () => {
      expect(computeActiveWordLineIndex(lines, 5.2)).toBe(3);
    });
  });
});
