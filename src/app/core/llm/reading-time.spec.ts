import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PACED_WORDS_PER_SECOND,
  PACED_CHARS_PER_WORD,
  effectivePacedRate,
  formatReadingTime,
  readingSeconds,
  readingTimeLabel,
  readingUnits
} from './reading-time';

describe('reading-time — estimating a paced read at the reveal speed', () => {
  it('counts characters or whitespace-separated words', () => {
    expect(readingUnits('ab cd', 'char')).toBe(5);
    expect(readingUnits('ab cd', 'word')).toBe(2);
    expect(readingUnits('  one\n\ntwo  ', 'word')).toBe(2);
    expect(readingUnits('', 'word')).toBe(0);
  });

  it('divides the units by the configured rate', () => {
    // 10 chars at 5 chars/s → 2 s
    expect(readingSeconds('abcdefghij', 5, 'char')).toBe(2);
    // 5 words at 2 words/s → 2.5 s
    expect(readingSeconds('a b c d e', 2, 'word')).toBe(2.5);
    expect(readingSeconds('', 5, 'char')).toBe(0);
  });

  it('uses the readable default pace when the slider is 0 (instant)', () => {
    expect(effectivePacedRate(0, 'word')).toBe(DEFAULT_PACED_WORDS_PER_SECOND);
    expect(effectivePacedRate(0, 'char')).toBe(
      DEFAULT_PACED_WORDS_PER_SECOND * PACED_CHARS_PER_WORD
    );
    expect(effectivePacedRate(7, 'char')).toBe(7);
    // A zero slider must NOT report "instant" (0 s) for real text.
    expect(readingSeconds('a b c', 0, 'word')).toBeCloseTo(1, 5);
  });

  it('formats a compact clock label (m:ss or h:mm:ss)', () => {
    expect(formatReadingTime(0)).toBe('0:00');
    expect(formatReadingTime(42)).toBe('0:42');
    expect(formatReadingTime(59.6)).toBe('1:00');
    expect(formatReadingTime(12 * 60 + 7)).toBe('12:07');
    expect(formatReadingTime(3600 + 5 * 60 + 12)).toBe('1:05:12');
    expect(formatReadingTime(-4)).toBe('0:00');
    expect(formatReadingTime(Number.NaN)).toBe('0:00');
  });

  it('combines both steps into a label', () => {
    // 20 chars at 10 chars/s → 2 seconds
    expect(readingTimeLabel('abcdefghij klmnopqrs', 10, 'char')).toBe('0:02');
  });
});
