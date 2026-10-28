// ---------------------------------------------------------------------------
// Auto-generated intro paragraphs for the user manuals (e2e/manual/*).
//
// Each entry is injected into the generated docs/manuals/<scenario>.md right
// below the title (after the "> Auto-generated on …" line), so every manual
// opens with a formatted explanation of the feature before the step-by-step
// walkthrough.
//
// A single spec can override its default (or suppress it entirely) by passing
// the `intro` argument to newManual() — see manual-support.ts. Editing this
// file changes the default for everyone.
// ---------------------------------------------------------------------------

/** Intro text per manual scenario, keyed by the scenario name passed to newManual(). */
export const DEFAULT_INTROS: Record<string, string> = {
  'manual-welcome': `ChapterDesk is an AI co-writer for stories. Everything lives in
the left **sidebar**: your **books** (environments) group several **stories**,
and a story is a tree of **directions** and **chapters**.

This manual walks through the first launch, the sidebar and opening a story.`,

  'manual-new-story': `Writing a story is a dialogue: you give a **direction** — what
should happen next — and ChapterDesk streams the next **chapter**. Directions
and chapters alternate down the page and form the story tree.

This manual creates a fresh story and writes the first chapter.`,

  'manual-continuations': `The **navigation bar** shows the active path of the current story —
the chain of sections from the opening direction to the latest chapter. It lets
you jump to any section, open a right-click context menu, or multi-select a
contiguous chain to copy, cut or delete it.

Every section on the path is a button: **D**irection, **C**hapter, or
**S**tructure. The highlighted button is where you are right now.`,

  'manual-node-actions': `Right-click any section to open its **context menu**: copy, edit,
rewrite, exclude from the model context, remove, or delete it (with or without
the following sections).

This manual shows the actions on a real section of the seeded story.`,

  'manual-lore': `**Lore** is a short set of never-miss world facts the model must
respect and never contradict. It is stored per story and inserted in front of
every new direction when the prompt is sent — sent exactly once, then
documented, so it never repeats and never clutters the context.

This manual sets up lore for a fresh story and shows it travel with a prompt.`,

  'manual-illustrate': `The **Illustrate** action attaches a generated picture to a chapter.
You can illustrate the whole chapter or select a marked part of the text to
depict exactly that moment.

This manual generates a picture for a chapter and then for a selected passage.`,

  'manual-reader': `The **Reader view** shows your story as a clean, read-only document —
book sections, a document folio and a progress bar — without the editing
chrome.

This manual opens a story in the Reader and returns to the edit tree.`,

  'manual-personas': `**Personas** are writing voices / narrators you can attach to
environments. Each persona can be created, edited and set as the current
persona.

This manual creates a persona and reviews it.`,

  'manual-topics': `**Topics** group your books (environments) and personas. Each topic
can be created, edited and marked as the current topic.

This manual creates a topic and reviews it.`,

  'manual-settings': `The **Settings** area groups the configuration pages: **Appearance**
(theme and language), **Providers / Models** (which AI providers and models
are enabled), **Generation Tasks** (which model handles each writing task) and
**Prompt defaults** (the built-in prompts ChapterDesk builds automatically).

This manual walks through each settings page.`,

  'manual-environments': `**Environments** are your books; each groups stories that belong
together. Stories can be moved between books from the sidebar.

This manual creates a book and moves a story into it.`,

  'manual-trash': `Deleting a continuation is **soft**: the section moves to the **Trash**
instead of being destroyed. From there you can **restore** it or **delete it
forever**.

This manual deletes a section, restores it, and finally purges it.`,
};
