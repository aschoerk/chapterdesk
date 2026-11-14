import { describe, it, expect } from 'vitest';
import {
  CHAPTER_PLAN_FORMAT_CONTRACT,
  CHAPTER_PLAN_RECORD,
  chapterPlanFromText,
  chapterPlanLabel,
  chapterPlanOf,
  chapterPlanRecord,
  chapterPlanSlice,
  isChapterPlanRecordAttachment,
  looksLikeChapterPlan,
  normalizeChapterPlan,
  parseChapterPlan,
  parseStrictChapterPlan,
  readChapterPlan,
  startsWithChapterPlanItem,
  type ChapterPlan,
} from './chapter-plan';

/** The exact shape the FORMAT CONTRACT asks for (3 chapters from 7). */
const CONTRACT_TEXT = `7. The Gate — Mara finds the key under the loose stone and learns that her father kept a second ledger. She hides it before the steward returns.
8. The Road — They leave before dawn and lose the track in the rain. By noon the bridge is gone.
9. The Ledger — The second ledger names a creditor Mara has never heard of. She decides to find him alone.`;

describe('chapter-plan — strict parser (the format contract)', () => {
  const anchors = { firstChapter: 7, chapterCount: 3 };

  it('parses the contract shape into absolute chapters', () => {
    const plan = parseStrictChapterPlan(CONTRACT_TEXT, anchors)!;
    expect(plan).not.toBeNull();
    expect(plan.source).toBe('numbered');
    expect(plan.entries.map((e) => e.chapter)).toEqual([7, 8, 9]);
    // The whole entry is kept (heading AND description) — it is never split.
    expect(plan.entries[0].text).toContain('The Gate — Mara finds the key');
    expect(plan.entries[0].text).not.toMatch(/^\d+\./); // number stripped
  });

  it('tolerates a wrapping code fence (the one cosmetic slip)', () => {
    const fenced = '```text\n' + CONTRACT_TEXT + '\n```';
    expect(parseStrictChapterPlan(fenced, anchors)).not.toBeNull();
  });

  it('rejects a wrong paragraph count', () => {
    expect(parseStrictChapterPlan(CONTRACT_TEXT, { firstChapter: 7, chapterCount: 4 })).toBeNull();
  });

  it('rejects numbering that does not start at firstChapter', () => {
    const restarted = CONTRACT_TEXT.replace(/^7\./, '1.').replace(/^8\./, '2.').replace(/^9\./, '3.');
    expect(parseStrictChapterPlan(restarted, anchors)).toBeNull();
  });

  it('rejects markdown headings / bullets instead of "N. " starts', () => {
    expect(parseStrictChapterPlan('### 7. The Gate — x\n\n### 8. The Road — y\n\n### 9. The Ledger — z', anchors)).toBeNull();
    expect(parseStrictChapterPlan('- 7. The Gate — x\n\n- 8. The Road — y\n\n- 9. The Ledger — z', anchors)).toBeNull();
  });

  it('returns null without the anchors (cannot validate)', () => {
    expect(parseStrictChapterPlan(CONTRACT_TEXT, {})).toBeNull();
  });
});

describe('chapter-plan — tolerant parser', () => {
  it('accepts "3)" and bold variants', () => {
    const plan = parseChapterPlan('7) The Gate — x\n\n8) The Road — y');
    expect(plan.entries.map((e) => e.chapter)).toEqual([7, 8]);
    expect(plan.entries[0].text).toBe('The Gate — x');
  });

  it('accepts markdown headings and "Chapter N" labels', () => {
    const md = parseChapterPlan('### Chapter 7 — The Gate\n\n### Chapter 8 — The Road');
    expect(md.entries.map((e) => e.chapter)).toEqual([7, 8]);
    expect(md.entries[0].text).toContain('The Gate');
  });

  it('keeps a multi-line description together', () => {
    const plan = parseChapterPlan(
      '7. The Gate — first line.\nsecond line of the same chapter.\n\n8. The Road — next chapter.',
    );
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0].text).toBe('The Gate — first line. second line of the same chapter.');
  });

  it('treats a non-advancing number as continuation (sub-lists)', () => {
    const plan = parseChapterPlan(
      '7. The Gate — Mara listens.\n1. the steward lies\n2. the key is cold\n8. The Road — They leave.',
    );
    expect(plan.entries.map((e) => e.chapter)).toEqual([7, 8]);
    expect(plan.entries[0].text).toContain('the steward lies');
  });

  it('ignores a preamble and separator lines', () => {
    const plan = parseChapterPlan('Here is the plan:\n---\n7. A — x\n\n---\n8. B — y');
    expect(plan.entries.map((e) => e.chapter)).toEqual([7, 8]);
  });

  it('shifts a list that restarted at 1 although firstChapter was 7', () => {
    const plan = parseChapterPlan('1. A — x\n\n2. B — y', { firstChapter: 7 });
    expect(plan.entries.map((e) => e.chapter)).toEqual([7, 8]);
    expect(plan.renumbered).toBe(true);
  });

  it('does not flag a plan that already matches firstChapter', () => {
    const plan = parseChapterPlan('7. A — x\n\n8. B — y', { firstChapter: 7 });
    expect(plan.renumbered).toBeUndefined();
  });

  it('trims a trailing numbered appendix to chapterCount', () => {
    const plan = parseChapterPlan(
      '7. A — x\n\n8. B — y\n\n9. C — z\n\nNotes\n10. appendix line one\n11. appendix line two',
      { firstChapter: 7, chapterCount: 3 },
    );
    expect(plan.entries.map((e) => e.chapter)).toEqual([7, 8, 9]);
  });

  it('falls back to blank-line blocks ONLY when the count validates', () => {
    const blocks = 'The Gate — x\n\n\nThe Road — y';
    expect(parseChapterPlan(blocks, { firstChapter: 7, chapterCount: 2 }).entries).toHaveLength(2);
    expect(parseChapterPlan(blocks, { firstChapter: 7, chapterCount: 3 }).entries).toHaveLength(0);
    expect(parseChapterPlan(blocks, {}).entries).toHaveLength(0); // no anchor → refuse
    // …same for a single block: without a count there is nothing to validate.
    expect(parseChapterPlan('Only one block.', {}).entries).toHaveLength(0);
  });

  it('returns an empty plan instead of guessing', () => {
    expect(parseChapterPlan('').entries).toEqual([]);
    // Un-numbered text without an expected count cannot be validated.
    expect(parseChapterPlan('no numbers here at all').entries).toEqual([]);
    expect(parseChapterPlan('Only one block.').entries).toEqual([]);
  });

  it('supports roman numerals', () => {
    const plan = parseChapterPlan('I. A — x\n\nII. B — y');
    expect(plan.entries.map((e) => e.chapter)).toEqual([1, 2]);
  });
});

describe('chapter-plan — slice', () => {
  const plan: ChapterPlan = {
    version: 1,
    firstChapter: 7,
    chapterCount: 3,
    source: 'numbered',
    entries: [
      { chapter: 7, label: '7', text: 'The Gate — x' },
      { chapter: 8, label: '8', text: 'The Road — y' },
      { chapter: 9, label: '9', text: 'The Ledger — z' },
    ],
  };

  it('returns exactly the requested number of chapters, re-numbered absolutely', () => {
    // The count is the TOTAL per send (1 = the elaborated chapter alone).
    expect(chapterPlanSlice(plan, 7, 1)).toBe('7. The Gate — x');
    expect(chapterPlanSlice(plan, 7, 2)).toBe('7. The Gate — x\n8. The Road — y');
    expect(chapterPlanSlice(plan, 7, 3)).toBe(
      '7. The Gate — x\n8. The Road — y\n9. The Ledger — z',
    );
    // Counts below 1 are clamped to 1 (never an empty slice).
    expect(chapterPlanSlice(plan, 8, 0)).toBe('8. The Road — y');
    // Never runs past the end of the plan.
    expect(chapterPlanSlice(plan, 7, 5)).toBe(
      '7. The Gate — x\n8. The Road — y\n9. The Ledger — z',
    );
  });

  it('returns "" for a chapter the plan does not cover (never borrows a neighbour)', () => {
    expect(chapterPlanSlice(plan, 6, 2)).toBe('');
    expect(chapterPlanSlice(plan, 12, 2)).toBe('');
    expect(chapterPlanSlice(null, 7, 2)).toBe('');
  });

  it('labels the plan range', () => {
    expect(chapterPlanLabel(plan)).toBe('7–9, 3');
    expect(chapterPlanLabel(null)).toBe('');
  });
});

describe('chapter-plan — record attachment', () => {
  it('round-trips through the record', () => {
    const plan = parseStrictChapterPlan(CONTRACT_TEXT, { firstChapter: 7, chapterCount: 3 })!;
    const rec = chapterPlanRecord(plan);
    expect(rec.name).toBe(CHAPTER_PLAN_RECORD);
    expect(isChapterPlanRecordAttachment(rec)).toBe(true);
    expect(isChapterPlanRecordAttachment({ name: 'notes.txt' })).toBe(false);

    const back = readChapterPlan({ attachments: [rec] });
    expect(back?.entries.map((e) => e.chapter)).toEqual([7, 8, 9]);
    expect(back?.entries[0].text).toBe(plan.entries[0].text);
  });

  it('ignores a broken record', () => {
    expect(readChapterPlan({
      attachments: [{ id: 'a', name: CHAPTER_PLAN_RECORD, mimeType: 'text/plain', size: 3, dataUrl: 'data:text/plain,{oops' }],
    })).toBeNull();
    expect(readChapterPlan({ attachments: [] })).toBeNull();
    expect(readChapterPlan(null)).toBeNull();
  });

  it('normalizes untrusted JSON', () => {
    expect(normalizeChapterPlan({ entries: [] })).toBeNull();
    expect(normalizeChapterPlan('nope')).toBeNull();
    const plan = normalizeChapterPlan({
      entries: [{ chapter: '8', text: 'Road' }, { chapter: 9, text: '  ' }],
      source: 'weird',
    })!;
    expect(plan.entries).toEqual([{ chapter: 8, label: '8', text: 'Road' }]);
    expect(plan.source).toBe('numbered');
  });
});

describe('chapter-plan — node helpers', () => {
  it('prefers the stored record over parsing the visible text', () => {
    const stored: ChapterPlan = {
      version: 1,
      firstChapter: 1,
      chapterCount: 1,
      source: 'numbered',
      entries: [{ chapter: 1, label: '1', text: 'From the record' }],
    };
    const plan = chapterPlanOf({
      content: '1. From the text — x\n\n2. Second — y',
      attachments: [chapterPlanRecord(stored)],
    });
    expect(plan?.entries).toHaveLength(1);
    expect(plan?.entries[0].text).toBe('From the record');
  });

  it('falls back to a parsed hand-written list (with descriptions)', () => {
    const plan = chapterPlanOf({
      content: '7. The Gate — Mara finds the key under the loose stone.\n\n9. The Road — They leave before dawn.',
      attachments: [],
    });
    expect(plan?.entries.map((e) => e.chapter)).toEqual([7, 9]);
  });

  it('returns null for prose without a list', () => {
    expect(chapterPlanOf({ content: 'Just a chapter of prose.', attachments: [] })).toBeNull();
  });

  it('refuses a bare heading list (no descriptions to use as lore)', () => {
    // "Chapter 1: …" placeholders are NOT an outline an elaboration can use.
    expect(chapterPlanFromText('Chapter 1: …\nChapter 2: …\nChapter 3: …')).toBeNull();
    // A single entry is not an outline either.
    expect(chapterPlanFromText('1. The Gate — Mara finds the key under the stone.')).toBeNull();
  });

  it('cheap pre-check matches numbered lines and "Chapter N"', () => {
    expect(looksLikeChapterPlan('7. A')).toBe(true);
    expect(looksLikeChapterPlan('**3.** A')).toBe(true);
    expect(looksLikeChapterPlan('Chapter 4')).toBe(true);
    expect(looksLikeChapterPlan('Nothing here')).toBe(false);
    expect(looksLikeChapterPlan('')).toBe(false);
  });

  it('startsWithChapterPlanItem only matches when the list IS the node', () => {
    // A generated list starts with its first item.
    expect(startsWithChapterPlanItem('20. The Double Frame — x')).toBe(true);
    expect(startsWithChapterPlanItem('\n\n  7. A — x')).toBe(true);
    expect(startsWithChapterPlanItem('### Chapter 7 — The Gate')).toBe(true);
    // A PROSE chapter that merely contains an enumeration does not qualify.
    expect(startsWithChapterPlanItem('Marcus leaned back.\n\n1. first\n2. second')).toBe(false);
    expect(startsWithChapterPlanItem('Just prose.')).toBe(false);
    expect(startsWithChapterPlanItem('')).toBe(false);
  });

  it('a list whose answer lost its record still parses (no anchors needed)', () => {
    // The real "chapters 20–29" case: generated by the flow, but the answer was
    // regenerated before the record was re-derived, so the node has no record.
    const text = Array.from(
      { length: 10 },
      (_, i) => `${20 + i}. Chapter ${20 + i} — something happens in this one.`,
    ).join('\n\n');
    const node = { content: text, attachments: [] };
    expect(readChapterPlan(node)).toBeNull(); // no record…
    expect(startsWithChapterPlanItem(node.content)).toBe(true);
    const plan = chapterPlanOf(node)!; // …yet the plan is recoverable
    expect(plan.entries.map((e) => e.chapter)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(chapterPlanSlice(plan, 22, 2)).toBe(
      '22. Chapter 22 — something happens in this one.\n23. Chapter 23 — something happens in this one.',
    );
  });
});

describe('chapter-plan — format contract', () => {
  it('states the rules the strict parser validates', () => {
    expect(CHAPTER_PLAN_FORMAT_CONTRACT).toContain('One chapter per paragraph');
    expect(CHAPTER_PLAN_FORMAT_CONTRACT).toContain('begins at column 1 with the chapter number');
    expect(CHAPTER_PLAN_FORMAT_CONTRACT).toContain('Never restart at 1');
    expect(CHAPTER_PLAN_FORMAT_CONTRACT).toContain('Output ONLY the chapter list');
  });

  it('its own example satisfies the strict parser', () => {
    const example = CHAPTER_PLAN_FORMAT_CONTRACT.split('content is yours):')[1].trim();
    const plan = parseStrictChapterPlan(example, { firstChapter: 7, chapterCount: 3 });
    expect(plan?.entries.map((e) => e.chapter)).toEqual([7, 8, 9]);
  });
});
