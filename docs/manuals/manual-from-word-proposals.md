# Making ChapterDesk easier to explain — proposed changes

> This page collects concrete changes that would make the
> [Word → ChapterDesk translation](./manual-from-word.md) much easier to
> explain and to learn. Each item says what exists today and what would
> change. Items are proposals unless marked **[done]**.

The core difficulty for a Word user is not the features — it is that the
**mental model** is different (tree vs. document) and the **vocabulary** is
different (direction, node, structure, lore). The proposals below close that
gap in three ways: *speak the user's language*, *show the document*, and
*make the tree legible*.

---

## 1. Speak the user's language

### 1.1 Unify the vocabulary in the UI

Today the UI mixes several words for the same things: *direction*, *chapter*,
*section*, *node*, *structure*, *continuation*. A Word user already knows
*paragraph*, *heading*, *document*, *save*, *copy*.

**Proposal:** adopt one consistent, Word-friendly vocabulary and use it
everywhere (buttons, menus, tooltips, dialogs, docs):

| Today | Proposed user-facing word |
|---|---|
| direction | **note** (or keep *direction* but explain it once) |
| chapter | **chapter** (unchanged) |
| structure | **heading** |
| node / section | **section** |
| continuation / active path | **story line** (or *the story so far*) |
| fork / branch | **branch** (already used) |
| story document | **book / document** (explain: one branch = one document) |

A short **glossary** in the app (e.g. under the `?` shortcut help) would let a
Word user translate any term in one place.

### 1.2 Explain "the document" on first launch

**Proposal:** in the welcome / onboarding, add one line that a Word user
instantly understands: *"Your story is a tree of sections. When you read or
export it, each branch becomes a document — like a separate Word file."*

---

## 2. Show the document

### 2.1 An editable "manuscript view"

The **Reader** already shows a clean, linear document — but it is read-only.
A Word user wants to *edit* that document.

**Proposal:** a **manuscript view** — the same clean linear rendering as the
Reader, but editable: click a chapter to edit it in place, add a direction
between chapters, reorder sections. Directions stay visible as small, collapsed
labels (so the author still steers) but the prose reads continuously.

This single view would remove most of the "where is my document?" confusion.

### 2.2 Show the derived documents explicitly

Today "story documents" are an invisible consequence of the tree (see
[the concepts page](./manual-from-word.md#story-documents-how-the-tree-becomes-a-book)).

**Proposal:** in the Reader's document folio, show *"This story is N documents"*
and list them (branch 1, branch 2, …). When a fork is created, show a small
toast: *"A new document was created from this branch."* This makes the
tree→document rule visible instead of implicit.

### 2.3 A story map (branch + version overview)

**Proposal:** a **story map** — a compact overview of the whole tree: branches
as parallel lines, versions as dots on a line, lore milestones as `⟡` markers,
and the current position highlighted. Clicking a point jumps to that section.
This is the one picture that explains forks and versions at a glance.

---

## 3. Make the tree legible

### 3.1 Lore as a first-class, discoverable concept

Lore is the most foreign idea to a Word user (their "story bible" is a separate
notes page). It is now a dedicated section type with a `⟡` badge, and the
navigation bar shows a `⟡` pill per lore *change* **[done]**.

**Proposal (next):** a **lore editor** — a single dashboard where the author
sees the current lore for the active branch, edits it, turns it off, and views
its history (each change as a milestone). The editor is the place where the
Word user's "notes page" lives, in one screen, in plain language — never in
tree-flag terms. Clicking any `⟡` pill in the navigation bar opens the editor.

### 3.2 Word counts and reading time everywhere

Word users think in **word counts** (a chapter is ~2000 words).

**Proposal:** show per-chapter and cumulative word counts (the app already
estimates reading time and character counts) in the section header and the
Reader folio, so a Word user can compare "how long is this chapter" directly.

### 3.3 Autosave reassurance

Word users are trained to press **Ctrl+S**. ChapterDesk saves everything
automatically, but nothing says so.

**Proposal:** a subtle *"Saved"* indicator in the toolbar (appears briefly
after any change), plus a one-line note in the welcome flow: *"Everything is
saved automatically — there is no Save button."*

---

## 4. Word interop

### 4.1 "Open a Word document" as a first-class flow

DOCX export and import already exist **[done]**.

**Proposal:** make the *import* path a visible first-class action — "Open a
Word document" — that converts a `.docx` into a story: headings become
**structure** sections, paragraphs become **chapters**, and the author can add
directions between them afterwards. This is the natural on-ramp for a Word
user with an existing manuscript.

### 4.2 Export the whole story, not just one branch

**Proposal:** an export option "All documents (one file per branch)" that
writes every fork as its own `.docx` — matching the mental model that each
branch is a separate Word file.

---

## 5. Lower-cost quick wins

These are small, cheap changes that remove the most common "why?" moments:

- **Rename "Reader view"** to "Book view" (the Reader already calls documents
  *books* in places) so the metaphor is consistent.
- **Tooltips on the `D` / `C` / `S` / `⟡` badges** that say the full word
  ("Direction", "Chapter", "Heading", "Lore") — the badges are currently
  unexplained single letters.
- **A "what is a fork?" hint** the first time the branch switcher appears.
- **Explain the navigation bar** in the welcome flow: *"The bar shows the
  story line — click any section to jump to it."*

---

## Priority

| Priority | Item | Why |
|---|---|---|
| High | 2.1 Editable manuscript view | removes the core "where is my document?" confusion |
| High | 1.1 Unified vocabulary + glossary | every other explanation gets easier |
| High | 3.1 Lore editor | makes the most foreign concept approachable |
| Medium | 2.2 / 2.3 Story map + document count | makes tree→document visible |
| Medium | 3.2 / 3.3 Word counts + autosave note | Word-parity reassurances |
| Medium | 4.1 / 4.2 Word open/export flows | natural on-ramp and off-ramp |
| Low | 5. Quick wins | cheap polish |

---

*These are proposals for discussion, not a commitment. The
[concepts page](./manual-from-word.md) describes how ChapterDesk works today.*