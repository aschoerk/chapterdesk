import { describe, expect, test } from 'vitest';
import { SqlitePersistence } from '../src/persistence/sqlite/sqlite-persistence.js';

/**
 * `migrateChatNodeLoreRole` — legacy chat-lore nodes were stored as
 * `role = 'user'` with the canon/plan markers in the content; init() must
 * give them the dedicated `lore` role. Idempotent and scoped to marker nodes.
 */
describe('lore role migration', () => {
  /** Recreate the chat_nodes table exactly as init() does, seed legacy rows,
   *  then run init() so the migration sees them. */
  function seedLegacyAndInit(): Promise<SqlitePersistence> {
    const store = new SqlitePersistence(':memory:');
    store.db.exec(`
      CREATE TABLE chat_nodes (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, thinking TEXT, model_id TEXT, provider_id TEXT, version INTEGER NOT NULL DEFAULT 1, previous_version_id TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, total_tokens INTEGER, total_cost REAL, attachments TEXT DEFAULT '[]', is_current INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT, chat_parameters_id TEXT, exclude_from_context INTEGER DEFAULT 0, exclude_after_send INTEGER DEFAULT 0);
      INSERT INTO chat_nodes (id, chat_id, parent_id, role, content, version, is_current, created_at) VALUES
        ('lore1', 'c1', NULL, 'user', '[Current chat-lore — fixed canon that must be respected and never contradicted]\nAshley is married.\n[/End of chat-lore]', 1, 1, '2026-01-01T00:00:00Z'),
        ('plan1', 'c1', NULL, 'user', '[Chapter plan for this chapter — fixed canon that must be respected]\n1. The Gate.\n[/End of chapter plan]', 1, 1, '2026-01-01T00:00:00Z'),
        ('dir1', 'c1', NULL, 'user', 'Describe the ring.', 1, 1, '2026-01-01T00:00:00Z'),
        ('ans1', 'c1', NULL, 'assistant', 'The ring glints.', 1, 1, '2026-01-01T00:00:00Z');
    `);
    return store.init().then(() => store);
  }

  test('migrates marker-bearing user nodes to role=lore, leaves others alone', async () => {
    const store = await seedLegacyAndInit();
    const rows = store.rows('SELECT id, role FROM chat_nodes ORDER BY id') as { id: string; role: string }[];
    const byId = new Map(rows.map(r => [r.id, r.role]));
    expect(byId.get('lore1')).toBe('lore');
    expect(byId.get('plan1')).toBe('lore');
    expect(byId.get('dir1')).toBe('user');
    expect(byId.get('ans1')).toBe('assistant');
    await store.close();
  });

  test('is idempotent — a second init leaves the roles unchanged', async () => {
    const store = await seedLegacyAndInit();
    await store.init();
    const rows = store.rows('SELECT id, role FROM chat_nodes ORDER BY id') as { id: string; role: string }[];
    const byId = new Map(rows.map(r => [r.id, r.role]));
    expect(byId.get('lore1')).toBe('lore');
    expect(byId.get('dir1')).toBe('user');
    await store.close();
  });

  test('versionNode allows editing a lore node as a user (editUser path)', async () => {
    const store = await seedLegacyAndInit();
    // The migration ran; a lore node is now role 'lore' and must be
    // user-versionable (the client edits lore in place via editUser).
    const updated = await store.editUser('c1', 'lore1', 'Ashley is now the keeper.', undefined);
    expect(updated.role).toBe('lore');
    expect(updated.content).toBe('Ashley is now the keeper.');
    await store.close();
  });
});