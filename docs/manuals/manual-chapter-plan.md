# Chapter plans in the lore of an elaboration

When you elaborate chapters, the model only sees what is already written. This
feature lets each elaboration also see the **planned description of the chapter
it is writing**, plus the descriptions of the following chapters — as *temporary
lore*, never as permanent story text.

## Step 1 — create a chapter description list

Right-click an empty direction (or any node) → **Chapter descriptions…** and
generate a list. The result is a normal, readable list in its own branch:

```
7. The Gate — Mara finds the key under the loose stone and learns that her
   father kept a second ledger. She hides it before the steward returns.
8. The Road — They leave before dawn and lose the track in the rain. By noon
   the bridge is gone.
9. The Ledger — The second ledger names a creditor Mara has never heard of.
   She decides to find him alone.
```

The request carries a fixed **format contract** (appended by the app, not by the
editable prompt): one chapter per paragraph, starting with `N. `, heading and
description separated by ` — `. That keeps the list easy to read *and* reliable
to parse. The parsed result is additionally stored next to the node as a hidden
`chapter-plan.json` record, so later steps never have to re-read the prose.

The record is kept up to date: **Regenerate** and **Rewrite in place** re-create
it from the new list (a rewrite replaces the stale record of the old list), and a
regenerated answer is parsed again. If a list has no record at all — older
stories, or an answer regenerated before this was fixed — its own text is
parsed instead; that fallback requires the list to *be* the node (first line is
a numbered item) and every entry to carry a real description.

## Step 2 — use it in the Elaborate dialog

**Elaborate** → **Chapter descriptions → lore** is already on whenever the story
has a chapter description list (uncheck it to elaborate without the plan; the
dialog remembers an explicit uncheck per story):

| Field | Meaning |
|-------|---------|
| **Plan chapters** | How many chapter descriptions travel with each elaboration *in total*, counting the elaborated chapter (`1` = only that chapter). |
| **Plan from** | Which list to use, when the story has more than one. The newest is the default. |

The dialog shows the detected range (e.g. `7–16, 10`). If the list does not
cover the chapters you are elaborating, a warning says so and nothing is added.

## What the model receives

Every elaboration still sends the one-shot lore node. When the option is on, that
node additionally contains a clearly marked section:

```
[Chapter plan for this chapter — fixed canon that must be respected]
9. The Ledger — The second ledger names a creditor…
10. The Reckoning — …
[/End of chapter plan]
```

Only that one send sees it. The node stays in the tree as documentation, but is
excluded from the model context afterwards, so later chapters are not polluted.
Your story lore (**Lore** button) is never modified.

Chapters the plan does not cover simply get no plan section — a neighbouring
chapter is never borrowed into canon.

## Notes

- If you previously saved your own version of the prompt **Chapter description
  list** (Settings → Prompt defaults), the improved default has no effect until
  you press **Revert to default** there.
- Hand-written numbered lists work too: a numbered list whose first line is an
  item and whose entries each carry a description is offered in **Plan from**
  next to the generated lists (newest first). A bare list of headings without
  descriptions is not offered.
- The list is matched by chapter **number**, so a chapter-number prefix in the
  Elaborate dialog (`ARC-`, …) does not interfere.
