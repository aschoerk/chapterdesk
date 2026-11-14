#!/usr/bin/env node
/**
 * One-off refactor helper: delete top-level class members by name from a TS
 * file, using the TypeScript AST (robust against braces inside strings,
 * template literals, regex literals and comments).
 *
 * Usage: node 0scripts/ts-remove-members.mjs <file> <MemberName> [<MemberName> ...]
 *
 * The previous hand-rolled brace counter silently cut the wrong ranges and
 * mangled the file — always use the parser for bulk removals.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

const [, , file, ...names] = process.argv;
if (!file || names.length === 0) {
  console.error('usage: node 0scripts/ts-remove-members.mjs <file> <Member> [...]');
  process.exit(1);
}

const text = readFileSync(file, 'utf8');
const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Collect the class declaration(s) members by name. */
const targets = [];
const visit = node => {
  if (ts.isClassDeclaration(node)) {
    for (const member of node.members) {
      const name = member.name?.getText?.(sf);
      if (name && names.includes(name)) targets.push(member);
    }
  }
  ts.forEachChild(node, visit);
};
visit(sf);

const missing = names.filter(n => !targets.some(t => t.name.getText(sf) === n));
if (missing.length) {
  console.error(`not found: ${missing.join(', ')}`);
  process.exit(1);
}

// Remove from the END so earlier offsets stay valid. `getFullStart()` includes
// the leading comments/whitespace of the member.
const spans = targets
  .map(m => [m.getFullStart(), m.getEnd()])
  .sort((a, b) => b[0] - a[0]);

let out = text;
for (const [start, end] of spans) {
  // Swallow the newline(s) that followed the member.
  let stop = end;
  while (stop < out.length && (out[stop] === '\n' || out[stop] === '\r')) stop++;
  out = out.slice(0, start) + out.slice(stop);
  const removed = text.slice(start, end).split('\n').length;
  console.log(`removed lines ${text.slice(0, start).split('\n').length}..+${removed}`);
}

writeFileSync(file, out, 'utf8');
console.log('done');
