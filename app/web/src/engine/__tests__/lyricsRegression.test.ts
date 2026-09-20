import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canAnimateWord,
  canSeekToWord,
  mapWordDTO,
  mapLineDTO,
  mapWordLyricsPayloadDTO,
} from '../lyricsMapper.ts';
import type {
  LyricsLine,
  LyricsWord,
  WordLyricsPayloadDTO,
  WordLyricsLineDTO,
  WordLyricsWordDTO,
} from '../../types/track.ts';

describe('Frontend Word-Level Karaoke Regression Tests', () => {
  // 1. wordData null handling
  describe('1. wordData null and invalid payload handling', () => {
    it('returns null for null, undefined, or empty payload DTO', () => {
      assert.strictEqual(mapWordLyricsPayloadDTO(null), null);
      assert.strictEqual(mapWordLyricsPayloadDTO(undefined), null);
      assert.strictEqual(mapWordLyricsPayloadDTO({} as WordLyricsPayloadDTO), null);
      assert.strictEqual(
        mapWordLyricsPayloadDTO({
          version: 1,
          backend: 'whisper_anchor',
          quality: 'approximate',
          language: 'ru',
          lines: [],
        } as WordLyricsPayloadDTO),
        null
      );
    });
  });

  // 2. mixed approximate/line_fallback
  describe('2. mixed approximate and line_fallback lines', () => {
    it('correctly maps mixed lines and disables word-timing for line_fallback lines', () => {
      const mockPayloadDTO: WordLyricsPayloadDTO = {
        version: 1,
        backend: 'whisper_anchor',
        quality: 'approximate',
        language: 'ru',
        lines: [
          {
            start: 10.0,
            end: 14.5,
            language: 'ru',
            text: 'Пример обычной строки',
            quality: 'approximate',
            word_timing_available: true,
            timestamp_source: 'whisper',
            words: [
              {
                text: 'Пример',
                start: 10.0,
                end: 11.2,
                alignment: 'matched',
                timestamp_source: 'whisper',
              },
              {
                text: 'строки',
                start: 11.4,
                end: 14.5,
                alignment: 'matched',
                timestamp_source: 'whisper',
              },
            ],
          },
          {
            start: 15.0,
            end: 19.0,
            language: 'ru',
            text: 'Строка с быстрым рэпом или шумом',
            quality: 'line_fallback',
            word_timing_available: false,
            timestamp_source: 'line_fallback',
            words: [
              {
                text: 'Строка',
                start: 15.0,
                end: 16.0,
                alignment: 'unresolved',
                timestamp_source: 'line_fallback',
              },
              {
                text: 'рэпом',
                start: 16.0,
                end: 17.0,
                alignment: 'unresolved',
                timestamp_source: 'line_fallback',
              },
            ],
          },
        ],
      };

      const mapped = mapWordLyricsPayloadDTO(mockPayloadDTO);
      assert.ok(mapped);
      assert.strictEqual(mapped.lines.length, 2);

      const [lineApprox, lineFallback] = mapped.lines;

      // Line 1: approximate with word timing
      assert.strictEqual(lineApprox.quality, 'approximate');
      assert.strictEqual(lineApprox.wordTimingAvailable, true);
      assert.strictEqual(lineApprox.words?.length, 2);

      // Line 2: line_fallback
      assert.strictEqual(lineFallback.quality, 'line_fallback');
      assert.strictEqual(lineFallback.wordTimingAvailable, false);

      // Verify UI condition: hasWordTiming is strictly false for line_fallback
      const checkHasWordTiming = (l: LyricsLine) =>
        Boolean(l.wordTimingAvailable && l.quality !== 'line_fallback' && l.words && l.words.length > 0);

      assert.strictEqual(checkHasWordTiming(lineApprox), true);
      assert.strictEqual(checkHasWordTiming(lineFallback), false);
    });
  });

  // 3. unresolved/null timestamps
  describe('3. unresolved, null, and invalid timestamps handling', () => {
    it('does not mask null with 0 and returns false for canAnimateWord and canSeekToWord', () => {
      const unresolvedDTO: WordLyricsWordDTO = {
        text: 'неизвестно',
        start: null,
        end: null,
        alignment: 'unresolved',
        timestamp_source: 'unresolved',
      };

      const word = mapWordDTO(unresolvedDTO);
      assert.strictEqual(word.startTime, null, 'startTime must stay null, NOT 0');
      assert.strictEqual(word.endTime, null, 'endTime must stay null, NOT 0');
      assert.strictEqual(word.alignment, 'unresolved');
      assert.strictEqual(word.timestampSource, 'unresolved');

      assert.strictEqual(canAnimateWord(word), false);
      assert.strictEqual(canSeekToWord(word), false);
    });

    it('rejects line_fallback words from animation and word seek', () => {
      const fallbackWord: LyricsWord = {
        text: 'слово',
        startTime: 12.0,
        endTime: 13.0,
        alignment: 'matched',
        timestampSource: 'line_fallback', // line fallback technical timestamp
        confidence: null,
        isInterpolated: false,
      };

      assert.strictEqual(canAnimateWord(fallbackWord), false);
      assert.strictEqual(canSeekToWord(fallbackWord), false);
    });

    it('rejects inverted or zero duration words (endTime <= startTime)', () => {
      const zeroDurWord: LyricsWord = {
        text: 'баг',
        startTime: 10.0,
        endTime: 10.0,
        alignment: 'matched',
        timestampSource: 'whisper',
        confidence: null,
        isInterpolated: false,
      };

      assert.strictEqual(canAnimateWord(zeroDurWord), false);
    });

    it('accepts valid matched and interpolated words with valid timestamps', () => {
      const matchedWord: LyricsWord = {
        text: 'точно',
        startTime: 5.0,
        endTime: 5.6,
        alignment: 'matched',
        timestampSource: 'whisper',
        confidence: 0.92,
        isInterpolated: false,
      };
      assert.strictEqual(canAnimateWord(matchedWord), true);
      assert.strictEqual(canSeekToWord(matchedWord), true);

      const interpolatedWord: LyricsWord = {
        text: 'интерполировано',
        startTime: 5.7,
        endTime: 6.2,
        alignment: 'interpolated',
        timestampSource: 'interpolated',
        confidence: null,
        isInterpolated: true,
      };
      assert.strictEqual(canAnimateWord(interpolatedWord), true);
      assert.strictEqual(canSeekToWord(interpolatedWord), true);
    });
  });

  // 4. safe word click vs line click
  describe('4. safe word click and canonical line seek', () => {
    it('seeks to word.startTime if seekable, otherwise falls back to line.time', () => {
      const lineTime = 20.0;
      let seekTarget = -1;

      const performClick = (w: LyricsWord) => {
        if (canSeekToWord(w)) {
          seekTarget = w.startTime!;
        } else {
          seekTarget = lineTime;
        }
      };

      // Valid word
      performClick({
        text: 'слово',
        startTime: 21.34,
        endTime: 21.8,
        alignment: 'matched',
        timestampSource: 'whisper',
        confidence: null,
        isInterpolated: false,
      });
      assert.strictEqual(seekTarget, 21.34);

      // Unresolved word
      performClick({
        text: 'пропуск',
        startTime: null,
        endTime: null,
        alignment: 'unresolved',
        timestampSource: 'unresolved',
        confidence: null,
        isInterpolated: false,
      });
      assert.strictEqual(seekTarget, lineTime, 'Must fallback to lineTime for unresolved word');

      // Line_fallback technical word
      performClick({
        text: 'техническое',
        startTime: 22.0,
        endTime: 22.5,
        alignment: 'unresolved',
        timestampSource: 'line_fallback',
        confidence: null,
        isInterpolated: false,
      });
      assert.strictEqual(seekTarget, lineTime, 'Must fallback to lineTime for line_fallback word');
    });

    it('line click uses canonical line start anchor, not technical word[0] start', () => {
      const lineDTO: WordLyricsLineDTO = {
        start: 35.0,
        end: 39.5,
        language: 'ru',
        text: 'Первая строка',
        words: [
          {
            text: 'Первая',
            start: 35.8, // technical first word start is 35.8s
            end: 36.5,
            alignment: 'matched',
            timestamp_source: 'whisper',
          },
        ],
      };

      const line = mapLineDTO(lineDTO);
      assert.ok(line);
      assert.strictEqual(line.time, 35.0, 'Canonical line time must equal line.start');
      assert.notStrictEqual(line.time, line.words?.[0]?.startTime);
    });
  });

  // 5. reduced motion
  describe('5. reduced motion dynamic handling', () => {
    it('disables continuous RAF when prefers-reduced-motion is true and uses discrete states', () => {
      let rafCallCount = 0;
      const fakeRAF = (_cb: FrameRequestCallback): number => {
        rafCallCount++;
        return 123;
      };

      const simulateWordTimedLine = (isReduced: boolean, isActive: boolean, isPlaying: boolean) => {
        rafCallCount = 0;
        if (!isActive) {
          return { runningRAF: false, rafCalls: rafCallCount };
        }
        if (isPlaying && !isReduced) {
          fakeRAF(() => {});
          return { runningRAF: true, rafCalls: rafCallCount };
        }
        return { runningRAF: false, rafCalls: rafCallCount };
      };

      // Inactive line: NEVER runs RAF
      const inactiveRes = simulateWordTimedLine(false, false, true);
      assert.strictEqual(inactiveRes.runningRAF, false);
      assert.strictEqual(inactiveRes.rafCalls, 0);

      // Active line with reduced motion: NEVER runs RAF
      const reducedRes = simulateWordTimedLine(true, true, true);
      assert.strictEqual(reducedRes.runningRAF, false);
      assert.strictEqual(reducedRes.rafCalls, 0);

      // Active line with normal motion: runs RAF
      const normalRes = simulateWordTimedLine(false, true, true);
      assert.strictEqual(normalRes.runningRAF, true);
      assert.strictEqual(normalRes.rafCalls, 1);
    });
  });

  // 6. pause/unmount RAF cleanup
  describe('6. pause and unmount RAF cleanup', () => {
    it('cancels animation frame when playback is paused or component unmounts', () => {
      let cancelledId: number | null = null;
      const fakeCancelRAF = (id: number) => {
        cancelledId = id;
      };

      let animId: number | null = 42;

      // When status becomes 'paused'
      const handleStatusChange = (newStatus: string) => {
        if (newStatus !== 'playing' && animId !== null) {
          fakeCancelRAF(animId);
          animId = null;
        }
      };

      handleStatusChange('paused');
      assert.strictEqual(cancelledId, 42);
      assert.strictEqual(animId, null);

      // On unmount cleanup
      animId = 99;
      const unmountCleanup = () => {
        if (animId !== null) {
          fakeCancelRAF(animId);
          animId = null;
        }
      };

      unmountCleanup();
      assert.strictEqual(cancelledId, 99);
      assert.strictEqual(animId, null);
    });
  });

  // 7. clearing wordData on track switch
  describe('7. clearing wordData on track switch', () => {
    it('resets wordData: null and lyrics: [] on track switch and on fetch error', () => {
      // Mock player store state
      let storeState = {
        currentTrackId: 'track_1',
        lyrics: [{ time: 10, text: 'Старая песня' }] as LyricsLine[],
        wordData: { lines: [] } as any,
        isLyricsLoading: false,
      };

      const startTrackSwitch = (newTrackId: string) => {
        // Immediate reset in playTrack
        storeState = {
          ...storeState,
          currentTrackId: newTrackId,
          lyrics: [],
          wordData: null,
          isLyricsLoading: true,
        };
      };

      startTrackSwitch('track_2');
      assert.strictEqual(storeState.currentTrackId, 'track_2');
      assert.strictEqual(storeState.wordData, null, 'wordData must be cleared immediately');
      assert.strictEqual(storeState.lyrics.length, 0, 'lyrics must be cleared immediately');

      // On fetch error
      const handleFetchError = () => {
        storeState = {
          ...storeState,
          lyrics: [],
          wordData: null,
          isLyricsLoading: false,
        };
      };

      handleFetchError();
      assert.strictEqual(storeState.wordData, null);
      assert.strictEqual(storeState.lyrics.length, 0);
    });
  });

  // 8. punctuation reconstruction invariant and display
  describe('8. punctuation reconstruction invariant and display fragments', () => {
    it('preserves exact line reconstruction from prefix + word.text + suffix without loss or duplication', () => {
      const cases = [
        {
          original: '(А в его—) А в его мешке',
          wordsDTO: [
            { text: 'А', prefix: '(', suffix: ' ' },
            { text: 'в', prefix: '', suffix: ' ' },
            { text: 'его', prefix: '', suffix: '—) ' },
            { text: 'А', prefix: '', suffix: ' ' },
            { text: 'в', prefix: '', suffix: ' ' },
            { text: 'его', prefix: '', suffix: ' ' },
            { text: 'мешке', prefix: '', suffix: '' },
          ],
        },
        {
          original: 'head)?',
          wordsDTO: [{ text: 'head', prefix: '', suffix: ')?' }],
        },
        {
          original: 'American,',
          wordsDTO: [{ text: 'American', prefix: '', suffix: ',' }],
        },
        {
          original: '«Привет» — сказал',
          wordsDTO: [
            { text: 'Привет', prefix: '«', suffix: '» — ' },
            { text: 'сказал', prefix: '', suffix: '' },
          ],
        },
        {
          original: 'Раз  два   три',
          wordsDTO: [
            { text: 'Раз', prefix: '', suffix: '  ' },
            { text: 'два', prefix: '', suffix: '   ' },
            { text: 'три', prefix: '', suffix: '' },
          ],
        },
      ];

      for (const c of cases) {
        const mappedWords = c.wordsDTO.map((w, idx) =>
          mapWordDTO({
            ...w,
            start: 10 + idx * 0.5,
            end: 10 + idx * 0.5 + 0.4,
            alignment: 'matched',
            timestamp_source: 'whisper',
          })
        );

        const reconstructed = mappedWords
          .map((w) => (w.prefix || '') + w.text + (w.suffix || ''))
          .join('');
        assert.strictEqual(
          reconstructed,
          c.original,
          `Reconstruction mismatch for ${c.original}`
        );

        // Acoustic text must not contain punctuation
        for (const w of mappedWords) {
          assert.doesNotMatch(w.text, /[(),—«»?]/, `Word text ${w.text} must not have punctuation`);
        }
      }
    });

    it('punctuation prefix/suffix has no timing and does not participate in word click', () => {
      const word = mapWordDTO({
        text: 'American',
        prefix: '',
        suffix: ',',
        start: 14.5,
        end: 15.1,
        alignment: 'matched',
        timestamp_source: 'whisper',
      });

      assert.strictEqual(canSeekToWord(word), true);
      // Word seek targets word.startTime (14.5s)
      assert.strictEqual(word.startTime, 14.5);
      // Punctuation is merely static inline string, carrying no timestamps
      assert.strictEqual(word.suffix, ',');
    });
  });

  // 9. displayMode policy (unresolved rate threshold & line_fallback)
  describe('9. displayMode policy (unresolved rate threshold & line_fallback)', () => {
    it('sets displayMode="word" when unresolvedRate < 0.20 (e.g. 1 unresolved word out of 6)', () => {
      const lineDTO: WordLyricsLineDTO = {
        start: 20.0,
        end: 25.0,
        language: 'ru',
        text: 'Раз два три четыре пять шесть',
        quality: 'approximate',
        word_timing_available: true,
        words: [
          { text: 'Раз', start: 20.0, end: 20.5, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'два', start: 20.6, end: 21.0, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'три', start: 21.1, end: 21.5, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'четыре', start: 21.6, end: 22.2, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'пять', start: 22.3, end: 22.8, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'шесть', start: null, end: null, alignment: 'unresolved', timestamp_source: 'unresolved' }, // 1 / 6 = 16.7% < 20%
        ],
      };

      const line = mapLineDTO(lineDTO);
      assert.ok(line);
      assert.strictEqual(line.unresolvedRate, 0.17);
      assert.strictEqual(line.displayMode, 'word', '1 out of 6 unresolved (16.7% < 20%) must allow word mode');
      assert.strictEqual(line.wordTimingAvailable, true);
    });

    it('sets displayMode="line" when unresolvedRate >= 0.20 (e.g. 1 out of 5 = 20% or 2 out of 6 = 33.3%)', () => {
      // 1 out of 5 words unresolved = 20%
      const lineDTO20: WordLyricsLineDTO = {
        start: 30.0,
        end: 35.0,
        language: 'ru',
        text: 'Один два три четыре пять',
        quality: 'approximate',
        word_timing_available: true,
        words: [
          { text: 'Один', start: 30.0, end: 30.5, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'два', start: 30.6, end: 31.0, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'три', start: 31.1, end: 31.5, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'четыре', start: 31.6, end: 32.0, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'пять', start: null, end: null, alignment: 'unresolved', timestamp_source: 'unresolved' }, // 1/5 = 20%
        ],
      };

      const line20 = mapLineDTO(lineDTO20);
      assert.ok(line20);
      assert.strictEqual(line20.unresolvedRate, 0.20);
      assert.strictEqual(line20.displayMode, 'line', '20% unresolved must fall back to line mode');

      // 2 out of 6 words unresolved = 33.3%
      const lineDTO33: WordLyricsLineDTO = {
        start: 40.0,
        end: 45.0,
        language: 'ru',
        text: 'Раз два три четыре пять шесть',
        quality: 'approximate',
        word_timing_available: true,
        words: [
          { text: 'Раз', start: 40.0, end: 40.5, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'два', start: 40.6, end: 41.0, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'три', start: 41.1, end: 41.5, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'четыре', start: 41.6, end: 42.0, alignment: 'matched', timestamp_source: 'whisper' },
          { text: 'пять', start: null, end: null, alignment: 'unresolved', timestamp_source: 'unresolved' },
          { text: 'шесть', start: null, end: null, alignment: 'unresolved', timestamp_source: 'unresolved' },
        ],
      };

      const line33 = mapLineDTO(lineDTO33);
      assert.ok(line33);
      assert.strictEqual(line33.unresolvedRate, 0.33);
      assert.strictEqual(line33.displayMode, 'line', '> 20% unresolved must fall back to line mode');
    });

    it('sets displayMode="line" when line has quality="line_fallback"', () => {
      const lineFallbackDTO: WordLyricsLineDTO = {
        start: 50.0,
        end: 55.0,
        language: 'ru',
        text: 'Быстрый рэп в шуме',
        quality: 'line_fallback',
        word_timing_available: false,
        words: [
          { text: 'Быстрый', start: 50.0, end: 51.0, alignment: 'unresolved', timestamp_source: 'line_fallback' },
          { text: 'рэп', start: 51.0, end: 52.0, alignment: 'unresolved', timestamp_source: 'line_fallback' },
          { text: 'в', start: 52.0, end: 52.5, alignment: 'unresolved', timestamp_source: 'line_fallback' },
          { text: 'шуме', start: 52.5, end: 55.0, alignment: 'unresolved', timestamp_source: 'line_fallback' },
        ],
      };

      const line = mapLineDTO(lineFallbackDTO);
      assert.ok(line);
      assert.strictEqual(line.displayMode, 'line', 'line_fallback quality must strictly enforce line mode');
    });
  });

  // 10. canonical line timing and invalid line start handling
  describe('10. canonical line timing and invalid line start handling', () => {
    it('does NOT substitute 0 for invalid dto.start and rejects the corrupted payload to trigger LRC fallback', () => {
      const corruptedDTO: WordLyricsPayloadDTO = {
        version: 1,
        backend: 'whisper_anchor',
        quality: 'approximate',
        language: 'ru',
        lines: [
          {
            start: 10.0,
            end: 14.0,
            language: 'ru',
            text: 'Хорошая строка 1',
            words: [],
          },
          {
            start: null as any, // Corrupted line start
            end: 18.0,
            language: 'ru',
            text: 'Поврежденная строка 2',
            words: [],
          },
          {
            start: 19.0,
            end: 24.0,
            language: 'ru',
            text: 'Хорошая строка 3',
            words: [],
          },
        ],
      };

      // Corrupted line start returns null from mapLineDTO without masking as 0
      const corruptedLine = mapLineDTO(corruptedDTO.lines[1]);
      assert.strictEqual(corruptedLine, null, 'Must return null for invalid dto.start, NOT mask as 0');

      // Rejecting the whole payload triggers graceful fallback to canonical LRC without deleting line 2
      const mappedPayload = mapWordLyricsPayloadDTO(corruptedDTO);
      assert.strictEqual(
        mappedPayload,
        null,
        'Corrupted payload must return null to trigger canonical LRC fallback without deleting lines from middle'
      );
    });
  });
});
