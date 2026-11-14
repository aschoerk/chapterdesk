#!/usr/bin/env node
/**
 * Build `docs/specs/spec-inventory.md`: every spec file with its assignment
 * tree (describe / it titles) plus the component alias used in
 * `docs/specs/component-map.puml`.
 *
 *   node 0scripts/spec-inventory.mjs            # write the file
 *   node 0scripts/spec-inventory.mjs --stdout    # print instead
 *
 * Why parse instead of run: the inventory must be cheap and must work
 * without a browser; it only reads `describe(` / `it(` first arguments
 * (single- or double-quoted) and the nesting level. Dynamic titles
 * (template literals, variables) are shown as `<dynamic>`.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const OUT = join(ROOT, 'docs/specs/spec-inventory.md');
const COMPONENT_MAP = join(ROOT, 'docs/specs/component-map.puml');

/** Where specs live. e2e/ is Playwright, not a unit spec — listed separately. */
const SPEC_ROOTS = ['src', 'chat-server-js', 'chapterdesk-api-server'];
/** Unit-test file suffixes to pick up (Angular/jest/Vitest). */
const SPEC_SUFFIXES = ['.spec.ts', '.test.ts', '.test.js'];

/**
 * Component alias per spec path prefix. FIRST match wins, so keep specific
 * files above their folder. Every alias must exist in component-map.puml
 * (the generator flags unknown ones with a ⚠).
 */
const ALIASES = [
  // --- LLM orchestration -------------------------------------------------
  ['src/app/core/llm/orchestration/flows.spec.ts', 'ORCH_RUNNER'],
  ['src/app/core/llm/orchestration/append.spec.ts', 'ORCH_RUNNER'],
  ['src/app/core/llm/orchestration/orchestration.spec.ts', 'ORCH_CORE'],
  ['src/app/core/llm/chapter-plan.spec.ts', 'LEAF_PLAN'],
  ['src/app/core/llm/usage.spec.ts', 'LEAF_USAGE'],
  ['src/app/core/llm/llm-log.service.spec.ts', 'LEAF_LOG'],
  ['src/app/core/llm/llm-log-resend.service.spec.ts', 'LEAF_LOG'],
  ['src/app/core/llm/llm-message.spec.ts', 'LEAF_MSG'],
  ['src/app/core/llm/llm-sse.spec.ts', 'LEAF_SSE'],
  ['src/app/core/llm/llm-context.spec.ts', 'LEAF_CTX'],
  ['src/app/core/llm/stream-reveal.spec.ts', 'LEAF_REVEAL'],
  ['src/app/core/llm/reveal-queue.spec.ts', 'LEAF_REVEAL'],
  ['src/app/core/llm/held-answer-stream.spec.ts', 'LEAF_REVEAL'],
  ['src/app/core/llm/paced-read.service.spec.ts', 'LEAF_PACE'],
  ['src/app/core/llm/reading-time.spec.ts', 'LEAF_PACE'],
  ['src/app/core/llm/', 'LEAF'],

  // --- chat domain -------------------------------------------------------
  ['src/app/core/chat/chat-usage.service.spec.ts', 'SVC_USAGE'],
  ['src/app/core/chat/chat-images.service.spec.ts', 'SVC_IMAGES'],
  ['src/app/core/chat/reading-marks.service.spec.ts', 'SVC_MARKS'],
  ['src/app/core/chat/chat-nav-selection.service.spec.ts', 'SVC_NAVSEL'],
  ['src/app/core/chat/chat-nav-menu.service.spec.ts', 'SVC_NAVMENU'],
  ['src/app/core/chat/chat-view-prefs.spec.ts', 'SVC_VIEWPREFS'],
  ['src/app/core/chat/chat-editing.spec.ts', 'SVC_EDIT'],
  ['src/app/core/chat/node-edit-session.spec.ts', 'SVC_EDIT'],
  ['src/app/core/chat/', 'SVC_CHAT'],

  // --- clipboard ---------------------------------------------------------
  ['src/app/core/clipboard/attachment-clipboard', 'CLIP_ATT'],
  ['src/app/core/clipboard/story-clipboard', 'CLIP_STORY'],
  ['src/app/core/clipboard/', 'CLIP_NODE'],

  // --- settings / prompts / config --------------------------------------
  ['src/app/core/settings/generation-settings', 'SET_GEN'],
  ['src/app/core/settings/sort-preferences', 'SET_SORT'],
  ['src/app/core/settings/', 'SET_MAIN'],
  ['src/app/core/prompts/', 'PR_DEFAULTS'],

  // --- import / export ---------------------------------------------------
  ['src/app/core/import-export/docx-export', 'IO_DOCX_OUT'],
  ['src/app/core/import-export/docx-import', 'IO_DOCX_IN'],
  ['src/app/core/import-export/epub-import', 'IO_EPUB'],
  ['src/app/core/import-export/', 'IO_BUNDLE'],

  // --- cross-cutting -----------------------------------------------------
  ['src/app/core/dialogs/', 'SVC_DIALOGS'],
  ['src/app/core/search-replace/', 'SEARCH_SVC'],
  ['src/app/core/names/', 'NAMES'],
  ['src/app/core/i18n/', 'I18N'],
  ['src/app/core/toast/', 'TOAST'],
  ['src/app/core/demo-data/', 'DEMO'],
  ['src/app/core/util/helpers', 'UTIL'],
  ['src/app/core/util/mark-fragment', 'UTIL'],
  ['src/app/core/util/download', 'UTIL'],
  ['src/app/core/util/', 'UTIL_RUNTIME'],

  // --- data access -------------------------------------------------------
  ['src/app/api/idb-chat-api', 'IDB'],
  ['src/app/api/chat-api.service', 'HTTP'],
  ['src/app/api/', 'PORT'],

  // --- components --------------------------------------------------------
  ['src/app/components/chat-node/context-menu', 'CMP_NODE_PARTS'],
  ['src/app/components/chat-node/attachments', 'CMP_NODE_PARTS'],
  ['src/app/components/chat-node/editor-scroll', 'CMP_NODE_PARTS'],
  ['src/app/components/chat-node/node-action-state', 'CMP_NODE_ACTIONS'],
  ['src/app/components/chat-node/editor-controller', 'CMP_NODE_ACTIONS'],
  ['src/app/components/chat-node/send-controller', 'CMP_NODE_ACTIONS'],
  ['src/app/components/chat-node/dialog-actions', 'CMP_NODE_ACTIONS'],
  ['src/app/components/chat-node/illustration-controller', 'CMP_NODE_ACTIONS'],
  ['src/app/components/chat-node/', 'CMP_NODE'],
  ['src/app/components/text-version-panel/', 'CMP_VERSIONS'],
  ['src/app/components/node-version-diff-dialog/', 'CMP_VERSIONS'],
  ['src/app/components/search-replace/', 'CMP_SEARCH'],
  ['src/app/components/chat-title-editor/', 'CMP_EDITORS'],
  ['src/app/components/chat-parameters-editor/', 'CMP_EDITORS'],
  ['src/app/components/rewrite-dialog/', 'DLG_TEXT'],
  ['src/app/components/prepend-dialog/', 'DLG_TEXT'],
  ['src/app/components/resend-dialog/', 'DLG_TEXT'],
  ['src/app/components/mark-note-dialog/', 'DLG_TEXT'],
  ['src/app/components/name-replace-dialog/', 'DLG_TEXT'],
  ['src/app/components/chapter-descriptions-dialog/', 'DLG_TEXT'],
  ['src/app/components/illustrate-dialog/', 'DLG_IMAGE'],
  ['src/app/components/create-image-dialog/', 'DLG_IMAGE'],
  ['src/app/components/chat-image-picker/', 'DLG_IMAGE'],
  ['src/app/components/image-lightbox/', 'DLG_IMAGE'],
  ['src/app/components/setup-wizard/', 'DLG_SYS'],
  ['src/app/components/confirm-dialog/', 'DLG_SYS'],
  ['src/app/components/', 'CMP_CHROME'],

  // --- pages -------------------------------------------------------------
  ['src/app/pages/chat/chat.component.spec.ts', 'PAGE_CHAT'],
  ['src/app/pages/chat-reader/', 'PAGE_READER'],
  ['src/app/pages/config/', 'PAGE_CONFIG'],
  ['src/app/pages/logs/', 'PAGE_LOGS'],
  ['src/app/pages/personas/', 'PAGE_PERSONAS'],
  ['src/app/pages/projects/', 'PAGE_PROJECTS'],
  ['src/app/pages/topics/', 'PAGE_TOPICS'],
  ['src/app/pages/import/', 'PAGE_IMPORT'],
  ['src/app/pages/', 'PAGES'],
  ['src/app/app.spec.ts', 'APP'],

  // --- backend -----------------------------------------------------------
  ['chapterdesk-api-server/', 'SERVER'],
  ['chat-server-js/', 'PROXY']
];

/** Aliases declared in the .puml (components AND packages) — flags stale entries. */
async function declaredAliases() {
  try {
    const puml = await readFile(COMPONENT_MAP, 'utf8');
    return new Set([...puml.matchAll(/\bas\s+([A-Z][A-Z0-9_]+)\b/gm)].map(m => m[1]));
  } catch {
    return new Set();
  }
}

function aliasFor(path) {
  for (const [prefix, alias] of ALIASES) {
    if (path === prefix || path.startsWith(prefix)) return alias;
  }
  if (path.startsWith('test-helpers/')) return 'HELPERS';
  return '—';
}

const TITLE = /^\s*(describe|it|test)(?:\.(?:each|skip|only|todo))?\s*\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/;

/**
 * Never walked: build output + installed deps.
 * Runtime folders (`data/`, `logs/`) are only skipped where they really hold
 * runtime state — the repo root and the two server packages. `pages/logs`
 * is source code and must be scanned.
 */
const SKIP_NAMES = new Set(['node_modules', 'dist', 'coverage', '.git']);
const RUNTIME_DIRS = new Set(['data', 'logs']);
const RUNTIME_PARENTS = new Set(['', 'chat-server-js', 'chapterdesk-api-server']);

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const parent = relative(ROOT, dir).split(sep).join('/');
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue;
    if (RUNTIME_DIRS.has(e.name) && RUNTIME_PARENTS.has(parent)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (SPEC_SUFFIXES.some(s => e.name.endsWith(s))) out.push(p);
  }
  return out;
}

function parseAssignments(source) {
  const rows = [];
  let depth = 0;
  for (const line of source.split('\n')) {
    const m = TITLE.exec(line);
    if (m) {
      const kind = m[1];
      const raw = m[2] ?? m[3] ?? m[4];
      const title = raw === undefined ? '<dynamic>' : raw.replace(/\\'/g, "'").replace(/\\"/g, '"');
      rows.push({ kind, depth, title });
    }
    // crude but stable: count braces to keep the nesting level readable
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return rows;
}

const files = [];
for (const root of SPEC_ROOTS) files.push(...await walk(join(ROOT, root)));
files.sort();

const known = await declaredAliases();
const groups = new Map(); // alias -> [{ path, rows }]
let totalIt = 0;

for (const file of files) {
  const path = relative(ROOT, file).split(sep).join('/');
  const rows = parseAssignments(await readFile(file, 'utf8'));
  const alias = aliasFor(path);
  if (!groups.has(alias)) groups.set(alias, []);
  groups.get(alias).push({ path, rows });
  totalIt += rows.filter(r => r.kind !== 'describe').length;
}

const order = [...groups.keys()].sort((a, b) => a.localeCompare(b));
const lines = [];
lines.push('# Spec inventory — assignments per component');
lines.push('');
lines.push('Generated by `node 0scripts/spec-inventory.mjs` — do not edit by hand.');
lines.push('Regenerate after adding/renaming a `describe` or `it` block.');
lines.push('');
lines.push(`* spec files: **${files.length}**`);
lines.push(`* test cases (\`it\`/\`test\`): **${totalIt}**`);
lines.push('');
lines.push('The **Component** column is the alias from `component-map.puml`, so an');
lines.push('assignment can be read together with the diagram. `—` means the');
lines.push('file is not mapped (add a prefix to `ALIASES` in the generator).');
lines.push('');
lines.push('| Component | Spec | Groups | Cases |');
lines.push('|---|---|---|---|');
for (const alias of order) {
  for (const { path, rows } of groups.get(alias)) {
    const groupsCount = rows.filter(r => r.kind === 'describe').length;
    const cases = rows.filter(r => r.kind !== 'describe').length;
    lines.push(`| ${alias}${known.size && !known.has(alias) && alias !== '—' ? ' ⚠' : ''} | \`${path}\` | ${groupsCount} | ${cases} |`);
  }
}
lines.push('');
for (const alias of order) {
  lines.push(`## ${alias}`);
  lines.push('');
  for (const { path, rows } of groups.get(alias)) {
    lines.push(`### \`${path}\``);
    lines.push('');
    for (const row of rows) {
      const indent = '  '.repeat(Math.min(row.depth, 3));
      const marker = row.kind === 'describe' ? '**' : '';
      const suffix = row.kind === 'describe' ? '**' : '';
      lines.push(`${indent}- ${marker}${row.title}${suffix}`);
    }
    lines.push('');
  }
}

const text = lines.join('\n');
if (process.argv.includes('--stdout')) {
  process.stdout.write(text);
} else {
  await writeFile(OUT, text, 'utf8');
  console.log(`wrote ${relative(ROOT, OUT)} (${files.length} spec files, ${totalIt} cases)`);
}
