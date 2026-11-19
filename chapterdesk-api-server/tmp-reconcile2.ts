import Database from 'better-sqlite3';
const CHAT = 'a3084449-0531-41b7-9bad-909d1df208c2';
const db = new Database(process.env.HOME + '/.config/chapterdesk/data/chapterdesk.sqlite', { readonly: true });
const allRows = db.prepare('SELECT * FROM chat_nodes WHERE chat_id=? ORDER BY position').all(CHAT);
const current = allRows.filter(r => r.is_current === 1 && !r.deleted_at);
const ids = new Set(current.map(r => r.id));
function kids(pid) {
  return current.filter(r => (r.parent_id ?? null) === pid).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
}
const roots = current.filter(r => !r.parent_id || !ids.has(r.parent_id));
console.log('reachable roots (current):', roots.length);
console.log('ALL forks in the CURRENT tree (parent has >1 current child):');
const forkIds = new Set();
for (const r of current) {
  const k = kids(r.id);
  if (k.length > 1) {
    forkIds.add(r.id);
    console.log('  fork', r.id.slice(0, 8), r.role.padEnd(9), '::', (r.content || '').replace(/\n/g, ' ').slice(0, 28));
    for (const c of k) {
      console.log('      -', c.id.slice(0, 8), c.role.padEnd(9), 'leaf=' + (kids(c.id).length === 0), 'exc=' + (c.exclude_from_context ? 1 : 0), '::', (c.content || '').replace(/\n/g, ' ').slice(0, 24));
    }
  }
}
const paths = [];
function walk(n, acc, anc) {
  const na = new Set(anc); na.add(n.id);
  const np = acc.concat([n]);
  const k = kids(n.id);
  if (!k.length) { paths.push(np); return; }
  for (const c of k) walk(c, np, na);
}
for (const r of roots) walk(r, [], new Set());
console.log();
console.log('leaf paths in CURRENT tree:', paths.length);
paths.forEach((p, i) => {
  const l = p[p.length - 1];
  const empty = !(l.content || '').trim();
  console.log('  v' + (i + 1), 'depth=' + p.length, 'leaf=' + l.id.slice(0, 8), l.role, empty ? 'EMPTY' : '', '::', (l.content || '').replace(/\n/g, ' ').slice(0, 28));
});
console.log();
console.log('fork points each of the 8 paths passes through:');
paths.forEach((p, i) => {
  const forks = p.filter(n => forkIds.has(n.id)).map(n => n.id.slice(0, 8));
  console.log('  v' + (i + 1), 'forks:', forks.join(', '));
});