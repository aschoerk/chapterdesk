import { strFromU8, unzipSync } from 'fflate';

export interface DocxChapter {
  heading: string;
  content: string;
}

export interface ParsedDocxBook {
  title: string;
  chapters: DocxChapter[];
}

interface WordParagraph {
  text: string;
  style: string;
}

function paragraphs(xml: string): WordParagraph[] {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('The DOCX document XML is invalid.');
  return [...document.getElementsByTagName('w:p')].map(paragraph => {
    const style = paragraph.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') ?? '';
    let text = '';
    for (const child of Array.from(paragraph.getElementsByTagName('*'))) {
      if (child.tagName === 'w:t') text += child.textContent ?? '';
      else if (child.tagName === 'w:tab') text += '\t';
      else if (child.tagName === 'w:br' || child.tagName === 'w:cr') text += '\n';
    }
    return { text: text.trim(), style };
  }).filter(paragraph => paragraph.text.length > 0);
}

function normalizeHeading(text: string): string {
  return text
    .replace(/\t.*$/, '')
    .replace(/\s+\d+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function isTocStyle(style: string): boolean {
  return /^TOC\s*\d*$/i.test(style);
}

function tocStyleLevel(style: string): number {
  return Number(style.match(/^TOC\s*(\d+)$/i)?.[1] ?? 1);
}

function isHeadingStyle(style: string): boolean {
  return /^Heading\s*\d*$/i.test(style);
}

function headingStyleLevel(style: string): number {
  return Number(style.match(/^Heading\s*(\d+)$/i)?.[1] ?? 1);
}

function contentParagraph(paragraph: WordParagraph): boolean {
  return !isTocStyle(paragraph.style);
}

type ChapterStart = { index: number; heading: string };

const REASONABLE_CHAPTER_COUNT = 3;

function isObviousContentsHeading(text: string): boolean {
  return /^(table of contents|contents)\b/i.test(text.trim());
}

function chapterStarts(body: WordParagraph[], toc: WordParagraph[]): ChapterStart[] {
  const tocTopLevel = toc.length
    ? Math.min(...toc.map(paragraph => tocStyleLevel(paragraph.style)))
    : null;
  const tocHeadings = toc
    .filter(paragraph => tocTopLevel === null || tocStyleLevel(paragraph.style) === tocTopLevel)
    .map(paragraph => ({ heading: paragraph.text.replace(/\t.*$/, '').replace(/\s+\d+\s*$/, '').trim() }))
    .filter(entry => normalizeHeading(entry.heading));
  const headingStyles = body.filter(paragraph => isHeadingStyle(paragraph.style));
  const matchHeadings = (headings: Array<{ heading: string }>): ChapterStart[] => {
    const starts: ChapterStart[] = [];
    let searchFrom = 0;
    for (const entry of headings) {
      const normalized = normalizeHeading(entry.heading);
      const index = body.findIndex((paragraph, i) =>
        i >= searchFrom && normalizeHeading(paragraph.text) === normalized,
      );
      if (index < 0) continue;
      starts.push({ index, heading: entry.heading });
      searchFrom = index + 1;
    }
    return starts;
  };

  const tocStarts = matchHeadings(tocHeadings);
  if (tocHeadings.length > 0 && tocStarts.length === tocHeadings.length) return tocStarts;

  const startsAtLevel = (level: number): ChapterStart[] => matchHeadings(
    headingStyles
      .filter(paragraph => headingStyleLevel(paragraph.style) === level)
      .filter(paragraph => !isObviousContentsHeading(paragraph.text))
      .map(paragraph => ({ heading: paragraph.text })),
  );

  const byLevel = [1, 2, 3, 4].map(level => ({ level, starts: startsAtLevel(level) }));

  // Per the requested preference: Heading1, then Heading2, when that level
  // yields a reasonable chapter count (e.g. a title page alone is not a
  // structuring). A later level is only consulted when the earlier one fails.
  for (const level of [1, 2]) {
    const found = byLevel.find(entry => entry.level === level);
    if (found && found.starts.length >= REASONABLE_CHAPTER_COUNT) return found.starts;
  }

  // Otherwise prefer the level that yields the most boundaries (falling back
  // to Heading3/Heading4, then a lone boundary, then the TOC starts).
  const best = [...byLevel].sort((a, b) => b.starts.length - a.starts.length)[0];
  if (best.starts.length >= 2) return best.starts;
  if (best.starts.length > 0) return best.starts;
  return tocStarts;
}

function documentTitle(coreXml: string | undefined, paragraphsInBody: WordParagraph[]): string {
  if (coreXml) {
    const document = new DOMParser().parseFromString(coreXml, 'application/xml');
    const title = document.getElementsByTagName('dc:title')[0]?.textContent?.trim();
    if (title) return title;
  }
  return paragraphsInBody[0]?.text || 'Imported book';
}

export async function parseDocxBook(file: Blob): Promise<ParsedDocxBook> {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const documentXml = archive['word/document.xml'];
  if (!documentXml) throw new Error('This DOCX file has no Word document content.');

  const xml = strFromU8(documentXml);
  const bodyParagraphs = paragraphs(xml).filter(contentParagraph);
  const tocParagraphs = paragraphs(xml).filter(paragraph => isTocStyle(paragraph.style));
  const starts = chapterStarts(bodyParagraphs, tocParagraphs);
  if (starts.length === 0) {
    throw new Error('No chapter headings from the table of contents could be matched to the document.');
  }

  const chapters: DocxChapter[] = starts.map((start, i) => {
    const end = starts[i + 1]?.index ?? bodyParagraphs.length;
    const content = bodyParagraphs
      .slice(start.index, end)
      .map(paragraph => paragraph.text)
      .join('\n\n')
      .trim();
    return { heading: start.heading, content };
  }).filter(chapter => chapter.content.length > 0);

  const coreXml = archive['docProps/core.xml'];
  return { title: documentTitle(coreXml ? strFromU8(coreXml) : undefined, bodyParagraphs), chapters };
}