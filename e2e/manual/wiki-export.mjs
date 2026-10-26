#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Export the generated user-manual (docs/manuals) into the GitHub WIKI.
//
// GitHub wiki repositories are separate git repos at
//     git@github.com:<owner>/<repo>.wiki.git   (or https://github.com/<owner>/<repo>.wiki)
// Pages are Markdown files in the repo root (Home.md is the landing page);
// images must live IN the wiki repo (commit them) — remote URLs break.
//
// This script:
//   1. reads docs/manuals/*.md + screenshots (must be generated first:
//      `npm run docs:manual:full`),
//   2. clones (or fetches) the wiki repo into a staging area,
//   3. copies each manual chapter to a wiki page (kebab-case name + .md),
//      remapping the local screenshot paths to the wiki's committed files,
//   4. writes a Home.md index that links every page,
//   5. commits + pushes.
//
// Usage:
//   node e2e/manual/wiki-export.mjs            # default remote guess from git
//   node e2e/manual/wiki-export.mjs --dry-run  # build pages locally, do NOT push
//   WIKI_REMOTE=git@github.com:me/chapterdesk.wiki.git node e2e/manual/wiki-export.mjs
//
// Prereqs: docs/manuals exists, `git` available, wiki repo access (HTTPS token
// or SSH key). The default remote is derived from `git remote get-url origin`
// (the local origin is normalized so the legacy `chapterly` name maps to the
// current `chapterdesk` repo).
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = process.cwd();
const MANUALS = join(ROOT, 'docs', 'manuals');
const WIKI_STAGE = join(ROOT, '.wiki-stage');

/** The repo was renamed chapterly → chapterdesk on GitHub; local clones may
 *  still carry the old name in their `origin` remote (GitHub redirects it, but
 *  the canonical name is chapterdesk). */
const LEGACY_REPO_NAMES = ['chapterly'];

/** The wiki web URL for a wiki git remote (e.g. …/chapterdesk.wiki.git). */
function wikiWebUrl(remote) {
  // git@github.com:owner/repo.wiki.git  |  https://github.com/owner/repo.wiki.git
  const m = remote.match(/([^/:]+)\/([^/]+?)(?:\.wiki)?\.git$/);
  if (m) return `https://github.com/${m[1]}/${m[2]}/wiki`;
  return remote.replace(/\.git$/, '').replace(/\.wiki\/?$/, '/wiki');
}

/** Derive the wiki remote from the project's origin remote. */
function detectWikiRemote() {
  if (process.env.WIKI_REMOTE) return process.env.WIKI_REMOTE;
  let origin = '';
  try {
    origin = execSync('git remote get-url origin', { cwd: ROOT }).toString().trim();
  } catch {
    /* no origin */
  }
  if (!origin) {
    throw new Error(
      'Could not detect the API remote. Set WIKI_REMOTE (e.g. git@github.com:you/chapterdesk.wiki.git) or add a remote named "origin".',
    );
  }
  // Normalize the legacy (renamed) repo name so a stale origin still resolves.
  // Both git URL forms end with `/<owner>/<repo>.git`, so match the final
  // `/chapterly` path segment: github.com/owner/chapterly.git  |  git@github.com:owner/chapterly.git
  for (const legacy of LEGACY_REPO_NAMES) {
    origin = origin.replace(new RegExp(`/${legacy}(\\.git)?$`), `/chapterdesk$1`);
  }
  // https://github.com/owner/repo.git -> https://github.com/owner/repo.wiki.git
  if (origin.endsWith('.git')) origin = origin.slice(0, -'.git'.length);
  // ssh form git@github.com:owner/repo.git handled by the same replace on the path
  if (origin.includes('github.com/')) {
    return origin.replace('github.com/', 'github.com/').concat('.wiki.git');
  }
  // git@github.com:owner/repo -> git@github.com:owner/repo.wiki
  if (origin.includes('git@')) {
    return origin.concat('.wiki.git');
  }
  throw new Error(`Unrecognized origin remote: ${origin}`);
}

function sh(cmd, cwd = ROOT) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

/** Sanitize a chapter filename (`manual-trash.spec` source → wiki slug). */
function pageSlug(fileBase) {
  return fileBase.replace(/^manual-/, '');
}

/** Fetch or (re)create the local wiki clone. */
function ensureWikiClone(remote) {
  if (existsSync(WIKI_STAGE)) {
    rmSync(WIKI_STAGE, { recursive: true, force: true });
  }
  mkdirSync(WIKI_STAGE, { recursive: true });
  try {
    sh(`git clone ${remote} .`, WIKI_STAGE);
  } catch (err) {
    throw new Error(
      `Could not clone the wiki at ${remote}. Create it first (GitHub → repository → Wiki → Create the first page), or check credentials.\n${err}`,
    );
  }
}

/** Copy a manual into wiki pages. Returns [{title, slug, steps}]. */
function buildPages() {
  const mdFiles = readdirSync(MANUALS)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .sort();

  const pages = [];
  for (const file of mdFiles) {
    const src = join(MANUALS, file);
    const text = readFileSync(src, 'utf8');

    // Extract the first "# " heading as the page title.
    const titleMatch = text.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, '');

    // Remap relative screenshot links to wiki-relative "screenshots/…" paths.
    // The markdown embeds `./screenshots/<scenario>/step-0N.png`.
    const slug = pageSlug(file.replace(/\.md$/, ''));
    const wikified = text.replace(
      /!\[([^\]]*)\]\(\.\/screenshots\/([^)]+)\)/g,
      (_, alt, rel) => `![${alt}](./screenshots/${rel})`,
    );

    pages.push({ title, slug, source: file, text: wikified });

    // Copy the chapter's screenshots into the wiki staging dir.
    const scenarioDir = file.replace(/\.md$/, '');
    const srcShots = join(MANUALS, 'screenshots', scenarioDir);
    if (existsSync(srcShots)) {
      const destShots = join(WIKI_STAGE, 'screenshots', scenarioDir);
      mkdirSync(destShots, { recursive: true });
      for (const png of readdirSync(srcShots).filter((f) => f.endsWith('.png'))) {
        copyFileSync(join(srcShots, png), join(destShots, png));
      }
    }
  }
  return pages;
}

/** Write Home.md — the wiki landing page with a link to every manual chapter. */
function writeHome(pages) {
  const lines = [
    '# ChapterDesk User Manual',
    '',
    '> Auto-generated from the Playwright E2E manual scenarios (see `e2e/manual`).',
    '',
  ];
  for (const p of pages) {
    lines.push(`- [${p.title}](${encodeURIComponent(p.slug)})`);
  }
  lines.push('');
  writeFileSync(join(WIKI_STAGE, 'Home.md'), lines.join('\n'));
}

function main() {
  if (!existsSync(MANUALS)) {
    throw new Error(`No manual found at ${MANUALS}. Run \`npm run docs:manual:full\` first.`);
  }
  const remote = detectWikiRemote();
  console.log(`Wiki remote: ${remote}`);
  console.log(`Wiki URL:    ${wikiWebUrl(remote)}`);

  if (!DRY_RUN) {
    ensureWikiClone(remote);
    // Reset the wiki to upstream state so removed manual chapters vanish too.
    sh('git fetch origin 2>/dev/null; git reset --hard origin/master 2>/dev/null || git reset --hard origin/main 2>/dev/null || true', WIKI_STAGE);
  } else {
    // Dry run: build the pages straight into the staging area for inspection.
    mkdirSync(WIKI_STAGE, { recursive: true });
    for (const dir of ['screenshots']) {
      rmSync(join(WIKI_STAGE, dir), { recursive: true, force: true });
    }
  }

  const pages = buildPages();
  if (!pages.length) throw new Error('No manual chapters found.');

  writeHome(pages);

  for (const p of pages) {
    writeFileSync(join(WIKI_STAGE, `${p.slug}.md`), p.text);
    console.log(`  page: ${p.slug}.md  (${p.source})`);
  }

  if (DRY_RUN) {
    console.log(`Dry run complete. Staged ${pages.length} pages in ${WIKI_STAGE} (not pushed).`);
    return;
  }

  // Commit + push.
  sh('git add -A', WIKI_STAGE);
  const changed = execSync('git status --porcelain', { cwd: WIKI_STAGE }).toString().trim();
  if (!changed) {
    console.log('No changes to the wiki — nothing to push.');
    return;
  }
  sh(`git commit -m "Update user manual (${new Date().toISOString().slice(0, 10)})"`, WIKI_STAGE);
  sh('git push origin master 2>/dev/null || git push origin main 2>/dev/null || git push', WIKI_STAGE);
  console.log(`Pushed ${pages.length} pages + ${changed.split('\n').length} files to the wiki.`);
  console.log(`Wiki: ${wikiWebUrl(remote)}`);
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}