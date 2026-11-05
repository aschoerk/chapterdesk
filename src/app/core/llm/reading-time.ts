/**
 * Reading-time estimates for existing text at the configured REVEAL pace.
 *
 * The reveal pump advances one unit per second of pacing (`streamSpeed`
 * units/s, char or word mode). A paced read therefore takes
 * `units / rate` seconds — this module turns that into "how long will this
 * chapter / book take to read".
 *
 * When the configured speed is 0 ("instant") a paced read still reveals at a
 * comfortable default, so the estimate uses the SAME fallback pace
 * ({@link effectivePacedRate}) instead of reporting "instant".
 */

/** Comfortable reading pace used when the reveal-speed slider is 0. */
export const DEFAULT_PACED_WORDS_PER_SECOND = 3;
/** Same approximation the speed slider uses for char ↔ word conversion. */
export const PACED_CHARS_PER_WORD = 5;

export type ReadingUnit = 'char' | 'word';

/**
 * The pace a paced read actually uses: the configured rate, or the readable
 * default when it is 0 (which would otherwise mean "instant").
 */
export function effectivePacedRate(rate: number, unit: ReadingUnit): number {
  if (Number.isFinite(rate) && rate > 0) return rate;
  return unit === 'word'
    ? DEFAULT_PACED_WORDS_PER_SECOND
    : DEFAULT_PACED_WORDS_PER_SECOND * PACED_CHARS_PER_WORD;
}

/**
 * Number of reveal units in `text` — characters, or whitespace-separated
 * tokens (the pump commits one unit per word).
 */
export function readingUnits(text: string, unit: ReadingUnit): number {
  if (!text) return 0;
  if (unit === 'char') return text.length;
  return text.match(/[^ \t\r\n]+/g)?.length ?? 0;
}

/** Seconds needed to reveal `text` at `rate` units per second. */
export function readingSeconds(text: string, rate: number, unit: ReadingUnit): number {
  const pace = effectivePacedRate(rate, unit);
  if (pace <= 0) return 0;
  return readingUnits(text, unit) / pace;
}

/** Seconds needed to reveal the concatenation of several texts. */
export function readingSecondsOf(texts: readonly string[], rate: number, unit: ReadingUnit): number {
  return readingSeconds(texts.join('\n'), rate, unit);
}

/**
 * Compact clock label: `0:42`, `12:07`, `1:05:12`. Rounds to the nearest
 * second so a sub-second estimate reads `0:00` rather than disappearing.
 */
export function formatReadingTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Convenience: `text` → compact reading-time label. */
export function readingTimeLabel(text: string, rate: number, unit: ReadingUnit): string {
  return formatReadingTime(readingSeconds(text, rate, unit));
}
