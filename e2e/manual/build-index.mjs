// ---------------------------------------------------------------------------
// Build docs/manuals/index.md — a table of contents of all generated manual
// chapters. Run after `npm run docs:manual`:  node e2e/manual/build-index.mjs
// ---------------------------------------------------------------------------

import { generateIndex } from 'playwright-scenario-recorder';

generateIndex({
  dir: './docs/manuals',
  locale: 'en',
});

console.log('Generated docs/manuals/index.md');