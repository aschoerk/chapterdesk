# Concepts

ChapterDesk is a local **writing studio**, not a chat app. Code and URLs still
say *project / chat / question / answer*, but the words you see in the UI mean
something more specific:

| In the UI | Means |
|---|---|
| **Topic** | A body of work, plus the standing narrator rules (its system prompt). |
| **Environment** | A general setting-idea inside a topic: place, tone, who tends to be there. |
| **Story** | One narrative thread you can fork. |
| **Direction** | The cue you give for the next beat. |
| **Chapter** | The draft that comes back. |

## The core loop

1. You set the room once (Topic rules + Environment + Personas).
2. You open a Story and give a short **Direction**.
3. A **Chapter** streams back.
4. You read it, then steer again — or branch if you want to explore another
   path.
5. Whenever you want to just read, you switch to the **Book view**.

There is no long conversation history to manage. The active path is always
clear.

## Steering, not chatting

You give a short direction for the next scene. The model continues it. You
stay in control of what happens next — the model drafts the beat, you decide
what happens after. When a moment could go two ways, you **fork the thread**
and keep both versions instead of overwriting.

## Organized for longer work

- **Topics** hold the narrator rules of a whole body of work.
- **Environments** describe a place/setting-idea inside a topic, leaving room
  for many stories.
- **Personas** are who the narrator may speak for.

This gives longer fiction structure without forcing you into a rigid outline.

## Local first

Your stories and settings stay on your machine. The app talks only to a local
server; that server is what calls your chosen model provider. See
[Privacy](privacy).

## Next steps

- [Write Your First Chapter](new-story)
- [Books (Environments) and moving stories](environments)
- [Read your story as a book](reader)