/**
 * DOCX export for a single chapterdesk chat.
 *
 * Pure/mostly-pure helpers so the logic is unit-testable without Angular.
 *
 *  - `enumerateDocumentPaths` uses the SHARED story enumerator
 *    (./story-paths — the same algorithm as the chat-reader): youngest version
 *    per family only, plain DFS that clones the path from the root at every
 *    fork. The exporter and the reader therefore always agree on the set of
 *    documents.
 *  - `pickDocumentPath` returns the document containing the MOST RECENT node
 *    (or any chosen candidate index, for the UI "which path?" picker).
 *  - `classifyStructure` maps the linear path onto a book:
 *        first structural node            → title
 *        structural node before a chapter → chapter heading
 *        last structural node             → introduction part
 *  - `buildDocxBlob` produces a Word .docx (OpenXML in a stored-entry ZIP).
 */
import { marked, type Token } from 'marked';
import { ChatNode, NodeAttachment } from '../../models/chat';
import {
  enumerateStoryDocuments,
  isUsableNode,
  pickMostRecentDocument,
} from '../chat/story-paths';

// ---------------------------------------------------------------------------
// Document enumeration & selection (shared algorithm, see ./story-paths)
// ---------------------------------------------------------------------------

/**
 * Every candidate "document" for a chat — the SAME set the chat-reader pages
 * through (youngest version per family, DFS with path cloning).
 */
export function enumerateDocumentPaths(allNodes: ChatNode[]): ChatNode[][] {
  return enumerateStoryDocuments(allNodes);
}

/**
 * Pick the document to export.
 *  - `index` provided and valid → that candidate document.
 *  - otherwise → the document containing the MOST RECENT node.
 */
export function pickDocumentPath(
  paths: ChatNode[][],
  index?: number,
): ChatNode[] {
  if (index !== undefined && Number.isInteger(index) && index >= 0 && index < paths.length) {
    return paths[index];
  }
  return pickMostRecentDocument(paths);
}

// ---------------------------------------------------------------------------
// Structure classification
// ---------------------------------------------------------------------------

export interface DocChapter {
  heading: string;
  content: ChatNode | null;
}

export interface DocStructure {
  title: string;
  intro: string | null;
  chapters: DocChapter[];
}

/** User-facing label used for the optional introduction section. */
export const INTRO_LABEL = 'Introduction';
/** User-facing label used when a bare structural node starts a section. */
export const SECTION_LABEL = 'Section';

/**
 * Turn the linear (longest) path into a book:
 *  - assistant nodes are chapters,
 *  - a structural node immediately before a chapter is its heading,
 *  - the FIRST structural node is the title,
 *  - the LAST structural node is the introduction part.
 */
export function classifyStructure(path: ChatNode[], fallbackTitle: string): DocStructure {
  const kept = path.filter(
    n => (n.role === 'assistant' || n.role === 'structural') && isUsableNode(n),
  );

  let title = fallbackTitle?.trim() || '';
  const first = kept.length ? kept[0] : undefined;
  if (first && first.role === 'structural') {
    title = (first.content || '').trim() || title;
  }

  let intro: string | null = null;
  const last = kept.length > 1 ? kept[kept.length - 1] : undefined;
  if (last && last.role === 'structural') {
    intro = last.content || null;
  }

  const chapters: DocChapter[] = [];
  for (let i = 0; i < kept.length; i++) {
    const n = kept[i];
    if (first && first.role === 'structural' && n.id === first.id) continue;
    if (last && last.role === 'structural' && n.id === last.id) continue;

    if (n.role === 'assistant') {
      const prev = i > 0 ? kept[i - 1] : undefined;
      const heading = prev && prev.role === 'structural' ? (prev.content || '').trim() : '';
      chapters.push({ heading, content: n });
    } else if (n.role === 'structural') {
      // Structural nodes directly in front of a chapter are that chapter's
      // heading (handled by the assistant entry above). Any other structural
      // node that is neither title/intro nor a chapter heading becomes a
      // standalone section divider so its text is never lost.
      const nextNode = kept[i + 1];
      const isChapterHeading = !!nextNode && nextNode.role === 'assistant';
      if (!isChapterHeading) {
        chapters.push({ heading: (n.content || '').trim() || SECTION_LABEL, content: null });
      }
    }
  }

  return { title, intro, chapters };
}

// ---------------------------------------------------------------------------
// OpenXML / OOXML helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

interface RunFormat {
  b?: boolean;
  i?: boolean;
  strike?: boolean;
  mono?: boolean;
  color?: string;
}

function run(text: string, fmt: RunFormat = {}): string {
  const rPr: string[] = [];
  if (fmt.b) rPr.push('<w:b/><w:bCs/>');
  if (fmt.i) rPr.push('<w:i/><w:iCs/>');
  if (fmt.strike) rPr.push('<w:strike/>');
  if (fmt.mono) {
    rPr.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
  }
  if (fmt.color) rPr.push(`<w:color w:val="${fmt.color}"/>`);
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
  const parts = String(text ?? '').split('\n');
  const tXml = parts
    .map((seg, i) => `${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(seg)}</w:t>`)
    .join('');
  return `<w:r>${rPrXml}${tXml}</w:r>`;
}

function paragraph(runs: string, style?: string, extraPPr = ''): string {
  const pPr = style || extraPPr
    ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extraPPr}</w:pPr>`
    : '';
  return `<w:p>${pPr}${runs}</w:p>`;
}

/** Render inline markdown tokens into Word runs. */
function inlineRuns(tokens: Token[]): string {
  let xml = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        xml += run((t as any).text);
        break;
      case 'strong':
        xml += run(inlineText((t as any).tokens ?? []), { b: true });
        break;
      case 'em':
        xml += run(inlineText((t as any).tokens ?? []), { i: true });
        break;
      case 'del':
        xml += run(inlineText((t as any).tokens ?? []), { strike: true });
        break;
      case 'codespan':
        xml += run((t as any).text, { mono: true });
        break;
      case 'br':
        xml += '<w:r><w:br/></w:r>';
        break;
      case 'link':
        xml += inlineRuns((t as any).tokens ?? []);
        break;
      case 'image':
        xml += run((t as any).text || '');
        break;
      case 'escape':
      case 'html':
        xml += run((t as any).text ?? (t as any).raw ?? '');
        break;
      default: {
        const raw = (t as any).text ?? (t as any).raw ?? '';
        if (raw) xml += run(String(raw));
      }
    }
  }
  return xml;
}

function inlineText(tokens: Token[]): string {
  return (tokens ?? [])
    .map(t => {
      switch (t.type) {
        case 'text': return (t as any).text;
        case 'codespan': return (t as any).text;
        case 'br': return '\n';
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          return inlineText((t as any).tokens ?? []);
        default:
          return (t as any).text ?? (t as any).raw ?? '';
      }
    })
    .join('');
}

/** Render a markdown document into Word paragraphs. */
function markdownParagraphs(markdown: string, bodyStyle = 'BodyText'): string[] {
  const tokens = marked.lexer(markdown || '');
  const out: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const depth = (t as any).depth ?? 1;
        const hStyle =
          depth <= 1 ? 'Heading1' : depth === 2 ? 'Heading2' : depth === 3 ? 'Heading3' : 'Heading4';
        out.push(paragraph(inlineRuns((t as any).tokens ?? []), hStyle));
        break;
      }
      case 'paragraph':
        out.push(paragraph(inlineRuns((t as any).tokens ?? []), bodyStyle));
        break;
      case 'blockquote':
        out.push(paragraph(inlineRuns((t as any).tokens?.[0]?.tokens ?? []), 'Quote'));
        break;
      case 'code': {
        const code = (t as any).text ?? '';
        for (const line of code.split('\n')) {
          out.push(paragraph(run(line, { mono: true }), 'CodeBlock'));
        }
        break;
      }
      case 'list': {
        const list = t as any;
        (list.items ?? []).forEach((item: any, idx: number) => {
          const marker = list.ordered ? `${idx + 1}. ` : '• ';
          const paraTok = (item.tokens ?? []).find((x: any) => x.type === 'paragraph');
          const body = paraTok
            ? inlineRuns(paraTok.tokens ?? [])
            : run((item.text ?? '').trim());
          out.push(paragraph(run(marker) + body, list.ordered ? 'ListNumber' : 'ListBullet'));
        });
        break;
      }
      case 'hr':
        out.push(
          '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>',
        );
        break;
      case 'space':
        break;
      case 'html':
      case 'escape':
      case 'text':
        out.push(paragraph(run((t as any).text ?? (t as any).raw ?? ''), bodyStyle));
        break;
      case 'table': {
        const tbl = t as any;
        for (const row of tbl.rows ?? []) {
          const cells = (row ?? []).map((c: any) => c?.text ?? '').join(' | ');
          out.push(paragraph(run(`| ${cells} |`), bodyStyle));
        }
        break;
      }
      default: {
        const raw = (t as any).text ?? (t as any).raw ?? '';
        if (raw) out.push(paragraph(run(String(raw)), bodyStyle));
      }
    }
  }
  return out;
}

const PAGE_BREAK = `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;

// ---------------------------------------------------------------------------
// Image embedding (attached pictures, no text)
// ---------------------------------------------------------------------------

/** Decode a `data:…;base64,…` / `data:…,…` URL into raw bytes, or null. */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  try {
    if (/;base64/i.test(header)) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return null;
  }
}

/** The image attachments of an assistant chapter (pictures only, no text). */
export function chapterImages(ch: DocChapter): NodeAttachment[] {
  return (ch.content?.attachments ?? []).filter(
    a => a.mimeType.startsWith('image/') && a.dataUrl?.startsWith('data:'),
  );
}

interface ImageMedia {
  relId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}

const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

function imageExt(mime: string): string {
  return IMAGE_MIME_EXT[mime] ?? 'png';
}

// ---------------------------------------------------------------------------
// Image dimensions (parsed from the container headers, so the embedded picture
// keeps its ORIGINAL aspect ratio; unknown dimensions fall back to a default).
// ---------------------------------------------------------------------------

function u16be(bytes: Uint8Array, o: number): number {
  return ((bytes[o] << 8) | bytes[o + 1]) >>> 0;
}

function u32be(bytes: Uint8Array, o: number): number {
  return (
    ((bytes[o] << 24) |
      (bytes[o + 1] << 16) |
      (bytes[o + 2] << 8) |
      bytes[o + 3]) >>>
    0
  );
}

function u16le(bytes: Uint8Array, o: number): number {
  return (bytes[o] | (bytes[o + 1] << 8)) >>> 0;
}

function u32le(bytes: Uint8Array, o: number): number {
  return (
    (bytes[o] |
      (bytes[o + 1] << 8) |
      (bytes[o + 2] << 16) |
      (bytes[o + 3] << 24)) >>>
    0
  );
}

/**
 * Parse the pixel dimensions of an image from its container header.
 * Supported: PNG, JPEG, GIF, WebP, BMP. Returns null when unknown.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  try {
    // PNG: 8-byte signature, then IHDR chunk — width/height at 16/20 (BE).
    if (bytes.length >= 24 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
      const w = u32be(bytes, 16);
      const h = u32be(bytes, 20);
      if (w > 0 && h > 0) return { width: w, height: h };
    }

    // GIF: "GIF8[7/9]a" then screen width/height as u16 LE at 6/8.
    if (bytes.length >= 10 &&
        bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
      const w = u16le(bytes, 6);
      const h = u16le(bytes, 8);
      if (w > 0 && h > 0) return { width: w, height: h };
    }

    // BMP: "BM" then file-size u32le at 2, pixel array offset at 10,
    // DIB header width/height as s32le at 18/22 (height sign = orientation).
    if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
      const w = u32le(bytes, 18);
      let h = u32le(bytes, 22);
      h = h & 0x80000000 ? -h : h; // top-down rows are stored as a negative int
      if (w > 0 && h > 0) return { width: w, height: h };
    }

    // WebP: "RIFF" … "WEBP". VP8X (animated/alpha) has canvas size at 24/26
    // as u24 LE (1-based); VP8 (lossy) has dims at 26/28 as u16 LE; VP8L
    // (lossless) stores dims-1 as u14+u14 LE bitfields at 21.
    if (bytes.length >= 30 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (chunk === 'VP8X' && bytes.length >= 30) {
        const w = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
        const h = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
        if (w > 0 && h > 0) return { width: w, height: h };
      } else if (chunk === 'VP8 ' && bytes.length >= 30) {
        const w = u16le(bytes, 26) & 0x3fff;
        const h = u16le(bytes, 28) & 0x3fff;
        if (w > 0 && h > 0) return { width: w, height: h };
      } else if (chunk === 'VP8L' && bytes.length >= 25) {
        const bits = u32le(bytes, 21);
        const w = ((bits & 0x3fff) | ((bits >> 14) & 0x3)) + 1;
        const h = (((bits >> 14) & 0x3fff) | ((bits >> 28) & 0x3)) + 1;
        if (w > 0 && h > 0) return { width: w, height: h };
      }
    }

    // JPEG: scan the marker segments for a SOF0..SOF15 (except DHT C4,
    // JPGn C8) which carries height/width as u16 BE right after the marker.
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let o = 2;
      while (o + 9 < bytes.length) {
        if (bytes[o] !== 0xff) { o++; continue; }
        const marker = bytes[o + 1];
        // Standalone markers (no length) are skipped.
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          o += 2;
          continue;
        }
        const len = u16be(bytes, o + 2);
        if (len < 2) break;
        const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8;
        if (sof) {
          const h = u16be(bytes, o + 5);
          const w = u16be(bytes, o + 7);
          if (w > 0 && h > 0) return { width: w, height: h };
        }
        o += 2 + len;
      }
    }
  } catch {
    /* malformed header — fall through to null */
  }
  return null;
}

/** EMU per inch (1 inch = 914400 EMU). */
const EMU_PER_INCH = 914400;
/** Usable page width (A4/Letter with the default 1in margins) — caps width. */
const MAX_IMAGE_WIDTH_EMU = Math.round(6.5 * EMU_PER_INCH);
/** Max image height, so an extremely tall picture never overflows a page. */
const MAX_IMAGE_HEIGHT_EMU = Math.round(9 * EMU_PER_INCH);

/**
 * Fit an image's pixel dimensions into the page, preserving the ORIGINAL
 * aspect ratio, and return the drawing size in EMU. Falls back to the
 * previous fixed 5:3.33 box when the dimensions are unknown.
 */
export function imageSizeEmu(
  width: number | undefined,
  height: number | undefined,
): { cx: number; cy: number } {
  const fallback = { cx: 4572000, cy: 3048000 };
  if (!width || !height || width <= 0 || height <= 0) return fallback;

  // Scale to pixels per inch (96 px/inch is a sensible default for Word
  // rendering) so a 1024px image lands at ~10.7in wide — then clamp to the
  // page width and scale the height proportionally.
  const pxPerInch = 96;
  let cx = Math.round((width / pxPerInch) * EMU_PER_INCH);
  let cy = Math.round((height / pxPerInch) * EMU_PER_INCH);

  const scale = Math.min(1, MAX_IMAGE_WIDTH_EMU / cx, MAX_IMAGE_HEIGHT_EMU / cy);
  if (scale < 1) {
    cx = Math.round(cx * scale);
    cy = Math.round(cy * scale);
  }
  return { cx, cy };
}

/** An inline `<w:drawing>` that embeds `media` (sized to its original
 *  aspect ratio, capped to the page width). */
function imageDrawing(media: ImageMedia, index: number): string {
  const descr = `Image ${index + 1}`;
  const { cx, cy } = imageSizeEmu(media.width, media.height);
  return (
    '<w:r>' +
    '<w:drawing>' +
    '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="1" name="' + esc(descr) + '"/>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:nvPicPr>' +
    `<pic:cNvPr id="${index + 1}" name="${esc(descr)}"/>` +
    '<pic:cNvPicPr/>' +
    '</pic:nvPicPr>' +
    '<pic:blipFill>' +
    `<a:blip r:embed="${media.relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
    '<a:stretch><a:fillRect/></a:stretch>' +
    '</pic:blipFill>' +
    '<pic:spPr>' +
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '</pic:spPr>' +
    '</pic:pic>' +
    '</a:graphicData>' +
    '</a:graphic>' +
    '</wp:inline>' +
    '</w:drawing>' +
    '</w:r>'
  );
}

function buildDocumentXml(doc: DocStructure, media: ImageMedia[]): string {
  const body: string[] = [];

  if (doc.title) {
    body.push(paragraph(run(doc.title, { b: true }), 'Title'));
  }

  if (doc.intro) {
    body.push(PAGE_BREAK);
    body.push(paragraph(run(INTRO_LABEL, { b: true }), 'Heading1'));
    body.push(...markdownParagraphs(doc.intro, 'IntroText'));
  }

  doc.chapters.forEach((ch, i) => {
    if (i > 0) body.push(PAGE_BREAK);
    if (ch.heading) {
      body.push(paragraph(run(ch.heading, { b: true }), 'Heading1'));
    }
    if (ch.content) {
      body.push(...markdownParagraphs(ch.content.content || '', 'BodyText'));
    }
    // Attached pictures only — the chapter text is handled above; prompt
    // records and other non-image files are intentionally skipped.
    for (const img of chapterImages(ch)) {
      const bytes = dataUrlToBytes(img.dataUrl);
      if (!bytes || bytes.length === 0) continue;
      const mediaEntry: ImageMedia = {
        relId: `rIdImg${media.length + 1}`,
        fileName: `image-${media.length + 1}.${imageExt(img.mimeType)}`,
        mimeType: img.mimeType || 'image/png',
        bytes,
        width: imageDimensions(bytes)?.width ?? 0,
        height: imageDimensions(bytes)?.height ?? 0,
      };
      media.push(mediaEntry);
      body.push(paragraph(imageDrawing(mediaEntry, media.length - 1)));
    }
  });

  const sectPr =
    '<w:sectPr>' +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr>';

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join('')}${sectPr}</w:body>` +
    '</w:document>'
  );
}

function documentRelsXml(media: ImageMedia[]): string {
  let rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  for (const m of media) {
    rels +=
      `<Relationship Id="${m.relId}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
      `Target="media/${m.fileName}"/>`;
  }
  rels += '</Relationships>';
  return rels;
}

function contentTypesXml(imageExts: string[]): string {
  const defaults = [...new Set(imageExts)]
    .map(ext => `<Default Extension="${ext}" ContentType="image/${ext === 'jpg' ? 'jpeg' : ext}"/>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    defaults +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/>' +
  '<w:pPr><w:spacing w:after="180" w:line="300" w:lineRule="auto"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/><w:color w:val="1F1F1F"/></w:rPr>' +
  '<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="360"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/><w:color w:val="1F3864"/></w:rPr>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="160"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/><w:color w:val="2E5395"/></w:rPr>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="220" w:after="120"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:i/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:b/><w:i/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="595959"/></w:rPr>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:i/><w:color w:val="595959"/></w:rPr>' +
  '<w:pPr><w:ind w:left="360" w:right="360"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="IntroText"><w:name w:val="Intro Text"/><w:basedOn w:val="BodyText"/>' +
  '<w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="BodyText"/>' +
  '<w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="BodyText"/>' +
  '<w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
  '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr>' +
  '<w:pPr><w:shd w:val="clear" w:fill="F2F2F2"/><w:ind w:left="360"/></w:pPr></w:style>' +
  '</w:styles>';

const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

function coreXml(title: string, created: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title>` +
    `<dc:creator>ChapterDesk</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${esc(created)}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${esc(created)}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<Application>ChapterDesk</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
  '<Company>ChapterDesk</Company>' +
  '</Properties>';

// ---------------------------------------------------------------------------
// Minimal ZIP writer (stored entries, no compression) + CRC32
// ---------------------------------------------------------------------------

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date:
      ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed to extract
    local.setUint16(6, 0x0800, true); // general purpose flag: UTF-8 names
    local.setUint16(8, 0, true); // compression method: store
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra length
    localChunks.push(new Uint8Array(local.buffer), nameBytes, e.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); // central directory header
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); // method: store
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true); // extra length
    cd.setUint16(32, 0, true); // comment length
    cd.setUint16(34, 0, true); // disk number start
    cd.setUint16(36, 0, true); // internal attributes
    cd.setUint32(38, 0, true); // external attributes
    cd.setUint32(42, offset, true); // local header offset
    centralChunks.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + e.data.length;
  }

  const centralSize = centralChunks.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end of central directory
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // central dir disk
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralOffset, true);
  eocd.setUint16(20, 0, true); // comment length

  const total =
    localChunks.reduce((s, c) => s + c.length, 0) +
    centralChunks.reduce((s, c) => s + c.length, 0) +
    22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of [...localChunks, ...centralChunks, new Uint8Array(eocd.buffer)]) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Shared: resolve a chat's chosen document into a book structure. */
export function resolveDocStructure(
  chatTitle: string,
  allNodes: ChatNode[],
  options?: { index?: number; path?: ChatNode[] },
): { path: ChatNode[]; doc: DocStructure } {
  const paths = enumerateDocumentPaths(allNodes);
  const path = options?.path && options.path.length
    ? options.path
    : pickDocumentPath(paths, options?.index);
  return { path, doc: classifyStructure(path, chatTitle) };
}

/**
 * Build a .docx Blob for the chosen document of a chat's assistant + structure
 * nodes. Without an explicit choice, the document containing the MOST RECENT
 * node is used.
 *
 * Attached PICTURES of every included chapter are embedded in the document
 * (inline drawings after the chapter text). Other attachments — prompt
 * records, PDFs, etc. — are intentionally NOT embedded ("pictures only").
 */
export function buildDocxBlob(
  chatTitle: string,
  allNodes: ChatNode[],
  options?: { index?: number; path?: ChatNode[] },
): Blob {
  const { doc } = resolveDocStructure(chatTitle, allNodes, options);
  const now = new Date().toISOString();

  // Collect the media parts (attached pictures across all included chapters)
  // while building document.xml — buildDocumentXml fills this array, so the
  // relIds used in the drawings always match the ZIP entries below.
  const media: ImageMedia[] = [];
  // Build document.xml FIRST: it populates `media` with the image parts, so
  // the content-types / relationships below see the real extensions.
  const documentXml = strBytes(buildDocumentXml(doc, media));

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: strBytes(contentTypesXml(media.map(m => imageExt(m.mimeType)))) },
    { name: '_rels/.rels', data: strBytes(RELS_XML) },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: strBytes(documentRelsXml(media)) },
    { name: 'word/styles.xml', data: strBytes(STYLES_XML) },
    { name: 'docProps/core.xml', data: strBytes(coreXml(doc.title || chatTitle, now)) },
    { name: 'docProps/app.xml', data: strBytes(APP_XML) },
  ];
  for (const m of media) {
    entries.push({ name: `word/media/${m.fileName}`, data: m.bytes });
  }

  const zip = buildZip(entries);
  return new Blob([zip as BlobPart], { type: DOCX_MIME });
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

/**
 * Build a plain Markdown document for the longest version of a chat's
 * assistant + structure nodes (same book structure as the DOCX export):
 *
 *     # Title
 *
 *     ## Introduction
 *     …
 *
 *     # Chapter heading
 *     …
 */
export function buildMarkdown(
  chatTitle: string,
  allNodes: ChatNode[],
  options?: { index?: number; path?: ChatNode[] },
): string {
  const { doc } = resolveDocStructure(chatTitle, allNodes, options);
  const out: string[] = [];

  if (doc.title) {
    out.push(`# ${doc.title}`, '');
  }

  if (doc.intro) {
    out.push(`## ${INTRO_LABEL}`, '', doc.intro.trim(), '');
  }

  doc.chapters.forEach((ch) => {
    if (out.length > 0) out.push('---', '');
    if (ch.heading) {
      out.push(`# ${ch.heading}`, '');
    }
    if (ch.content?.content?.trim()) {
      out.push(ch.content.content.trim(), '');
    }
  });

  return out.join('\n').trim() + '\n';
}

function strBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
