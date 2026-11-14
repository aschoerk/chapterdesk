#!/usr/bin/env node
/**
 * File-size guard for the two chat "presenter" files.
 *
 * `ChatComponent` and `ChatNodeComponent` are the biggest UI files in the
 * project. They are large because the interaction surface is large, not
 * because domain logic lives there — see `docs/architecture/chat-ui.md`. The
 * budgets below are a ratchet: they sit just above the CURRENT size, so a new
 * feature cannot quietly grow the files again. When an extraction lowers the
 * real size, lower the budget in the same commit.
 *
 * Usage: node 0scripts/check-file-size.mjs        (exit 1 when over budget)
 */
import { readFileSync } from 'node:fs';

/** file → max lines (current size + a little headroom). */
const BUDGETS = {
  'src/app/components/chat-node/chat-node.component.ts': 2650,
  'src/app/components/chat-node/chat-node.component.html': 950,
  'src/app/components/chat-node/chat-node.component.css': 1100,
  'src/app/pages/chat/chat.component.ts': 2250,
  'src/app/pages/chat/chat.component.html': 780,
  'src/app/pages/chat/chat.component.css': 1220,
};

let failed = false;
for (const [file, max] of Object.entries(BUDGETS)) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n').length - 1;
  } catch {
    console.error(`✗ ${file}: not found (update BUDGETS in 0scripts/check-file-size.mjs)`);
    failed = true;
    continue;
  }
  const over = lines - max;
  if (over > 0) {
    console.error(`✗ ${file}: ${lines} lines (budget ${max}, over by ${over})`);
    failed = true;
  } else {
    console.log(`✓ ${file}: ${lines}/${max}`);
  }
}

if (failed) {
  console.error(
    '\nA chat presenter file grew past its budget. Extract a helper/service '
    + 'instead of adding lines (see docs/architecture/chat-ui.md).',
  );
  process.exit(1);
}
