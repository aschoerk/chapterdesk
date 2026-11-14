# Chat UI — component map

Orientation page for the two biggest UI files. Read this before touching
`chat.component.*` or `chat-node.component.*`: it says **which part owns what**
and where the seams are, so a change starts in the right file instead of the
biggest one.

## Why these files are large (and why that is not a design flaw)

`ChatComponent` and `ChatNodeComponent` are **presenters** for one densely
interactive DOM region each. They do almost no domain work: chat mutation lives
in `ChatService` (`core/chat/chat-tree-*`, `chat-lore`, `chat-operation`), every
LLM call lives in `core/llm/orchestration`, and every modal lives in a
`core/dialogs/*` service. The files are big because the *interaction surface* is
big — editor, streaming, menus, attachments, marks, search — not because logic
was dumped there.

The size still costs reviewability and test selectivity. The answer is therefore
**seams, not a rewrite**: domain-free helpers are pulled into plain modules,
per-instance state into component-scoped services, and bulky action sequences
into controllers. The component keeps thin delegating members so templates and
the existing specs stay valid.

## `ChatNodeComponent` — one card in the conversation

`src/app/components/chat-node/`

| Part | Owns | File |
|---|---|---|
| `ChatNodeComponent` | The DOM: which of read / edit / streaming is shown; `viewChild` refs; scroll + caret continuity; every button's click target. Re-exports the controllers' signals and keeps one-line delegating members, so the template and the specs address the card unchanged | `chat-node.component.ts` / `.html` / `.css` |
| `NodeActionState` | "One action at a time": `loading` + the *kind* of action (`send`, `image`, `version`, …) driving every busy label | `node-action-state.ts` |
| `IllustrationController` | Illustrate / adapt-and-re-render / delete a prompt record; prompt-record attachment helpers; storyboard progress | `illustration-controller.ts` |
| `EditorController` | The inline editor: draft text + attachments + selected model, preview toggle, save-as-version, cancel-with-confirm, close, and the Continue / switch-characters shortcuts incl. the batch size | `editor-controller.ts` |
| `SendController` | The send pipeline: composer send, Branch, Insert, the Continue / switch-characters batch, and both streaming paths (single raw stream + the "held" stream the batch pipelines) | `send-controller.ts` |
| `DialogActionsController` | Every action that starts with a modal: prepend (director text + `send-prepend`), compare versions / siblings (draft-apply while editing, version-write from the read-only view), chapter descriptions (`send-chapter-descriptions`) | `dialog-actions.ts` |
| `context-menu.ts` | Pure `buildCtxMenuItems(ctx)` — the role/state → menu-items switch | `context-menu.ts` |
| `attachments.ts` | Pure `filesToAttachments`, size cap | `attachments.ts` |
| `editor-scroll.ts` | Pure measurement helpers: ro→editor scroll continuity, caret at point | `editor-scroll.ts` |
| `NodeEditSession` (`core/chat`) | The editing session itself (which node is being edited, dirty flag, draft hand-off) | `core/chat/node-edit-session.ts` |

The four controllers are component-scoped (`providers` on the card) and are
reached through a small **host interface** each (`EditorHost`, `SendHost`,
`DialogActionsHost`, `IllustrationCallContext`). That is the seam that keeps
them DOM-free: anything that needs a `viewChild` ref, the textarea, or
`activate.emit` is passed IN per call or points back at a card method.

Bulk member moves go through `0scripts/ts-remove-members.mjs` (TypeScript AST).
A hand-rolled brace counter silently cut wrong ranges once — strings and
template literals confused it.

Invariants worth knowing before changing anything here:

- **One action at a time.** Everything that costs a round-trip runs under
  `NodeActionState.begin(kind)` / `end()`. Never introduce a local boolean —
  note the draft signals in `EditorController` and the busy signals in
  `NodeActionState` are deliberately writable, because several call sites
  (attachment manager, search integration, flows) write the same state.
- **Streaming is not a local state.** `isGeneratingAssistant()` /
  `isThinkingLive()` read `ChatService` (per-node generation id + presented node
  of the reveal queue). A background buffer must not show a spinner or steal
  the follow-scroll.
- **Edits are versions.** `editAssistant` / `editUser` retire the old node and
  return a new id — after such a call the component must re-target
  (`this.activate.emit(saved.id)`, and for progressive writes the current
  target id).
- **scroll-restore delegates stay methods.** `scrollParentOf`, `scrollTopForOffset`
  etc. must remain component methods (specs stub them); the pure logic lives in
  `editor-scroll.ts`.

## `ChatComponent` — the conversation page

`src/app/pages/chat/`

| Part | Owns | File / service |
|---|---|---|
| `ChatComponent` | Layout shell: sidebar, params bar, tree scroll, dialogs wiring, keyboard handling | `chat.component.ts` / `.html` / `.css` |
| `ChatNavSelectionService` | Navbar multi-select / drag-range / paste-target state | `core/chat/chat-nav-selection.service.ts` |
| `ChatLayoutPrefsService` | Sidebar width + per-chat navbar height, resize handling | `core/chat/chat-layout-prefs.service.ts` |
| `ChatElaborateDialogService` | Elaborate dialog state, per-chat persistence, plan candidates, prompt preview | `core/dialogs/chat-elaborate-dialog.service.ts` |
| `ChatSearchService` *(planned)* | Find-in-story / name replace / name list — still inside the component | — |
| `PacedReadService` + `ReadingMarksService` | Paced reading run and persistent marks | `core/llm/paced-read.service.ts`, `core/chat/reading-marks.service.ts` |
| `ChatService` | Facade over the tree services — the only place that mutates chats/nodes | `core/chat/chat.service.ts` |

Invariants:

- **The tree renders the active path only.** Anything meant to be *visible*
  must set the active child immediately (`setActiveChild`), not after the
  request finishes.
- **Selection is a contiguous chain of the active path.** `applyNavSelection`
  normalises every toggle/drag result; copy/cut/delete operate on that chain in
  path order.
- **Navbar paste splices**, it does not append as siblings — `insertIntoPath`
  re-hangs the node that used to follow.

## Where to change what

| I want to… | Change |
|---|---|
| Adjust an illustration use case / prompt | `core/llm/orchestration` (not the component) |
| Change what a send persists before streaming | `SendController.sendDraft` |
| Change the editor's save/cancel rules | `EditorController` |
| Change a prepend / compare / chapter-description action | `DialogActionsController` |
| Add a node button or menu entry | template + `context-menu.ts` + a delegate in the component |
| Change a dialog's fields | the dialog component + its `core/dialogs/*` service |
| Change chapter-plan detection | `core/llm/chapter-plan.ts` + `ChatElaborateDialogService` |
| Change what a send carries | `core/llm/orchestration/flows` / `usecases` |
| Change the message stream | `core/llm/llm-message.ts` (`nodeToMessageContent`) |

## Guard rails

- Line budgets are enforced by `npm run verify:size`
  (`0scripts/check-file-size.mjs`) for both components' `.ts` / `.html` /
  `.css`. New features should land in helpers, services or orchestration — not
  by growing the two component files further. When an extraction lowers a real
  size, lower its budget in the same commit.
- Every extraction keeps the component's public members as thin delegates, so a
  spec-only refactor can follow in a *separate* commit.

## Remaining work

Not yet extracted (do them one at a time, each green):

1. `<app-chat-nav>` child component (chat page) — requires moving the whole
   `.node-nav-bar` / `.nav-*` / `.nav-paste-*` CSS block with it (emulated
   encapsulation), plus `#nodeNavBar` / `navBarHeight()` / `isNearViewport` as
   inputs. Highest remaining risk.
2. `ChatSearchService` (chat page) — keep `measureSearchCaret` on the component;
   the specs stub it.

### Bulk edits: use the parser, not a brace counter

`0scripts/ts-remove-members.mjs <file> <Member> [...]` deletes top-level class
members through the TypeScript AST. A hand-rolled brace counter silently cut
wrong ranges once (strings and template literals confused it) — never repeat
that.
