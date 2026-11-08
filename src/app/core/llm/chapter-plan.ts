import type { ChatNode, NodeAttachment } from '../../models/chat';

/**
 * CHAPTER PLAN — the numbered "heading + description" list produced by the
 * `send-chapter-descriptions` flow, parsed into data so a chapter's matching
 * entry plus the next N can be injected into the lore of an elaboration.
 *
 * Two layers keep this reliable:
 *
 *  1. **Format contract** (`CHAPTER_PLAN_FORMAT_CONTRACT`) — appended by the
 *     FLOW (not by the user-editable prompt) to the description request, so
 *     the model emits one paragraph per chapter, each starting at column 1
 *     with "N. " and a " — " between heading and description. That is plain,
 *     readable prose for the user and trivially parseable.
 *  2. **Strict parser first, tolerant parser second** — the strict pass
 *     validates the contract (exactly `chapterCount` paragraphs, consecutive
 *     numbers from `firstChapter`) and returns null on any deviation; the
 *     tolerant pass only runs for old / hand-edited lists.
 *
 * The parsed plan is additionally stored ON THE NODE as a `chapter-plan.json`
 * record attachment (same mechanism as `image-description.txt`, excluded from
 * the LLM context), so later steps never have to re-parse prose.
 */

/** Name of the record attachment holding the parsed plan. */
export const CHAPTER_PLAN_RECORD = 'chapter-plan.json';

const CHAPTER_PLAN_RECORD_RE = /^chapter-plan\.json$/i;

/** True when an attachment is the stored chapter-plan record. */
export function isChapterPlanRecordAttachment(
  a: Pick<NodeAttachment, 'name'> | null | undefined,
): boolean {
  return CHAPTER_PLAN_RECORD_RE.test(a?.name ?? '');
}

/** One planned chapter. */
export interface ChapterPlanEntry {
  /** Absolute chapter number (aligned with the dialog's `firstChapter`). */
  chapter: number;
  /** The number as written in the plan ("3", "III", "ARC-3"), for display. */
  label: string;
  /**
   * Heading + description as one normalized paragraph. The heading is NOT
   * split off: the lore only needs the whole entry, and splitting on the
   * dash/colon is the most fragile rule there is.
   */
  text: string;
}

/** How the entries were obtained. */
export type ChapterPlanSource = 'numbered' | 'blocks' | 'single';

/** A parsed chapter plan (possibly empty). */
export interface ChapterPlan {
  version: 1;
  /** The dialog's `firstChapter` parameter, when known. */
  firstChapter: number | null;
  /** The dialog's `chapterCount` parameter, when known. */
  chapterCount: number | null;
  entries: ChapterPlanEntry[];
  source: ChapterPlanSource;
  /**
   * True when the plan numbered its chapters from 1 although the dialog asked
   * for another first number — the numbers were shifted by an offset.
   */
  renumbered?: boolean;
}

/** Anchors the caller knows about a plan (from the dialog parameters). */
export interface ChapterPlanAnchors {
  firstChapter?: number | null;
  chapterCount?: number | null;
}

/**
 * The FORMAT half of the chapter-description request, appended by the flow.
 * Kept out of the user-editable `structure.chapterDescriptions` prompt so the
 * parser's contract cannot drift from the text that produces it. Everything
 * here still yields plain, readable prose.
 */
export const CHAPTER_PLAN_FORMAT_CONTRACT = `FORMAT — follow it exactly:
- Output ONLY the chapter list. No introduction sentence, no closing remark, no notes, no code fence.
- One chapter per paragraph; separate paragraphs with exactly one blank line.
- Every paragraph begins at column 1 with the chapter number in digits, a period and one space: "7. "
- Then the heading (short, no trailing period), then " — " (space, em dash, space), then the description.
- The description stays in that same paragraph. Never start a new line or a new paragraph inside a chapter.
- Plain text only: no markdown (#, **, *, _), no bullets, no sub-lists, no quotes, no tables.
- Number the chapters consecutively, starting at the given first chapter number. Never restart at 1.
- Emit exactly the requested number of chapters and nothing else.

Shape example for 3 chapters starting at chapter 7 (content is yours):
7. The Gate — Mara finds the key under the loose stone and learns that her father kept a second ledger. She hides it before the steward returns.
8. The Road — They leave before dawn and lose the track in the rain. By noon the bridge is gone.
9. The Ledger — The second ledger names a creditor Mara has never heard of. She decides to find him alone.`;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Strict contract item: `N. text` starting at column 1. */
const STRICT_ITEM = /^(\d{1,4})\. (.+)$/;

/**
 * Tolerant item start: optional quote/bullet/markdown-heading/bold noise, a
 * number (digits or UPPER-CASE roman), then punctuation or whitespace.
 * Handles `3.`, `3)`, `**3.**`, `### 3`, `- 3 -`, `IV.`. Lower-case roman is
 * NOT accepted ("i." would collide with ordinary words).
 */
const TOLERANT_ITEM =
  /^[ \t>]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(\d{1,4}|[IVXLCDM]{1,7})[ \t]*(?:[.)\]:·][ \t]*|[ \t]+-?[ \t]*)/;

/** Paragraph break (one or more blank lines). */
const PARAGRAPH_BREAK = /\n[ \t]*\n+/;

/** `Chapter 3 …` / `### Chapter III …` variant. */
const TOLERANT_CHAPTER =
  /^[ \t>]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*chapter[ \t]+(\d{1,4}|[ivxlcdm]{1,7})\b[ \t]*[:.)–—-]?[ \t]*/i;

/** A horizontal rule / separator line — never part of an entry. */
const SEPARATOR_ONLY = /^[ \t]*([-*_=]{3,}|[—–-]{1,3})[ \t]*$/;

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** `"3"` → 3, `"III"` → 3, anything else → null. */
function toNumber(label: string): number | null {
  if (/^\d+$/.test(label)) return Number(label);
  const lower = label.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(lower)) return null;
  let total = 0;
  let prev = 0;
  for (let i = lower.length - 1; i >= 0; i--) {
    const v = ROMAN[lower[i]] ?? 0;
    total += v < prev ? -v : v;
    prev = Math.max(prev, v);
  }
  return total > 0 ? total : null;
}

/** Collapse a multi-line entry into one line with single spaces. */
function collapse(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip a wrapping ```-fence a chatty model may add (cosmetic only). */
function unfence(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*[ \t]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

function emptyPlan(anchors: ChapterPlanAnchors): ChapterPlan {
  return {
    version: 1,
    firstChapter: anchors.firstChapter ?? null,
    chapterCount: anchors.chapterCount ?? null,
    entries: [],
    source: 'numbered',
  };
}

/**
 * STRICT parse of the format contract. Returns null when anything deviates:
 * a wrong item count, an item that does not start with `N. `, or
 * non-consecutive numbering. The ONE tolerated cosmetic slip is a wrapping
 * code fence (and a wrapped description line, see below).
 */
export function parseStrictChapterPlan(
  raw: string,
  anchors: ChapterPlanAnchors,
): ChapterPlan | null {
  const firstChapter = anchors.firstChapter ?? null;
  const chapterCount = anchors.chapterCount ?? null;
  if (firstChapter === null || chapterCount === null) return null;
  if (chapterCount <= 0) return null;

  const text = unfence((raw ?? '').replace(/\r\n?/g, '\n'));
  if (!text) return null;

  // Line based: an item starts at `N. ` on a line of its own; a wrapped
  // description line (the model kept the paragraph narrower) is appended to
  // the current item. Blank lines are paragraph separators.
  const items: { label: string; lines: string[] }[] = [];
  let cur: { label: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const m = STRICT_ITEM.exec(line);
    if (m) {
      cur = { label: m[1], lines: [m[2].trim()] };
      items.push(cur);
      continue;
    }
    if (!line.trim()) continue;
    if (!cur) return null; // text before the first item — not the contract
    cur.lines.push(line.trim());
  }

  if (items.length !== chapterCount) return null;
  const entries: ChapterPlanEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const chapter = firstChapter + i;
    if (Number(item.label) !== chapter) return null;
    const body = collapse(item.lines);
    if (!body) return null;
    entries.push({ chapter, label: item.label, text: body });
  }
  return { version: 1, firstChapter, chapterCount, entries, source: 'numbered' };
}

/**
 * TOLERANT parse — for lists that are not in the exact contract (older
 * generations, hand-written outlines, model drift).
 *
 * Rules that make it dependable:
 *  - an entry starts at a NUMBER (optionally behind bullets/markdown noise);
 *  - everything up to the next start belongs to the current entry, so
 *    multi-line descriptions survive;
 *  - a start whose number does NOT advance (`a)` sub-lists, stray `1.`) is
 *    treated as continuation text;
 *  - the numbers are reconciled with the anchors: a list that restarted at 1
 *    while `firstChapter` was 7 is shifted, and the shift is flagged
 *    (`renumbered`);
 *  - a trailing numbered appendix is trimmed to `chapterCount`;
 *  - entry ORDER (story order) is authoritative, never numeric order;
 *  - returns an EMPTY plan instead of guessing when nothing validates.
 */
export function parseChapterPlan(raw: string, anchors: ChapterPlanAnchors = {}): ChapterPlan {
  const text = unfence((raw ?? '').replace(/\r\n?/g, '\n'));
  if (!text) return emptyPlan(anchors);

  const lines = text.split('\n');
  const items: { label: string; n: number | null; lines: string[] }[] = [];
  let cur: (typeof items)[number] | null = null;
  let prevNumber = 0;
  let sawNumberedStart = false;

  for (const line of lines) {
    if (SEPARATOR_ONLY.test(line)) continue;

    const m = TOLERANT_ITEM.exec(line) ?? TOLERANT_CHAPTER.exec(line);
    if (m) {
      const label = m[1];
      const n = toNumber(label);
      // A start must ADVANCE the numbering; otherwise it is a sub-list or a
      // repeated number inside the current description.
      const advances = n === null
        ? prevNumber === 0
        : prevNumber === 0 || n > prevNumber;
      if (!cur || advances) {
        cur = { label, n, lines: [line.slice(m[0].length)] };
        items.push(cur);
        sawNumberedStart = true;
        if (n !== null) prevNumber = n;
        continue;
      }
    }
    if (!cur) continue; // preamble before the first item
    if (!line.trim()) {
      cur.lines.push('');
      continue;
    }
    cur.lines.push(line);
  }

  if (!sawNumberedStart) return parseBlocks(text, anchors);

  const parsed = items
    .map((it) => ({ label: it.label, n: it.n, text: collapse(it.lines) }))
    .filter((it) => it.text.length > 0);
  if (parsed.length === 0) return emptyPlan(anchors);

  // Reconcile with the anchors: shift a list that restarted at 1.
  const firstKnown = anchors.firstChapter ?? null;
  const firstParsed = parsed.find((e) => e.n !== null)?.n ?? 1;
  const offset = firstKnown !== null && firstParsed !== firstKnown
    ? firstKnown - firstParsed
    : 0;

  let expected = firstKnown ?? parsed[0].n ?? 1;
  const numbered: ChapterPlanEntry[] = parsed.map((e) => {
    const chapter = e.n !== null ? e.n + offset : expected;
    expected = chapter + 1;
    return { chapter, label: e.label, text: e.text };
  });

  // Trim a trailing numbered appendix when the expected count is known.
  const wanted = anchors.chapterCount ?? null;
  const entries = wanted && wanted > 0 && numbered.length > wanted
    ? numbered.slice(0, wanted)
    : numbered;
  // A plan with an implausible number of entries is a parse accident.
  if (entries.length === 0 || entries.length > 500) return emptyPlan(anchors);

  return {
    version: 1,
    firstChapter: firstKnown,
    chapterCount: wanted,
    entries,
    source: 'numbered',
    ...(offset !== 0 ? { renumbered: true } : {}),
  };
}

/**
 * Last resort: no numbered items at all. Blank-line separated blocks are
 * accepted ONLY when they can be validated against the expected count (or when
 * there is exactly one block and no expectation).
 */
function parseBlocks(text: string, anchors: ChapterPlanAnchors): ChapterPlan {
  const blocks = text
    .split(PARAGRAPH_BREAK)
    .map((b) => collapse([b]))
    .filter(Boolean);
  const wanted = anchors.chapterCount ?? null;
  // Without an expected count there is nothing to validate the blocks against
  // — refuse rather than guess (a wrong split would poison the lore).
  if (wanted === null || wanted <= 0) return emptyPlan(anchors);
  if (blocks.length === 0 || blocks.length !== wanted) return emptyPlan(anchors);

  const first = anchors.firstChapter ?? 1;
  return {
    version: 1,
    firstChapter: anchors.firstChapter ?? null,
    chapterCount: wanted,
    entries: blocks.map((t, i) => ({
      chapter: first + i,
      label: String(first + i),
      text: t,
    })),
    source: blocks.length === 1 ? 'single' : 'blocks',
  };
}

/** Cheap pre-check before parsing a node's (possibly huge) content. */
export function looksLikeChapterPlan(content: string | null | undefined): boolean {
  const text = (content ?? '').trim();
  if (!text) return false;
  return /^[ \t]*(?:[-*+][ \t]+)?(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(?:\d{1,4}[.):]|chapter\s+\w)/im.test(text);
}

// ---------------------------------------------------------------------------
// Record attachment (machine-readable copy, excluded from the LLM context)
// ---------------------------------------------------------------------------

/** Build the `chapter-plan.json` record attachment for a parsed plan. */
export function chapterPlanRecord(plan: ChapterPlan): NodeAttachment {
  const payload = JSON.stringify(plan);
  return {
    id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: CHAPTER_PLAN_RECORD,
    mimeType: 'text/plain',
    size: payload.length,
    dataUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(payload)}`,
  };
}

/** Decode a `data:` URL to text (percent-encoded or base64). */
function decodeDataUrl(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  try {
    if (/;base64/i.test(header)) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/** Normalize an untrusted parsed record into a `ChapterPlan` (or null). */
export function normalizeChapterPlan(value: unknown): ChapterPlan | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ChapterPlan>;
  if (!Array.isArray(raw.entries)) return null;
  const entries: ChapterPlanEntry[] = [];
  for (const e of raw.entries) {
    if (!e || typeof e !== 'object') continue;
    const chapter = Number((e as ChapterPlanEntry).chapter);
    const text = String((e as ChapterPlanEntry).text ?? '').trim();
    if (!Number.isFinite(chapter) || !text) continue;
    entries.push({
      chapter: Math.round(chapter),
      label: String((e as ChapterPlanEntry).label ?? chapter),
      text,
    });
  }
  if (entries.length === 0) return null;
  const source = raw.source === 'blocks' || raw.source === 'single' ? raw.source : 'numbered';
  return {
    version: 1,
    firstChapter: Number.isFinite(Number(raw.firstChapter)) ? Number(raw.firstChapter) : null,
    chapterCount: Number.isFinite(Number(raw.chapterCount)) ? Number(raw.chapterCount) : null,
    entries,
    source,
    ...(raw.renumbered === true ? { renumbered: true } : {}),
  };
}

/** The plan stored on a node (record attachment), or null. */
export function readChapterPlan(
  node: Pick<ChatNode, 'attachments'> | null | undefined,
): ChapterPlan | null {
  const rec = (node?.attachments ?? []).find(isChapterPlanRecordAttachment);
  if (!rec) return null;
  const text = decodeDataUrl(rec.dataUrl);
  if (!text) return null;
  try {
    return normalizeChapterPlan(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Resolve the plan of a node: the stored record when present, else a parse of
 * its visible text (validated against nothing — used for hand-picked nodes).
 */
export function chapterPlanOf(
  node: Pick<ChatNode, 'content' | 'attachments'> | null | undefined,
): ChapterPlan | null {
  if (!node) return null;
  const stored = readChapterPlan(node);
  if (stored) return stored;
  if (!looksLikeChapterPlan(node.content)) return null;
  const plan = parseChapterPlan(node.content, {});
  return plan.entries.length > 0 ? plan : null;
}

/**
 * The lore slice for one chapter: its own entry plus enough following entries
 * to reach `chapters` descriptions IN TOTAL (1 = only the elaborated chapter),
 * clamped to the plan. Returns '' when the plan does not cover the chapter —
 * the caller then simply behaves as if there were no plan (never borrow a
 * neighbouring chapter into canon).
 */
export function chapterPlanSlice(
  plan: ChapterPlan | null,
  chapter: number,
  chapters: number,
): string {
  if (!plan || plan.entries.length === 0) return '';
  const from = plan.entries.findIndex((e) => e.chapter === chapter);
  if (from < 0) return '';
  // TOTAL descriptions per send, so the number the user types is exactly the
  // number of chapters that end up in the lore ("1" = the chapter alone).
  const wanted = Math.max(1, Math.floor(chapters || 0));
  const to = Math.min(plan.entries.length, from + wanted);
  return plan.entries
    .slice(from, to)
    .map((e) => `${e.chapter}. ${e.text}`)
    .join('\n');
}

/** One-line description of a plan for a UI label ("7–16, 10 chapters"). */
export function chapterPlanLabel(plan: ChapterPlan | null): string {
  if (!plan || plan.entries.length === 0) return '';
  const first = plan.entries[0].chapter;
  const last = plan.entries[plan.entries.length - 1].chapter;
  return `${first}–${last}, ${plan.entries.length}`;
}
