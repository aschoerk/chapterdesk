// ---------------------------------------------------------------------------
// Merge Angular unit-test coverage (istanbul JSON) with Playwright e2e V8
// coverage harvested by e2e/support/coverage.ts.
//
//   node 0scripts/merge-coverage.mjs [--threshold statements=70,lines=75]
//
// Reads:
//   - coverage/chat/coverage-final.json     (unit, emitted by ng test)
//   - .e2e-coverage-raw/*.json             (raw V8, emitted by the e2e fixture)
// Writes a merged istanbul report to coverage/merged/ (text + html + json).
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const V8ToIstanbul = (await import('v8-to-istanbul')).default;
const libCoverage = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const ROOT = process.cwd();
const UNIT_JSON = join(ROOT, 'coverage', 'chat', 'coverage-final.json');
const RAW_DIR = join(ROOT, '.e2e-coverage-raw');
const OUT_DIR = join(ROOT, 'coverage', 'merged');

// -- parse thresholds (optional) -------------------------------------------
const THRESHOLDS = { statements: 0, branches: 0, functions: 0, lines: 0 };
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--threshold=')) continue;
  for (const pair of arg.slice('--threshold='.length).split(',')) {
    const [key, value] = pair.split('=');
    if (key in THRESHOLDS) THRESHOLDS[key] = Number(value);
  }
}

const map = libCoverage.createCoverageMap();

// -- 1. unit coverage -------------------------------------------------------
if (fileExists(UNIT_JSON)) {
  const unit = JSON.parse(readFileSync(UNIT_JSON, 'utf8'));
  map.merge(unit);
  console.log(`unit: ${Object.keys(unit).length} files from ${UNIT_JSON}`);
} else {
  console.warn(`⚠  no unit coverage at ${UNIT_JSON} — run "ng test --watch=false" first`);
}

// -- 2. e2e raw V8 coverage -------------------------------------------------
// Each raw file is one Playwright test: [{ url, source, functions, map }].
// The Angular map keys app files as `src/app/...` (project-root relative) and
// framework files as `node_modules/...` / build-internal paths.
//
// IMPORTANT — the honest merge is a SUPERSET, not a per-file union:
// unit coverage (vitest, TEST build) and e2e coverage (prod build, converted
// with v8-to-istanbul) use DIFFERENT statement models for the SAME source
// file, so merging their statement maps would double-count and inflate totals.
// Therefore:
//   - files already in the UNIT map → keep the unit coverage (unit is far more
//     exhaustive per file);
//   - files absent from the unit map (main.ts, app.config.ts, page routes,
//     avatar-picker, …) → ADD the e2e coverage, closing the "0%" gap that the
//     unit-only denominator never even counted.
let e2eSeenUnique = new Set();
let e2eAdded = 0;
function normalizeAppPath(p) {
  if (!p) return null;
  const clean = String(p).replace(/\\/g, '/');
  if (clean.startsWith('src/app/') || clean.includes('/src/app/')) {
    const base = clean.slice(clean.indexOf('src/app/'));
    return join(ROOT, base);
  }
  return null; // skip node_modules / framework internals / package.json
}
if (dirExists(RAW_DIR)) {
  for (const f of readdirSync(RAW_DIR)) {
    if (!f.endsWith('.json')) continue;
    const entries = JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8'));
    for (const entry of entries) {
      if (!entry.map) continue; // can't map a minified bundle without a sourcemap
      const converter = new V8ToIstanbul(entry.url, 0, {
        source: entry.source,
        sourceMap: { sourcemap: entry.map },
      });
      await converter.load();
      converter.applyCoverage(entry.functions);
      const istanbul = converter.toIstanbul();
      for (const [filePath, fc] of Object.entries(istanbul)) {
        const abs = normalizeAppPath(filePath ?? fc.path);
        if (!abs) continue;
        e2eSeenUnique.add(abs);
        if (map.files().includes(abs)) continue; // unit already covers it — keep unit
        const data = fc.data ?? fc;
        data.path = abs;
        map.addFileCoverage(data);
        e2eAdded += 1;
      }
    }
  }
} else {
  console.warn(`⚠  no e2e raw coverage at ${RAW_DIR} — run with E2E_COVERAGE=1 first`);
}
console.log(
  `e2e: ${e2eSeenUnique.size} unique src/app files touched by e2e; added ${e2eAdded} that unit tests never load`,
);

// -- 3. report --------------------------------------------------------------
if (map.files().length > 0) {
  const total = map.getCoverageSummary();
  const pct = (m) => (m ? m.pct : 0);
  console.log('--- merged (unit + e2e) ---');
  console.log(
    `statements ${pct(total.statements).toFixed(2)}% · branches ${pct(total.branches).toFixed(2)}% · ` +
      `functions ${pct(total.functions).toFixed(2)}% · lines ${pct(total.lines).toFixed(2)}%`,
  );

  mkdirSync(OUT_DIR, { recursive: true });
  const context = libReport.createContext({ dir: OUT_DIR, coverageMap: map, watermarks: libReport.getDefaultWatermarks?.() });
  for (const [name, opts] of [
    ['text', { skipFull: false }],
    ['json-summary', {}],
    ['html', { skipEmpty: false }],
  ]) {
    const report = reports.create(name, opts);
    report.execute(context);
  }
  console.log(`report written to ${OUT_DIR}`);

  // -- 4. thresholds (optional) ------------------------------------------------
  let failures = 0;
  for (const key of Object.keys(THRESHOLDS)) {
    if (!THRESHOLDS[key]) continue;
    const actual = pct(total[key]);
    if (actual < THRESHOLDS[key]) {
      failures += 1;
      console.error(`✘ ${key}: ${actual.toFixed(2)}% < ${THRESHOLDS[key]}%`);
    } else {
      console.log(`✔ ${key}: ${actual.toFixed(2)}% ≥ ${THRESHOLDS[key]}%`);
    }
  }
  if (failures) process.exit(1);
} else {
  console.warn('no coverage data to report — nothing merged');
}

function fileExists(p) {
  try {
    return readFileSync(p).length > 0;
  } catch {
    return false;
  }
}
function dirExists(p) {
  try {
    return readdirSync(p).length >= 0;
  } catch {
    return false;
  }
}
