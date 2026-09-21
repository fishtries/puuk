import { extractPlainLyrics, isLrcSynced, parseLrc } from '../lrcParser';

describe('utils/lrcParser', () => {
  it('detects synced LRC', () => {
    expect(isLrcSynced('[00:10.00]First line')).toBe(true);
    expect(isLrcSynced('just plain text')).toBe(false);
    expect(isLrcSynced('')).toBe(false);
  });

  it('extracts plain lyrics from synced LRC', () => {
    const lrc = '[ti:Song]\n[00:10.00]First line\n[00:25.00]Second line';
    expect(extractPlainLyrics(lrc)).toBe('First line\nSecond line');
  });

  it('parses LRC into timed lines', () => {
    const lrc = '[00:10.50]First line\n[00:25.00]Second line';
    const parsed = parseLrc(lrc);
    expect(parsed.length).toBe(2);
    expect(parsed[0].time).toBeCloseTo(10.5);
    expect(parsed[0].text).toBe('First line');
    expect(parsed[1].time).toBeCloseTo(25);
  });
});
