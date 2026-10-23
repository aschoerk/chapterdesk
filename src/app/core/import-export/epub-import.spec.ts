import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseEpubBook } from './epub-import';

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

async function epub(files: Record<string, string>): Promise<Blob> {
  const archive = zipSync(Object.fromEntries(
    Object.entries({ 'META-INF/container.xml': CONTAINER, ...files }).map(([k, v]) => [k, strToU8(v)]),
  ));
  const buffer = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
  return new Blob([buffer]);
}

const OPF_EPUB2 = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>My Epub Book</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;

const NCX = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="chapter1.xhtml"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>Chapter Two</text></navLabel><content src="chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>`;

const CH1 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter One</title></head><body>
<h1>Chapter One</h1><p>First paragraph &amp; more.</p><p>Second line.</p>
</body></html>`;

const CH2 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter Two</title></head><body>
<h1>Chapter Two</h1><p>Body of two.</p>
</body></html>`;

describe('epub-import', () => {
  it('reads title and chapters from an EPUB2 NCX, decoding HTML entities', async () => {
    const file = await epub({
      'OPS/package.opf': OPF_EPUB2,
      'OPS/toc.ncx': NCX,
      'OPS/chapter1.xhtml': CH1,
      'OPS/chapter2.xhtml': CH2,
    });

    await expect(parseEpubBook(file)).resolves.toEqual({
      title: 'My Epub Book',
      chapters: [
        { heading: 'Chapter One', content: 'Chapter One\n\nFirst paragraph & more.\n\nSecond line.' },
        { heading: 'Chapter Two', content: 'Chapter Two\n\nBody of two.' },
      ],
    });
  });

  it('reads the TOC from an EPUB3 nav document', async () => {
    const nav = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">Chapter One</a></li><li><a href="chapter2.xhtml">Chapter Two</a></li></ol></nav></body></html>`;
    const opf3 = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Nav Book</dc:title></metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
    const file = await epub({
      'OPS/package.opf': opf3,
      'OPS/nav.xhtml': nav,
      'OPS/chapter1.xhtml': CH1,
      'OPS/chapter2.xhtml': CH2,
    });

    const parsed = await parseEpubBook(file);
    expect(parsed.title).toBe('Nav Book');
    expect(parsed.chapters.map(c => c.heading)).toEqual(['Chapter One', 'Chapter Two']);
  });

  it('slices one chapter file by fragment anchors when several TOC entries share it', async () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Split Book</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="all" href="all.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="all"/></spine>
</package>`;
    const ncx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1"><navLabel><text>Part One</text></navLabel><content src="all.xhtml#sec1"/></navPoint>
  <navPoint id="n2"><navLabel><text>Part Two</text></navLabel><content src="all.xhtml#sec2"/></navPoint>
</navMap></ncx>`;
    const all = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<div id="sec1"><h1>Part One</h1><p>First part text.</p></div>
<div id="sec2"><h1>Part Two</h1><p>Second part text.</p></div>
</body></html>`;
    const file = await epub({ 'OPS/package.opf': opf, 'OPS/toc.ncx': ncx, 'OPS/all.xhtml': all });

    const parsed = await parseEpubBook(file);
    expect(parsed.chapters).toEqual([
      { heading: 'Part One', content: 'Part One\n\nFirst part text.' },
      { heading: 'Part Two', content: 'Part Two\n\nSecond part text.' },
    ]);
  });

  it('falls back to the spine when no TOC exists', async () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>No Toc</dc:title></metadata>
  <manifest>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
    const file = await epub({ 'OPS/package.opf': opf, 'OPS/chapter1.xhtml': CH1, 'OPS/chapter2.xhtml': CH2 });

    const parsed = await parseEpubBook(file);
    expect(parsed.chapters.map(c => c.heading)).toEqual(['Chapter One', 'Chapter Two']);
    expect(parsed.chapters[0].content).toContain('First paragraph');
  });
});
