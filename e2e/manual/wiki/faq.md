# Frequently asked questions

## Do I need an API key?

Yes, ChapterDesk does not ship a model. You connect a provider that speaks the
OpenAI-style chat API (OpenRouter is the usual choice). See
[Download & Install](install) and [Settings](settings).

## Is there a way to try it without a key?

A built-in **mock model** ("Mock (no key)") lets you explore the whole app —
writing, titles, headings, language checks — with plausible demo text and no
API key. You can replace it with a real provider any time in **Settings →
Providers**.

## Where is my data stored?

Locally, in SQLite:

- Linux: `~/.config/ChapterDesk/data/chapterdesk.sqlite`
- Windows: `%APPDATA%\ChapterDesk\data\chapterdesk.sqlite`

The app talks only to a local server; your stories never leave your machine
except for the text you explicitly send to a model you configured. See
[Privacy](privacy).

## Is ChapterDesk a chat app?

No. You give short **directions** for the next scene and read the **chapter**
that comes back. There is no long conversation history to manage — the active
path is always clear. See [Concepts](concepts).

## What does "fork a thread" mean?

When a moment could go two ways, you branch the draft and keep both versions
instead of overwriting one with the other. Each continuation is kept, and you
can switch between branches or paste parts back together.

## How do I read my story as a book?

Open the **Book view** (the reader) from the navigation bar. It renders the
active path as continuous, read-only prose, with one document per
continuation. See [Read your story as a book](reader).

## Can ChapterDesk create pictures?

Yes. Use **Illustrate** on a chapter to render a picture for the scene, or
**Create image** from a marked selection. See
[Illustrate your chapters](illustrate).

## I deleted something — is it lost?

No. Deletions are soft by default: the branch moves to the **Trash** where you
can **Restore** it or **purge** it forever. See
[Delete and Restore Sections](trash).

## Do my custom prompts / settings sync between devices?

They are stored on your machine (localStorage / SQLite). ChapterDesk is
local-first — there is no cloud account or automatic sync.

## Where can I report a bug or ask for a feature?

Open an issue on the [GitHub repository](https://github.com/aschoerk/chapterdesk/issues).