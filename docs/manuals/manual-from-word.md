# From Microsoft Word to ChapterDesk

> A gentle translation of the concepts. If you have written stories in
> Microsoft Word all your life, this page explains how ChapterDesk thinks
> about a story — and where the mental model differs.

## The one idea that changes everything

In Word, a story is **one continuous document**: a linear stream of paragraphs
that you type top to bottom. The document *is* the story.

In ChapterDesk, a story is a **tree of sections**. There is no single "the
document" — the document is something ChapterDesk *derives* from the tree when
you read or export. The tree is the source of truth; the document is a view of
it.

That one difference explains almost everything else on this page.

## The sections of a story

A story is built from **sections** (the app sometimes calls them *nodes*).
Each section is one block in the tree. There are four kinds:

| Section | Badge | What it is | Word equivalent |
|---|---|---|---|
| **Direction** | `D` | What you tell the AI should happen next | a brief note to yourself |
| **Chapter** | `C` | What the AI writes back | a paragraph or scene |
| **Structure** | `S` | A heading, a title, a chapter list | a Heading 1 / Heading 2 |
| **Lore** | `⟡` | Never-miss world facts sent with every prompt | the "story bible" page you keep beside the manuscript |

Directions and chapters **alternate** down the page: you write a direction, the
AI streams a chapter, you write the next direction, and so on.

!!! note "You are the author"
    The AI writes the *prose*; you write the *directions*. Directions are how
    you steer — "the door opens onto the sea", "introduce the creditor now".
    The chapters are the manuscript; the directions are the scaffolding.

## Writing is a dialogue, not typing

In Word you type the story. In ChapterDesk you **direct** the story:

1. Click the composer at the end of the story.
2. Type what should happen next (your **direction**).
3. Press **Ctrl+Enter**.
4. The AI streams the next **chapter** into the tree.

There is no manual save for the story itself — every section is saved the
moment it is created or edited.

## The active path (continuation)

The chain of sections from the opening to the latest chapter is the **active
path** — ChapterDesk calls it the *continuation*. This is what you see in the
main view, and it is what the AI sees as context when it writes the next
chapter.

The **navigation bar** at the bottom shows the active path as buttons
(`D` `C` `D` `C` …). Click any button to jump to that section. It is the closest
thing to a table of contents that always stays in view.

## Forks: when one story becomes several

Because a story is a tree, you can start a **parallel continuation** from any
chapter — a *fork*. Each fork is its own branch of the tree, and each branch is
its own **story document**.

This is the biggest difference from Word. In Word, "what if the hero left
instead?" means *another file* (or a copy). In ChapterDesk it means a **fork**:
keep the current branch, start a new one from the same point, and switch
between them freely. Nothing is copied; both branches live in the same story.

## Versions: editing never destroys

In Word, overwriting a paragraph loses the old text (unless you kept Track
Changes on). In ChapterDesk, editing a section **creates a new version** — the
old version is kept, and you can compare versions or go back.

The version number is visible next to each section (`v1`, `v2`, …). The Reader
and the exporters always use the *youngest* version of each section.

## Story documents: how the tree becomes a book

When you open the **Reader view** (the book button) or export to DOCX /
Markdown, ChapterDesk turns the tree into **documents**:

- A document is a **root-to-leaf path** through the tree.
- At a fork, the path is **cloned**, so each sibling branch becomes its own
  complete document.
- Empty sections are transparent connectors (kept so the chain stays
  connected, not rendered).
- Empty childless leaves (a draft you never sent) are dropped.
- Only the youngest version of each section is used.

So "read your story as a book" really means: *walk the tree, and read each
branch as its own document.* A story with three forks reads as three documents.

## Front and back matter

An export can carry **front matter** (right after the title — or before all
other content when the story has no title) and **back matter** (after the last
chapter, on its own page in the DOCX). Both are **Markdown templates** you edit
in *Settings → Prompt defaults → Export*:

| Template | Where it lands |
| --- | --- |
| Front matter (`export.frontMatter`) | directly after the title |
| Back matter (`export.backMatter`) | after the last chapter |

They are ordinary Markdown — headings, lists, emphasis, block quotes — and are
converted to Word when you export a `.docx`; the Markdown export inserts them
as written. Leave a template empty (the default) and nothing is inserted. Like
all templates they can have named versions, globally or per topic.

!!! tip "The Reader is your Word view"
    If you want the familiar feeling of a clean, linear manuscript, use the
    **Reader view**. It hides the editing chrome and shows the current branch
    as a continuous book — directions, chapters and headings as sections, with
    a progress bar. Press **Escape** to return to the tree.

## Lore: the story bible that travels with every prompt

**Lore** is a short set of never-miss facts — "Ashley is married to Dr. Harvey",
"The Velvet Cage has no exterior sign". You set it once per story, and it is
sent with every prompt so the AI never contradicts it.

In the tree, lore appears as a `⟡` section in front of a direction. It is sent
**once** with that direction, then documented (dimmed) so it never repeats and
never clutters the context. The navigation bar shows a `⟡` pill for each
*change* of lore — the first appearance of each distinct lore text, with
identical repeats hidden until the content changes.

Word users keep this as a separate notes page; ChapterDesk keeps it *inside*
the story, attached to the point where it applies.

## Deleted forks and the trash

Deleting a section or fork does not destroy it immediately — it goes to the
**trash** panel, where you can restore it or purge it for good. This is the
"undo" safety net for whole branches.

## Quick translation table

| In Word you… | In ChapterDesk you… |
|---|---|
| have one linear document | have a tree of sections; the document is derived |
| type the story | direct the AI, which writes the chapters |
| save the file (Ctrl+S) | nothing to save — sections are saved instantly; Ctrl+S saves an edit as a new version |
| overwrite a paragraph | edit a section → a new version is created, the old one is kept |
| make a copy for "what if" | start a **fork** — a parallel branch in the same story |
| keep a notes page for world facts | set **lore** on the story, sent with every prompt |
| use Track Changes | use **versions** (compare / go back) |
| read the printed page | open the **Reader** view |
| find & replace | use **Search and replace** and **Replace names** |
| write comments in the margin | add **reading marks** with notices |

## Where to go next

- [Write your first chapter](./manual-new-story.md) — the dialogue in practice.
- [Read your story as a book](./manual-reader.md) — the document view.
- [Continuations and the navigation bar](./manual-continuations.md) — the active path.
- [Section actions and the context menu](./manual-node-actions.md) — edit / fork / version.
- [Story lore](./manual-lore.md) — the canon that travels with every prompt.
- [Delete and restore sections](./manual-trash.md) — the safety net.

---

*If some of these concepts still feel foreign, see
[what ChapterDesk could change to make the translation easier](./manual-from-word-proposals.md).*