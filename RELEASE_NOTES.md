# ChapterDesk — Release Notes

Changes between **v1.0.2** and **v1.0.4**, grouped at feature level instead of raw
check-in messages. For the exhaustive per-commit list see
`git log v1.0.2..HEAD`.

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
