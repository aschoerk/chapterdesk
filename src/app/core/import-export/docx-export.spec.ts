import { describe, it, expect } from 'vitest';
import { ChatNode } from '../models/chat';
import { makeNode } from '../../../test-helpers/factories';
import {
  buildDocxBlob,
  buildMarkdown,
  classifyStructure,
  enumerateDocumentPaths,
  imageDimensions,
  imageSizeEmu,
  pickDocumentPath,
} from './docx-export';

function node(o: Partial<ChatNode>): ChatNode {
  return makeNode(o);
}

// ---------------------------------------------------------------------------
// Document enumeration / selection (shared youngest-version algorithm)
// ---------------------------------------------------------------------------

describe('docx-export · document selection', () => {
  it('enumerates only the youngest version of an answer family', () => {
    const nodes = [
      node({ id: 'q1', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      // a1 is retired by a2 (same logical beat, newer version)
      node({
        id: 'a1', chatId: 'c1', parentId: 'q1', role: 'assistant',
        content: 'Short chapter', version: 1, isCurrent: false,
        createdAt: '2025-01-01T00:00:00Z',
      }),
      node({
        id: 'a2', chatId: 'c1', parentId: 'q1', role: 'assistant',
        content: 'This is a much longer chapter with more words in it than the old one',
        previousVersionId: 'a1', version: 2, isCurrent: true,
        createdAt: '2025-01-02T00:00:00Z',
      }),
    ];

    const paths = enumerateDocumentPaths(nodes);
    // the younger version replaces the older one — a single document
    expect(paths).toHaveLength(1);
    expect(paths[0].map(n => n.id)).toContain('a2');
    expect(paths[0].some(n => n.id === 'a1')).toBe(false);
    // the most-recent path is the only candidate
    expect(pickDocumentPath(paths).map(n => n.id)).toContain('a2');
  });

  it('picks the document containing the most recent node', () => {
    const nodes = [
      node({ id: 'q1', chatId: 'c1', parentId: null, role: 'user', content: 'Q', createdAt: '2025-01-01T00:00:00Z' }),
      node({ id: 'b1', chatId: 'c1', parentId: 'q1', role: 'assistant', content: 'Branch one', version: 1, createdAt: '2025-01-02T00:00:00Z' }),
      node({ id: 'b2', chatId: 'c1', parentId: 'q1', role: 'assistant', content: 'Branch two', version: 1, createdAt: '2025-01-03T00:00:00Z' }),
    ];
    const paths = enumerateDocumentPaths(nodes);
    expect(paths).toHaveLength(2);
    expect(pickDocumentPath(paths).map(n => n.id)).toEqual(['q1', 'b2']);
  });

  it('honours an explicit candidate index', () => {
    const nodes = [
      node({ id: 'q1', chatId: 'c1', parentId: null, role: 'user', content: 'Q', createdAt: '2025-01-01T00:00:00Z' }),
      node({ id: 'b1', chatId: 'c1', parentId: 'q1', role: 'assistant', content: 'Branch one', version: 1, createdAt: '2025-01-02T00:00:00Z' }),
      node({ id: 'b2', chatId: 'c1', parentId: 'q1', role: 'assistant', content: 'Branch two', version: 1, createdAt: '2025-01-03T00:00:00Z' }),
    ];
    const paths = enumerateDocumentPaths(nodes);
    expect(pickDocumentPath(paths, 0).map(n => n.id)).toEqual(['q1', 'b1']);
    expect(pickDocumentPath(paths, 99).map(n => n.id)).toEqual(['q1', 'b2']); // invalid → most recent
  });
});

// ---------------------------------------------------------------------------
// Structure classification
// ---------------------------------------------------------------------------

describe('docx-export · classifyStructure', () => {
  it('uses the first structural node as title and last as introduction', () => {
    const path = [
      node({ id: 'sTitle', parentId: 'q0', role: 'structural', content: 'My Great Book' }),
      node({ id: 'q1', parentId: 'sTitle', role: 'user', content: 'Q' }),
      node({ id: 'h1', parentId: 'q1', role: 'structural', content: 'Chapter the First' }),
      node({ id: 'a1', parentId: 'h1', role: 'assistant', content: 'Once upon a time…' }),
      node({ id: 'q2', parentId: 'a1', role: 'user', content: 'Q' }),
      node({ id: 'h2', parentId: 'q2', role: 'structural', content: 'Chapter the Second' }),
      node({ id: 'a2', parentId: 'h2', role: 'assistant', content: 'And then…' }),
      node({ id: 'sIntro', parentId: 'a2', role: 'structural', content: 'This is the introduction.' }),
    ];

    const doc = classifyStructure(path, 'Fallback Title');

    expect(doc.title).toBe('My Great Book');
    expect(doc.intro).toBe('This is the introduction.');
    expect(doc.chapters).toEqual([
      { heading: 'Chapter the First', content: path.find(n => n.id === 'a1')! },
      { heading: 'Chapter the Second', content: path.find(n => n.id === 'a2')! },
    ]);
  });

  it('falls back to the chat title when there is no structural first node', () => {
    const path = [
      node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'a1', parentId: 'q1', role: 'assistant', content: 'Chapter body' }),
    ];
    const doc = classifyStructure(path, 'Chat Title');
    expect(doc.title).toBe('Chat Title');
    expect(doc.intro).toBeNull();
    expect(doc.chapters).toEqual([{ heading: '', content: path.find(n => n.id === 'a1')! }]);
  });

  it('treats a structural directly before a chapter as its heading', () => {
    const path = [
      node({ id: 'q1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'h', parentId: 'q1', role: 'structural', content: 'A Heading' }),
      node({ id: 'a1', parentId: 'h', role: 'assistant', content: 'body' }),
    ];
    const doc = classifyStructure(path, '');
    expect(doc.chapters[0].heading).toBe('A Heading');
  });
});

// ---------------------------------------------------------------------------
// DOCX / ZIP output
// ---------------------------------------------------------------------------

describe('docx-export · buildDocxBlob', () => {
  it('produces a ZIP OpenXML package containing the book', async () => {
    const nodes = [
      node({ id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'sTitle', chatId: 'c1', parentId: 'q0', role: 'structural', content: 'Book Title' }),
      node({ id: 'q1', chatId: 'c1', parentId: 'sTitle', role: 'user', content: 'Q' }),
      node({ id: 'h1', chatId: 'c1', parentId: 'q1', role: 'structural', content: 'Ch One' }),
      node({ id: 'a1', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'Story **bold** text.' }),
      node({ id: 'q2', chatId: 'c1', parentId: 'a1', role: 'user', content: 'Q' }),
      node({ id: 'a2', chatId: 'c1', parentId: 'q2', role: 'assistant', content: 'More of the story.' }),
      node({ id: 'sIntro', chatId: 'c1', parentId: 'a2', role: 'structural', content: 'Intro words.' }),
    ];

    const blob = buildDocxBlob('Fallback', nodes);
    expect(blob.type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    const buf = new Uint8Array(await blob.arrayBuffer());
    // ZIP magic: PK\x03\x04
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);

    const text = new TextDecoder().decode(buf);
    expect(text).toContain('[Content_Types].xml');
    expect(text).toContain('word/document.xml');

    // stored entries appear verbatim in the byte stream
    expect(text).toContain('Book Title');
    expect(text).toContain('Ch One');
    expect(text).toContain('Story');
    expect(text).toContain('<w:b/>'); // bold run
    expect(text).toContain('Intro words.');
    expect(text).toContain('Heading1');
  });

  it('embeds attached pictures (only pictures) after their chapter', async () => {
    const nodes = [
      node({ id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'sTitle', chatId: 'c1', parentId: 'q0', role: 'structural', content: 'Book Title' }),
      node({ id: 'q1', chatId: 'c1', parentId: 'sTitle', role: 'user', content: 'Q' }),
      node({ id: 'h1', chatId: 'c1', parentId: 'q1', role: 'structural', content: 'Ch One' }),
      node({
        id: 'a1', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'Story text.',
        attachments: [
          { id: 'img1', name: 'illustration-1.png', mimeType: 'image/png', size: 8, dataUrl: 'data:image/png;base64,QUJDRA==' },
          { id: 'img2', name: 'illustration-2.png', mimeType: 'image/png', size: 8, dataUrl: 'data:image/png;base64,REVGRw==' },
          // A prompt record must NOT be embedded ("pictures only").
          { id: 'p1', name: 'prompt-1.txt', mimeType: 'text/plain', size: 3, dataUrl: 'data:text/plain;charset=utf-8,hello' },
        ],
      }),
      node({ id: 'q2', chatId: 'c1', parentId: 'a1', role: 'user', content: 'Q' }),
      node({ id: 'a2', chatId: 'c1', parentId: 'q2', role: 'assistant', content: 'More.' }),
    ];

    const blob = buildDocxBlob('Fallback', nodes);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder().decode(buf);

    // Both pictures are embedded as media parts + referenced by rels.
    expect(text).toContain('word/media/image-1.png');
    expect(text).toContain('word/media/image-2.png');
    expect(text).toContain('rIdImg1');
    expect(text).toContain('rIdImg2');
    expect(text).toContain('<a:blip r:embed="rIdImg1"');
    expect(text).toContain('<a:blip r:embed="rIdImg2"');
    // The image bytes themselves are stored verbatim (stored ZIP entries):
    // 'QUJDRA==' base64-decodes to the ASCII bytes "ABCD".
    const img1Bytes = new Uint8Array([0x41, 0x42, 0x43, 0x44]); // A B C D
    const img2Bytes = new Uint8Array([0x44, 0x45, 0x46, 0x47]); // D E F G
    const hasSub = (needle: Uint8Array) => {
      outer: for (let i = 0; i + needle.length <= buf.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (buf[i + j] !== needle[j]) continue outer;
        }
        return true;
      }
      return false;
    };
    expect(hasSub(img1Bytes)).toBe(true);
    expect(hasSub(img2Bytes)).toBe(true);
    // The content types declare the embedded image extension (PNG default).
    expect(text).toContain('<Default Extension="png" ContentType="image/png"/>');
    // The prompt record is NOT included as an image/media part.
    expect(text).not.toContain('prompt-1.txt');
    expect(text).not.toContain('word/media/image-3');
  });

  it('sizes the inline drawing to the ORIGINAL aspect ratio of the picture', async () => {
    // A real PNG header: 100px × 200px (2:1 tall). At 96 px/inch that is
    // ~1.04in × 2.08in — under the caps, so no clamping; the drawing extent
    // must carry that exact (width:height) ratio in EMU.
    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0xc8, // width 100, height 200
      0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const b64 = btoa(String.fromCharCode(...pngHeader));
    const nodes = [
      node({ id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'h1', chatId: 'c1', parentId: 'q0', role: 'structural', content: 'Ch One' }),
      node({
        id: 'a1', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'Story text.',
        attachments: [
          { id: 'img1', name: 'illustration-1.png', mimeType: 'image/png', size: pngHeader.length, dataUrl: `data:image/png;base64,${b64}` },
        ],
      }),
    ];

    const blob = buildDocxBlob('Fallback', nodes);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder().decode(buf);

    // 100/200 at 96 px/inch → cx = round(100/96*914400) = 952500,
    // cy = round(200/96*914400) = 1905000 (2:1 tall ratio preserved).
    expect(text).toContain('<wp:extent cx="952500" cy="1905000"/>');
    expect(text).toContain('<a:ext cx="952500" cy="1905000"/>');
  });
});

// ---------------------------------------------------------------------------
// Original-size image embedding
// ---------------------------------------------------------------------------

describe('docx-export · imageDimensions', () => {
  it('parses a PNG header (width/height in IHDR)', () => {
    // 8-byte signature + IHDR length(13) + "IHDR" + width(100) + height(200) …
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0xc8,
      0x08, 0x06, 0x00, 0x00, 0x00,
    ]);
    expect(imageDimensions(bytes)).toEqual({ width: 100, height: 200 });
  });

  it('parses a GIF header (screen size as u16 LE)', () => {
    const bytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      0x64, 0x00, 0xc8, 0x00, // width 100, height 200
      0x00,
    ]);
    expect(imageDimensions(bytes)).toEqual({ width: 100, height: 200 });
  });

  it('parses a JPEG header (SOF0 height/width as u16 BE)', () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
      0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08,
      0x00, 0xc8, 0x00, 0x64, // height 200, width 100
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(imageDimensions(bytes)).toEqual({ width: 100, height: 200 });
  });

  it('parses a WebP VP8X header (canvas size as u24 LE, 1-based)', () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x63, 0x00, 0x00, 0xc7, 0x00, 0x00, // canvas w 100-1, canvas h 200-1
    ]);
    expect(imageDimensions(bytes)).toEqual({ width: 100, height: 200 });
  });

  it('returns null for malformed/unknown data', () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});

describe('docx-export · imageSizeEmu', () => {
  it('preserves the original aspect ratio and caps to the page width', () => {
    // A 2000×1000 image at 96 px/inch = ~20.8in wide → clamped to 6.5in wide,
    // height scaled to keep the 2:1 ratio (3.25in).
    const { cx, cy } = imageSizeEmu(2000, 1000);
    const emuPerInch = 914400;
    expect(cx).toBe(Math.round(6.5 * emuPerInch));
    expect(cy).toBe(Math.round(6.5 * emuPerInch * (1000 / 2000)));
  });

  it('keeps small images at their natural size (no upscaling)', () => {
    // 100×200 at 96 px/inch = 1.04in × 2.08in — well under the caps.
    const { cx, cy } = imageSizeEmu(100, 200);
    expect(cx).toBe(Math.round((100 / 96) * 914400));
    expect(cy).toBe(Math.round((200 / 96) * 914400));
  });

  it('falls back to the default box when dimensions are unknown', () => {
    expect(imageSizeEmu(0, 0)).toEqual({ cx: 4572000, cy: 3048000 });
    expect(imageSizeEmu(undefined, undefined)).toEqual({ cx: 4572000, cy: 3048000 });
  });
});

describe('docx-export · buildMarkdown', () => {
  it('produces the same book structure as plain Markdown', () => {
    const nodes = [
      node({ id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'sTitle', chatId: 'c1', parentId: 'q0', role: 'structural', content: 'Book Title' }),
      node({ id: 'q1', chatId: 'c1', parentId: 'sTitle', role: 'user', content: 'Q' }),
      node({ id: 'h1', chatId: 'c1', parentId: 'q1', role: 'structural', content: 'Ch One' }),
      node({ id: 'a1', chatId: 'c1', parentId: 'h1', role: 'assistant', content: 'Story text.' }),
      node({ id: 'q2', chatId: 'c1', parentId: 'a1', role: 'user', content: 'Q' }),
      node({ id: 'a2', chatId: 'c1', parentId: 'q2', role: 'assistant', content: 'More of the story.' }),
      node({ id: 'sIntro', chatId: 'c1', parentId: 'a2', role: 'structural', content: 'Intro words.' }),
    ];

    const md = buildMarkdown('Fallback', nodes);

    expect(md).toContain('# Book Title');
    expect(md).toContain('## Introduction');
    expect(md).toContain('Intro words.');
    expect(md).toContain('# Ch One');
    expect(md).toContain('Story text.');
    expect(md).toContain('More of the story.');
  });

  it('picks the longest version', () => {
    const nodes = [
      node({ id: 'q0', chatId: 'c1', parentId: null, role: 'user', content: 'Q' }),
      node({ id: 'a1', chatId: 'c1', parentId: 'q0', role: 'assistant', content: 'old', version: 1, isCurrent: false }),
      node({
        id: 'a2', chatId: 'c1', parentId: 'q0', role: 'assistant',
        content: 'a much longer chapter text', previousVersionId: 'a1', version: 2, isCurrent: true,
      }),
    ];

    const md = buildMarkdown('Title', nodes);
    expect(md).toContain('a much longer chapter text');
    expect(md).not.toContain('>old<');
    expect(md).not.toContain('\nold\n');
  });
});
