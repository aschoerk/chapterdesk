#!/usr/bin/env node
/**
 * Render every PlantUML file of a directory through the local PlantUML
 * server (default http://localhost:9999/plantuml) into SVG next to it.
 *
 *   node 0scripts/render-puml.mjs docs/specs              # all *.puml
 *   node 0scripts/render-puml.mjs docs/specs/flows/a.puml # one file
 *
 * Env:
 *   PLANTUML_SERVER  server root WITHOUT the /plantuml context
 *                    (default http://localhost:9999)
 *
 * Why the server instead of the CLI: same JAR/version the docs use, and it
 * needs no local java/plantuml install. The encoding below is PlantUML's
 * documented "deflate + 6-bit" URL form. Do NOT prepend `~1`: that marker
 * switches the server to the legacy HUFFMAN decoder and the request fails
 * with "This URL does not look like HUFFMAN data" — plain zlib data is
 * detected automatically.
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { join, extname, dirname, basename, resolve } from 'node:path';

const SERVER = (process.env.PLANTUML_SERVER ?? 'http://localhost:9999').replace(/\/+$/, '');
const CONTEXT = `${SERVER}/plantuml`;

/** PlantUML's custom base64 alphabet (6-bit encoding of the deflated bytes). */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

function encode6bit(b) {
  return ALPHABET[b & 0x3f];
}

/** append3bytes: three bytes -> four chars, per PlantUML's source. */
function append3bytes(b1, b2, b3) {
  const c1 = b1 >> 2;
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
  const c3 = ((b2 & 0xf) << 2) | (b3 >> 6);
  const c4 = b3 & 0x3f;
  return encode6bit(c1) + encode6bit(c2) + encode6bit(c3) + encode6bit(c4);
}

/** Full source -> URL path segment (deflate + 6-bit alphabet). */
export function encodePlantUml(source) {
  const data = deflateRawSync(Buffer.from(source, 'utf8'), { level: 9 });
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += append3bytes(b1, b2, b3);
  }
  return out;
}

async function collect(target) {
  const info = await stat(target);
  if (info.isFile()) return [target];
  const out = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const p = join(target, entry.name);
    if (entry.isDirectory()) out.push(...await collect(p));
    else if (extname(entry.name) === '.puml') out.push(p);
  }
  return out.sort();
}

async function render(file) {
  const source = await readFile(file, 'utf8');
  const url = `${CONTEXT}/svg/${encodePlantUml(source)}`;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok || !body.includes('<svg')) {
    throw new Error(`${file}: server answered ${res.status} — ${body.slice(0, 300)}`);
  }
  const svgPath = resolve(dirname(file), `${basename(file, '.puml')}.svg`);
  await writeFile(svgPath, body, 'utf8');
  return svgPath;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node 0scripts/render-puml.mjs <dir-or-file> [...]');
  process.exit(2);
}

let failed = 0;
for (const target of targets) {
  for (const file of await collect(target)) {
    try {
      const svg = await render(file);
      console.log(`ok   ${file} -> ${svg}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${err.message}`);
    }
  }
}
process.exit(failed === 0 ? 0 : 1);
