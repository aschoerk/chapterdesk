#!/usr/bin/env node
/**
 * Verify that every relative link / image in the given markdown files points to
 * an existing file. Mirrors what `mkdocs build --strict` rejects as a warning.
 *
 *   node 0scripts/check-doc-links.mjs docs/specs/*.md
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node 0scripts/check-doc-links.mjs <file.md> [...]');
  process.exit(2);
}

let bad = 0;
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const links = [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]);
  for (const link of links) {
    if (/^[a-z]+:\/\//i.test(link) || link.startsWith('#')) continue;
    const target = resolve(dirname(file), link.split('#')[0]);
    try {
      await stat(target);
    } catch {
      bad++;
      console.error(`BROKEN ${file}: ${link} -> ${relative(process.cwd(), target)}`);
    }
  }
}
console.log(bad === 0 ? 'all links ok' : `${bad} broken link(s)`);
process.exit(bad === 0 ? 0 : 1);
