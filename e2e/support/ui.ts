// ---------------------------------------------------------------------------
// ui.ts — re-export barrel.
//
// Keep the single `../support/ui` import for specs, but the implementation now
// lives in focused modules:
//   ./sidebar    – sidebar + app bootstrap
//   ./chat       – chat-page, node/tree, editor + toolbar helpers
//   ./illustrate – Illustrate + create-image dialogs (imports ./chat)
//   ./forms      – shared modal / confirm / navigation / uniqueName
//   ./topics     – topic CRUD (imports ./forms)
//   ./projects   – environment (project) CRUD + topic membership (./forms)
//   ./personas   – persona CRUD (imports ./forms)
//   ./config     – /config/* settings pages (appearance, providers, tasks,
//                  prompts) helpers (imports ./forms; provider-catalog mock)
//   ./reader     – read-only navigation (/read) helpers (standalone)
// ---------------------------------------------------------------------------

export * from './sidebar';
export * from './chat';
export * from './illustrate';
export * from './forms';
export * from './topics';
export * from './projects';
export * from './personas';
export * from './config';
export * from './reader';
