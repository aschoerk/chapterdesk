import { strFromU8, unzipSync } from 'fflate';

export interface EpubChapter {
  heading: string;
  content: string;
}

export interface ParsedEpubBook {
  title: string;
  chapters: EpubChapter[];
}

interface ManifestItem {
  href: string;
  mediaType: string;
  properties: string;
}

interface TocEntry {
  heading: string;
  /** Resolved path relative to the archive root, including any #fragment. */
  href: string;
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TR', 'SECTION', 'ARTICLE', 'PRE', 'FIGCAPTION', 'DT', 'DD', 'TABLE', 'UL', 'OL',
]);

function elementsByLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter(el => el.localName === name);
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid EPUB XML.');
  return doc;
}

function parseHtml(text: string): Document {
  return new DOMParser().parseFromString(text, 'text/html');
}

/** Resolve `href` (from an OPF/NCX) against the OPF directory. Keeps fragments. */
function resolveHref(baseDir: string, href: string): string {
  const clean = href.split('#')[0];
  const joined = clean ? `${baseDir ? `${baseDir}/` : ''}${clean}` : baseDir;
  const parts = joined.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const frag = href.includes('#') ? `#${href.split('#')[1]}` : '';
  return `${out.join('/')}${frag}`;
}

function splitFragment(path: string): { file: string; frag: string | null } {
  const hash = path.indexOf('#');
  if (hash < 0) return { file: path, frag: null };
  return { file: path.slice(0, hash), frag: path.slice(hash + 1) || null };
}

/** Extract readable text from an HTML node: block tags produce paragraphs. */
function htmlToText(root: Document | Element): string {
  const parts: string[] = [];
  let buf = '';
  const flush = () => {
    const t = buf
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
    if (t) parts.push(t);
    buf = '';
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buf += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    if (tag === 'BR' || tag === 'HR') {
      buf += '\n';
      return;
    }
    for (const child of Array.from(el.childNodes)) visit(child);
    if (BLOCK_TAGS.has(tag)) flush();
  };
  visit(root);
  flush();
  return parts.join('\n\n');
}

/**
 * Build a detached container holding the cloned nodes between `startId`
 * (inclusive) and `endId` (exclusive). Anchors are expected to be direct
 * children of the body — the common shape of EPUB chapter files.
 */
function sliceByAnchors(doc: Document, startId: string | null, endId: string | null): Element {
  const root = doc.body ?? doc.documentElement;
  const container = doc.createElement('div');
  let collecting = !startId;
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (startId && el.getAttribute('id') === startId) collecting = true;
      if (endId && el.getAttribute('id') === endId) break;
    }
    if (collecting) container.appendChild(node.cloneNode(true));
  }
  return container;
}

function readOpfArchive(archive: Record<string, Uint8Array>): {
  opfPath: string;
  dir: string;
  doc: Document;
  title: string;
  manifest: Map<string, ManifestItem>;
  spineHrefs: string[];
} {
  const container = archive['META-INF/container.xml'];
  if (!container) throw new Error('This EPUB file has no container.xml.');
  const containerDoc = parseXml(strFromU8(container));
  const rootfile = elementsByLocalName(containerDoc, 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('The EPUB container has no rootfile.');
  const raw = archive[opfPath];
  if (!raw) throw new Error('The EPUB package document is missing.');
  const doc = parseXml(strFromU8(raw));
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const titleEl = elementsByLocalName(doc, 'title')[0];
  const title = titleEl?.textContent?.trim() || 'Imported book';

  const manifest = new Map<string, ManifestItem>();
  for (const item of elementsByLocalName(doc, 'item')) {
    const id = item.getAttribute('id');
    if (!id) continue;
    manifest.set(id, {
      href: item.getAttribute('href') ?? '',
      mediaType: item.getAttribute('media-type') ?? '',
      properties: item.getAttribute('properties') ?? '',
    });
  }

  const spineHrefs: string[] = [];
  for (const ref of elementsByLocalName(doc, 'itemref')) {
    const idref = ref.getAttribute('idref');
    const item = idref ? manifest.get(idref) : undefined;
    if (item) spineHrefs.push(resolveHref(dir, item.href));
  }

  return { opfPath, dir, doc, title, manifest, spineHrefs };
}

/** EPUB3 nav-document entries or EPUB2 NCX navMap entries, in TOC order. */
function findTocEntries(
  archive: Record<string, Uint8Array>,
  dir: string,
  manifest: Map<string, ManifestItem>,
): TocEntry[] {
  const entries: TocEntry[] = [];

  // EPUB3: manifest item with properties="nav".
  for (const item of manifest.values()) {
    if (!item.properties.split(/\s+/).includes('nav')) continue;
    const raw = archive[resolveHref(dir, item.href)];
    if (!raw) continue;
    const navDoc = parseHtml(strFromU8(raw));
    const nav = Array.from(navDoc.querySelectorAll('nav')).find(n => {
      const type = n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type');
      return type?.split(/\s+/).includes('toc');
    });
    if (!nav) continue;
    for (const a of Array.from(nav.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href');
      if (!href) continue;
      entries.push({ heading: (a.textContent ?? '').trim(), href: resolveHref(dir, href) });
    }
    if (entries.length > 0) return entries;
  }

  // EPUB2: NCX file (manifest media-type or .ncx name).
  for (const item of manifest.values()) {
    if (!/ncx$/i.test(item.href) && item.mediaType !== 'application/x-dtbncx+xml') continue;
    const raw = archive[resolveHref(dir, item.href)];
    if (!raw) continue;
    const ncx = parseXml(strFromU8(raw));
    const navMap = elementsByLocalName(ncx, 'navMap')[0];
    if (!navMap) continue;
    for (const child of Array.from(navMap.children)) {
      if (child.localName !== 'navPoint') continue;
      const label = elementsByLocalName(child, 'text')[0]?.textContent?.trim() ?? '';
      const src = elementsByLocalName(child, 'content')[0]?.getAttribute('src');
      if (!src) continue;
      entries.push({ heading: label, href: resolveHref(dir, src) });
    }
    if (entries.length > 0) return entries;
  }

  return entries;
}

function firstHeadingText(doc: Document): string {
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const el = doc.getElementsByTagName(tag)[0];
    const text = (el?.textContent ?? '').trim();
    if (text) return text;
  }
  return '';
}

function buildChapters(
  archive: Record<string, Uint8Array>,
  entries: TocEntry[],
  spineHrefs: string[],
): EpubChapter[] {
  const chapters: EpubChapter[] = [];
  const effective: TocEntry[] = entries.length > 0
    ? entries
    : spineHrefs.map(href => ({ heading: '', href }));

  // Group entries by archive file so fragment slicing within a file works.
  const byFile = new Map<string, TocEntry[]>();
  for (const entry of effective) {
    const { file } = splitFragment(entry.href);
    if (!file) continue;
    const list = byFile.get(file) ?? [];
    list.push(entry);
    byFile.set(file, list);
  }

  let globalIndex = 0;
  for (const [file, group] of byFile) {
    const raw = archive[file];
    if (!raw) continue;
    const doc = parseHtml(strFromU8(raw));
    for (let i = 0; i < group.length; i++) {
      const entry = group[i];
      const { frag } = splitFragment(entry.href);
      const nextFrag = splitFragment(group[i + 1]?.href ?? '').frag;
      const heading = entry.heading
        || (group.length === 1 ? firstHeadingText(doc) : '')
        || (entries.length === 0 ? `Chapter ${globalIndex + 1}` : 'Chapter');
      const content = htmlToText(sliceByAnchors(doc, frag, nextFrag));
      if (content.trim()) chapters.push({ heading, content: content.trim() });
      globalIndex++;
    }
  }
  return chapters;
}

export async function parseEpubBook(file: Blob): Promise<ParsedEpubBook> {
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const { title, dir, manifest, spineHrefs } = readOpfArchive(archive);
  const tocEntries = findTocEntries(archive, dir, manifest);
  const chapters = buildChapters(archive, tocEntries, spineHrefs);
  if (chapters.length === 0) {
    throw new Error('No readable chapters were found in this EPUB.');
  }
  return { title, chapters };
}
