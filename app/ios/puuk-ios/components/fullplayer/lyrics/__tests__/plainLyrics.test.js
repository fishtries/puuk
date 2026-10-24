import {
  parsePlainLyrics,
  ROW_TYPES,
} from '../plainLyrics';

describe('plainLyrics helper', () => {
  describe('empty input', () => {
    it('returns empty array when input is empty string', () => {
      expect(parsePlainLyrics('')).toEqual([]);
    });

    it('returns empty array when input is null or undefined', () => {
      expect(parsePlainLyrics(null)).toEqual([]);
      expect(parsePlainLyrics(undefined)).toEqual([]);
      expect(parsePlainLyrics()).toEqual([]);
    });

    it('returns empty array when input is not a string', () => {
      expect(parsePlainLyrics(123)).toEqual([]);
      expect(parsePlainLyrics({})).toEqual([]);
      expect(parsePlainLyrics([])).toEqual([]);
    });
  });

  describe('blank lines', () => {
    it('maps empty lines between lyrics into stanza spacers', () => {
      const input = 'Line 1\n\nLine 2';
      expect(parsePlainLyrics(input)).toEqual([
        { type: 'lyric', text: 'Line 1' },
        { type: 'stanza' },
        { type: 'lyric', text: 'Line 2' },
      ]);
    });

    it('handles consecutive newline characters', () => {
      const input = '\n\n';
      expect(parsePlainLyrics(input)).toEqual([
        { type: 'stanza' },
        { type: 'stanza' },
        { type: 'stanza' },
      ]);
    });
  });

  describe('whitespace', () => {
    it('treats whitespace-only lines as stanza spacers', () => {
      const input = 'Line 1\n   \n\t\nLine 2';
      expect(parsePlainLyrics(input)).toEqual([
        { type: 'lyric', text: 'Line 1' },
        { type: 'stanza' },
        { type: 'stanza' },
        { type: 'lyric', text: 'Line 2' },
      ]);
    });

    it('trims leading and trailing whitespace from ordinary lyric lines', () => {
      const input = '   Spaced line 1   \n\tSpaced line 2\t';
      expect(parsePlainLyrics(input)).toEqual([
        { type: 'lyric', text: 'Spaced line 1' },
        { type: 'lyric', text: 'Spaced line 2' },
      ]);
    });

    it('trims leading and trailing whitespace around headers', () => {
      const input = '  [Chorus]  ';
      expect(parsePlainLyrics(input)).toEqual([
        { type: 'header', text: 'Chorus' },
      ]);
    });
  });

  describe('bracket headers', () => {
    it('detects bracket headers and removes outer brackets', () => {
      const input = '[Intro]\n[Verse 1]\n[Chorus: Singer]';
      expect(parsePlainLyrics(input)).toEqual([
        { type: 'header', text: 'Intro' },
        { type: 'header', text: 'Verse 1' },
        { type: 'header', text: 'Chorus: Singer' },
      ]);
    });

    it('does not treat empty brackets [] as headers', () => {
      const input = '[]';
      expect(parsePlainLyrics(input)).toEqual([{ type: 'lyric', text: '[]' }]);
    });

    it('does not treat partial or inline brackets as headers', () => {
      const input = '[Unclosed\nUnopened]\nLyric with [inline] tag';
      expect(parsePlainLyrics(input)).toEqual([
        { type: 'lyric', text: '[Unclosed' },
        { type: 'lyric', text: 'Unopened]' },
        { type: 'lyric', text: 'Lyric with [inline] tag' },
      ]);
    });
  });

  describe('ordinary lines', () => {
    it('preserves text content of normal lyric lines', () => {
      const input = 'First line of the song\nSecond line with punctuation!';
      expect(parsePlainLyrics(input)).toEqual([
        { type: 'lyric', text: 'First line of the song' },
        { type: 'lyric', text: 'Second line with punctuation!' },
      ]);
    });
  });

  describe('full lyric structure', () => {
    it('segments a complete multi-stanza lyrics document correctly', () => {
      const lyrics = [
        '[Verse 1]',
        'I once had a girl',
        'Or should I say, she once had me',
        '',
        '[Bridge]',
        'She showed me her room',
        '  ',
        "Isn't it good, Norwegian wood?",
      ].join('\n');

      expect(parsePlainLyrics(lyrics)).toEqual([
        { type: 'header', text: 'Verse 1' },
        { type: 'lyric', text: 'I once had a girl' },
        { type: 'lyric', text: 'Or should I say, she once had me' },
        { type: 'stanza' },
        { type: 'header', text: 'Bridge' },
        { type: 'lyric', text: 'She showed me her room' },
        { type: 'stanza' },
        { type: 'lyric', text: "Isn't it good, Norwegian wood?" },
      ]);
    });
  });
});
