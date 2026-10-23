import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseDocxBook } from './docx-import';

function paragraph(text: string, style = ''): string {
  const pStyle = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pStyle}<w:r><w:t>${text}</w:t></w:r></w:p>`;
}

async function docx(body: string[], title = 'Imported novel'): Promise<Blob> {
  const archive = zipSync({
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}</w:body></w:document>`),
    'docProps/core.xml': strToU8(`<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`),
  });
  const buffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
  return new Blob([buffer]);
}

describe('docx-import', () => {
  it('uses TOC entries to split chapter text and excludes the TOC', async () => {
    const file = await docx([
      paragraph('Contents', 'TOCHeading'),
      paragraph('Chapter One\t1', 'TOC1'),
      paragraph('Chapter One section\t2', 'TOC2'),
      paragraph('Chapter Two\t5', 'TOC1'),
      paragraph('Chapter One', 'Heading1'),
      paragraph('The opening scene.'),
      paragraph('A second paragraph.'),
      paragraph('Chapter Two', 'Heading1'),
      paragraph('The next chapter begins.'),
    ]);

    await expect(parseDocxBook(file)).resolves.toEqual({
      title: 'Imported novel',
      chapters: [
        { heading: 'Chapter One', content: 'Chapter One\n\nThe opening scene.\n\nA second paragraph.' },
        { heading: 'Chapter Two', content: 'Chapter Two\n\nThe next chapter begins.' },
      ],
    });
  });

  it('falls back to Word heading styles when no TOC is available', async () => {
    const file = await docx([
      paragraph('Preface text'),
      paragraph('Part One', 'Heading1'),
      paragraph('First part.'),
      paragraph('Part Two', 'Heading1'),
      paragraph('Second part.'),
    ]);

    const parsed = await parseDocxBook(file);
    expect(parsed.chapters.map(chapter => chapter.heading)).toEqual(['Part One', 'Part Two']);
    expect(parsed.chapters[0].content).toContain('First part.');
    expect(parsed.chapters[0].content).not.toContain('Preface text');
  });

  it('falls back from an unmatched TOC and coarse Heading1 to Heading2 chapters', async () => {
    const file = await docx([
      paragraph('Contents', 'TOCHeading'),
      paragraph('Missing chapter entry', 'TOC 1'),
      paragraph('Part One', 'Heading 1'),
      paragraph('Chapter One', 'Heading 2'),
      paragraph('First chapter.'),
      paragraph('Chapter Two', 'Heading 2'),
      paragraph('Second chapter.'),
    ]);

    const parsed = await parseDocxBook(file);
    expect(parsed.chapters.map(chapter => chapter.heading)).toEqual(['Chapter One', 'Chapter Two']);
    expect(parsed.chapters[0].content).toContain('First chapter.');
    expect(parsed.chapters[1].content).toContain('Second chapter.');
  });

  it('skips a title-page Heading1 and uses Heading2 when it carries the chapters', async () => {
    const file = await docx([
      paragraph('Table of Contents', 'Heading 1'),
      paragraph('A LITTLE GIRL IN OLD PHILADELPHIA', 'Heading 1'),
      paragraph('CONTENTS.', 'Heading 2'),
      paragraph('CHAPTER I.', 'Heading 2'),
      paragraph('HERE AND THERE.', 'Heading 3'),
      paragraph('First chapter text.'),
      paragraph('CHAPTER II.', 'Heading 2'),
      paragraph('BESSY WARDOUR.', 'Heading 3'),
      paragraph('Second chapter text.'),
    ]);

    const parsed = await parseDocxBook(file);
    expect(parsed.chapters.map(chapter => chapter.heading)).toEqual(['CHAPTER I.', 'CHAPTER II.']);
    expect(parsed.chapters[0].content).toContain('First chapter text.');
    expect(parsed.chapters[1].content).toContain('Second chapter text.');
  });
});