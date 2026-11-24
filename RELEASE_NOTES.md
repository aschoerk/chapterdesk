# ChapterDesk — Release Notes

Changes between **v1.0.2** and **v1.0.5**, grouped at feature level instead of raw
check-in messages. For the exhaustive per-commit list see
`git log v1.0.2..v1.0.5`.

---

## v1.0.5 — Parallel Work, Forks & a First-Class Navigation Bar

### Working on several stories at once
- **Parallel chats** — different chats can stream at the same time. Within one
  chat only one generation/batch may run; a second start now shows an explanatory
  toast instead of mixing its output into the same message list.
- **Switching chats keeps the running view** — the revealed/presented node and
  the chat's visibility state survive a chat switch.
- **One socket for all LLM/image traffic** — a WebSocket multiplexer carries every
  proxy request, so long-lived streams and slow image renders no longer exhaust
  the browser's ~6-connection HTTP/1.1 limit (a second chat or the chat list used
  to hang until a stream finished).
- **Separate, explicit timeouts** for text and image calls; the backend keeps
  slow upstreams alive with interim `102 Processing` responses, so a local image
  server that renders for many minutes is no longer treated as a dead connection.

### Stable Diffusion server providers
- **New provider type `SD-Server`** (A1111-compatible) in Settings → Providers,
  with its own settings dialog: model, LoRA, aspect ratio/resolution, sampler,
  scheduler, upscaler, CFG, steps, images per run, seed, IP-Adapter strength,
  clip skip, control weight and caching.
- **Load options** fetches the model, sampler, scheduler, LoRA and upscaler lists
  straight from the server; aspect ratio/resolution are mapped to pixel sizes.

### Chapter work
- **Continue / Multiple Characters / Elaborate in the chapter context menu** —
  chapter-scoped: they fill a fresh direction right after that chapter instead of
  using the current composer/caret position.
- **Automatic sentence completion in chains** — Elaborate inserts a *complete the
  preceding chapter* step when a chapter ends mid-sentence; Continue/Multiple
  Characters do the same with *complete the preceding message*. The number of
  retries is bounded and the wording is editable under Settings → Prompt defaults.
- **Chapter plans stay trustworthy** — Regenerate and Rewrite in place re-create
  the hidden `chapter-plan.json` record from the new list (a rewrite replaces the
  stale record of the old list). Hand-written numbered lists that carry
  descriptions are offered in **Plan from**, newest first.
- **Stop during preparation** — a hard Stop also cancels a chapter whose
  question/lore is still being created, so no orphan LLM call starts afterwards.

### Lore
- **Lore is a node type of its own** — lore nodes get their own badge and styling,
  fork like directions, and appear in the chapter/selection context menus; legacy
  lore nodes are migrated on the server.
- **Lore markers in the nav bar** — *armed* (sent with the next direction) vs
  *documented* (excluded) states are visible, and identical repeated lore texts
  are collapsed until the canon changes.

### Navigation bar
- **Extracted into `ChatNavBarComponent`** — the bar, resizer and both context
  menus now live in one component; selection tools include copy, cut, **Extract**
  and **Extract subtree into a new story**, delete, clear and paste at top.
- **Word statistics** — selection word counts (node and whole subtree), plus a
  per-node tooltip with position, percentage, words and pages. Branch pills keep
  their `n / m` fork badge.
- **Context menus for the bar** — right-click a node for previous/next fork,
  start branch here, copy/cut/delete and the paste variants; right-click a paste
  arrow for the paste menu.
- **Correct chains** — only the active sibling appears in the chain, and retired
  versions never do, even through `previousVersionId` chains; marks fall back to
  the next visible node.
- **Large stories** — memoized sibling lists make path/branch computation linear
  instead of re-scanning the whole tree; marking and scrolling in long nav bars
  were reworked, and the tools row stays readable while scrolling.
- **Toolbar overflow** — the chat toolbar scrolls with left/right arrow buttons
  for hidden actions and shows batch progress while a chain runs.

### Comparing and diffing
- **Monaco diff dialog** — resizable and remembers its size; choose any source and
  destination reader variant or two story versions from selectors, with change
  counts that refresh reliably after switching documents.
- **Story comparison in the side bar** — compare structure, content, attachments
  and older versions of two selected stories; **Compare reader views** and
  **Compare this chat’s reader variants** open in Monaco.
- **Side-bar maintenance menu** — prepend the topic system prompt, correct the
  section count, attach root sections to the system prompt, remove excluded
  sections.

### Terminology & UX
- **“Fork”** replaces “continuation” for branch-related UI (Previous/Next fork,
  Start branch here, Fork button, fork badge).
- **Busy guard** — starting a second generation in the same chat produces an
  explanatory toast instead of interleaved output.

### Fixes
- Cut/copy of chat parts, fork visibility with siblings, mark/scroll jumps in the
  nav bar, elaborate searching chapter lists, diff buttons, and inconsistent
  visibility signs.

### Documentation & release engineering
- New manuals: **From Microsoft Word to ChapterDesk** (with a Word→ChapterDesk
  translation table) and **Making ChapterDesk Easier to Explain** (proposals).
- New developer docs: **Chat UI component map**, **spec documentation** (overview,
  hand-written guarantees, generated spec inventory) and sequence diagrams for
  send/fork, elaborate, lore, illustrate, storage routing, structure and version
  editing. New scripts: `docs:diagrams`, `docs:specs`, doc-link check and
  file-size budgets.
- **Node 24** in Docker images, CI and Electron packaging; release actions bumped
  (no more Node 20 deprecation warnings).
- **Large refactors, unchanged behaviour** — `ChatComponent`/`ChatNodeComponent`
  split into nav bar, context-menu, text-actions, dialog-actions,
  editor/send/illustration controllers; chat services split into
  nav/menu/selection/marks/search/paced-read/elaborate/clipboard services.

---

## v1.0.4 — Names, Paced Reading & Chapter Plans

### Names & Terminology
- **Name management dialog** — collect, review and edit the names of a story in one place.
- **Name replacement** — replace a name across the whole story, including umlauts
  and other Unicode letters (ß/ss spellings are folded together); a comparison view
  shows what changes before you commit.
- **Name dictionaries & built-in names** — spelling variants are recognised and mapped
  onto one canonical name, so "Mara", "MARA" and "Mará" are treated as the same person.
- **Reproducible name handling** — same story, same replacement decisions.

### Reading Experience
- **Paced reading** — reveal a chapter at a chosen reading pace without an LLM call,
  now usable even on stories that have no generated answers yet.
- **Reading marks & bookmarks** — mark spots in the text and jump back to them.
- **Held-answer streaming** — the reveal queue and reading-time estimates keep the
  text flow steady during long generations.
- **Minimise/unminimise the sidebar** for more reading room.
- **Reading mode hides direction nodes** and shortens long nodes with "…" so the story
  reads as prose, not as a prompt log.

### Chapter Handling
- **Chapter plan support** — chapter description lists are parsed, kept as a record
  attachment and can be fed into the elaborate dialog as a temporary lore section.
- **Improved chapter counting/elaboration** across the toolbar and the dialog.
- New manual page: **Chapter plans**.

### Streaming & Editing
- **Follow streaming** simplified and hardened.
- **Double-click to edit** any node; clicking an assistant node opens it with the caret
  at the clicked position.
- **Monaco diff view** for comparing text versions and sibling branches.

### Desktop & Packaging
- **Window placement/state is remembered** across restarts (`electron/window-state.js`).
- New X11 desktop entry and Linux packaging polish.

### Fixes
- Capitalisation inconsistencies, dangling draft nodes, the blue hover state, clone,
  drag-chat, and elaboration/repetition-counter edge cases.

---

## v1.0.3 — Documentation Site, Playbooks & Polished Workflows

### Documentation
- **Full MkDocs documentation site** with strict builds, pinned theme and a generated
  user manual committed to the repo.
- **Video guides** (embedded GIFs) for provider/model setup, topic + story creation and
  chapter headings/elaboration.
- New manual pages: **Story Lore**, plus introductions to the manuals.

### UX & Workflows
- **Non-modal toasts** replace blocking dialogs for short-lived feedback.
- **Navbar adapts to visibility**, comparison view for versions and siblings,
  **double-click to edit**, and click-to-position caret in assistant nodes.
- **Illustrate by selected text**; **resend from the LLM log**.
- **Stream controls only appear while streaming.**
- **Images from chat can be attached** to image generation (chat image picker).
- **Shortcut help** panel, text-version panel and per-text version API.

### Platform & Release Engineering
- **Signed Windows release** pipeline and topic-selection fixes in the system node.
- `.gitignore` and clone fixes; excluded nodes handled consistently.

---

## v1.0.2 — Baseline
Reference point for this document (documentation fix only).
