# Manual testing — LLM orchestration use cases (human tester)

Companion to `test-plans.md` (the automated test plan). This document tells a **human
tester** how to exercise the LLM-orchestration use cases by hand: which environment to use,
**how to load test data**, **how to reset to the original state**, and a step-by-step
checklist per use case with the expected result.

The use cases under test are the same `UsecaseKind` set as in the automated plan:

| Group | Use cases |
| --- | --- |
| Illustrate / storyboard | 1 `storyboard-direct`, 2 `planned-enblock`, 3 `planned-scenes`, 4 `render-full`, 4b `render-window`, 5 `render-node`, 14 `image-send` |
| Plain send | 6 `append`, 7 `append-with-images` |
| Structural flows | 8 `send-branch`, 9 `send-insert`, 10 `send-regenerate`, 11 `send-rewrite`, 12 `send-prepend`, 13 `send-elaborate`, 21 `send-chapter-descriptions` |
| Structure / language | 15 `structure-title`, 16 `structure-overview`, 17 `structure-heading`, 18 `structure-headings`, 19 `language-check`, 20 `rewrite-selection` |

---

## 1. Which environment

| | **A. Real app** | **B. E2E Docker stack (recommended)** |
| --- | --- | --- |
| What you test | the real app the way a user runs it | reproducible, deterministic behavior |
| Data | SQLite or IndexedDB, persists | **in-memory, seeded**, resets per run |
| LLM | server-side “Mock (no key)” — Mock Writer (text) + **Mock Image** (small SVG pictures) | browser-intercepted canned SSE (text only) |
| Reset | delete/restore DB + clear site data | `docker compose … down` |
| Best for | testing 6–21 (text) AND 1–5, 14 (images) with the mock; real-provider checks | testing everything repeatably (text only) |

- **Text use cases (6–21)** need no API key in BOTH environments thanks to the built-in
  **“Mock (no key)”** provider (see §4).
- **Image use cases (1–5, 14)** now ALSO need no key in environment **A**: the mock
  registers a second model **“Mock Image”** (`mock-image`) that is image-capable and returns
  a small deterministic SVG picture per render request (§3.5). Without it (e.g. when you
  Reset the Image creation task or disable the model) these flows correctly end in
  “No image model is enabled” — that alert itself is a valid (negative) check (D8).
- Environment **B**'s browser mock is text-only; to test images there, leave the default
  browser interception or point the client at a running server mock (recommended: test
  images in environment A).
- Prefer **B** when you must report a bug: it is deterministic and one command resets it.

---

## 2. Environment B — E2E Docker stack (one origin, seeded data)

```
http://127.0.0.1:8081
   ├─ /                    Angular SPA
   ├─ /api/*               chapterdesk-api-server (memory, seeded from e2e/fixtures/seed.json)
   └─ /proxy/chat/completions
```

**Start**

```bash
npm install
npm run e2e:build          # builds API dist + SPA + chapterdesk-dev image (once)
npm run e2e:serve          # docker compose -f docker-compose.e2e.yml up (keep running)
# open http://127.0.0.1:8081 in a browser
```

**Import the demo workspace (optional)** — open the **Import** page and press **“Load demo”**
(tested in §3.1).

**What the seed gives you:** topic “Demo Topic”, project “Demo Project”, persona “Editor”,
chat “Getting Started” with a user direction + an assistant answer, plus the providers and
models needed to send directions. Deterministic and identical every start.

**LLM simulation:** a browser route answers `POST …/proxy/chat/completions` with canned SSE.
The calls intercepted are logged by `e2e/support/llm-mock.ts` (model/provider/messages), so
you can check what the UI actually sent. For manually typing directions, enable the **Mock
(no key)** provider in **Settings → AI providers** (it points back at this same origin).

---

## 3. Loading test data

### 3.1 The built-in demo workspace (both environments, no key needed)

The demo (“ChapterDesk Demo”, community demo-bundle) is a complete small story with a
system premise, directions and chapters, headings, a table and a final composer — enough to
exercise structure, reading, editing and most text use cases **without an LLM**.

- **Automatically**: on a truly empty workspace, the demo is loaded at startup.
- **On demand (recommended for testing)** — open the **Import** page and press **“Load demo”**:
  1. registers the **“Mock (no key)”** provider + **Mock Writer** and **Mock Image** models
     (idempotent),
  2. imports the demo bundle,
  3. opens the first demo chat.
- **Idempotent**: it refuses to load twice. To re-load after you deleted it, delete the
  “ChapterDesk Demo” project (the guard is the project’s presence, not a localStorage flag).

### 3.2 E2E seed fixture

Environment B is pre-seeded from `e2e/fixtures/seed.json` (deterministic). If you change the
fixture you must recreate the container (§5.1) to see it.

### 3.3 Custom scenarios via bundle import

To test with your own story (e.g. a long chain to trigger window counting, or a tree with
several branches for `send-insert` / `send-regenerate`):

1. Build the scenario in a scratch chat.
2. **Export** it as a **ChapterDesk bundle** (`.chapterdesk` file).
3. **Reset** (§5), then open **Import → import file** to restore it.
4. Re-run the use case and compare against the baseline.

### 3.4 What the “Mock (no key)” provider returns

The server (`chapterdesk-api-server/src/http/mock-llm.ts`) answers OpenAI-shaped requests
with two models — **Mock Writer** (text) and **Mock Image** (pictures):

| You send (model) | You get back |
| --- | --- |
| Writing direction → **Mock Writer** (`append`, flows) | mock prose built from the direction |
| `structure-title` → Mock Writer | a generated title |
| `structure-overview` → Mock Writer | an introduction |
| `structure-heading` / `structure-headings` → Mock Writer | a heading |
| `language-check` → Mock Writer | a JSON list of 3 corrected variants |
| `send-chapter-descriptions` → Mock Writer | a mock chapter list |
| any render request → **Mock Image** | a small **SVG picture** (data URL) — see §3.5 |

The mock is **key-free**: no `.env`, no provider token. Enable **Mock (no key)** in
**Settings → AI providers** (DemoData ensures it on “Load demo” / “Add mock provider”).

### 3.5 The “Mock Image” model (deterministic pictures, content-triggered)

`mock-image` is image-capable (output modality `image`), so it appears in the **Settings →
Generation Tasks → Image creation** model list and as the Illustrate default once
**“Add mock provider”** has been pressed. Every render request is answered with a tiny
SVG (data URL) whose **colour and caption change with the prompt content**: a “sea”/“harbour”
prompt → blue picture, “fire”/“night” → red-dark, etc. Same prompt → same picture
(consistent style); different scenes → visibly different pictures.

**Deterministic triggers** — put any of these tokens into the **Additional rules** textarea,
the **Style** field, or the direction text to force a specific outcome:

| Trigger | What the mock does | Test this use-case path |
| --- | --- | --- |
| *(none)* | returns one picture per requested count (batch of N = N pictures, single = 1) | happy paths 1.1, 2.1, 3.1, 5.1 |
| `mock:partial` | a multi-picture batch yields exactly **1** picture | “only got X of Y” alert + batch-is-authoritative stop (1.2, 3.2) |
| `mock:per-scene` | the **batch returns 0** pictures so the per-scene fallback runs; single/per-scene prompts still return 1 | per-scene fallback (UC2/3 fallback, 2.2, 3.3) |
| `mock:refuse` | content-policy refuse: `message.refusal`, no picture, `finish_reason: content_filter` | refused scenes + `refused-prompt-N.txt` + imageEmpty alert (1.3, 4/5 refusal) |
| `mock:error` | the request is answered with **HTTP 400** | error slot / failure alert path |

> **Storyboard-direct hint:** put the trigger in **Additional rules** — for `storyboard-direct`
> it is appended to BOTH the one-shot batch prompt and each per-scene prompt, so
> `mock:per-scene` cleanly forces the batch→fallback path there. In the planned use cases
> the Additional-rules text reaches the batch prompt; per-scene fallback prompts (which do
> not repeat it) then answer normally with 1 picture each.
> For a SINGLE-picture use case (`render-node` etc.), `mock:configured`-style triggers do not
> apply to the batch (it is already 1) — use `mock:refuse` / `mock:error` there.

The mock also answers **`POST /images`** (OpenRouter-Images shape, `{ model, prompt, n }`) so
the transport's `/images` fallback path works against it too.

---

## 4. Environment A — the real app

### 4.1 Run it

```bash
# Electron dev (builds API + ng serve on 4200 + Electron):
npm run electron:dev

# or browser-only:
#   terminal 1:
npm run build:server
node chapterdesk-api-server/dist/server.js        # API on http://127.0.0.1:3847
#   terminal 2:
npm start                                          # ng serve on http://localhost:4200
```

### 4.2 Where the data really lives

| Mode | Data location |
| --- | --- |
| Electron | `~/.config/chapterdesk/data/chapterdesk.sqlite` (+ `-wal`, `-shm`) — set via `app.getPath('userData')` in `electron/main.js` |
| Browser-only (this repo) | `chapterdesk-api-server/data/chapterdesk.sqlite` (same trio of files) |
| Browser IndexedDB mode (`CHAPTERDESK_STORAGE=chats-idb` / `chats-params-idb`) | IndexedDB in the browser profile |
| **Trap** | `chapterdesk-api-server/data/chapterly.sqlite` is an OLD unrelated DB — patching it changes nothing you see |

**You typically also carry state in browser/Electron storage** (settings, dialog memory,
usage totals) — see the reset table in §5.2.

---

## 5. Resetting to the original state

### 5.1 Environment B (E2E stack) — one command

Because the API is `PERSISTENCE=memory`, `down` discards everything:

```bash
docker compose -f docker-compose.e2e.yml down   # wipe all data
npm run e2e:serve                                # fresh seeded state
```

(Also useful: clear browser storage for `127.0.0.1:8081` in DevTools → Application → Storage
→ Clear site data, to reset the Chrome-side localStorage/IndexedDB.)

### 5.2 Environment A (real app)

**Full reset — SQLite:**

```bash
# 1. quit ChapterDesk/Electron and stop the API server
# 2. back up (safe): copy the trio, or checkpoint first
mkdir -p ~/chapterdesk-backups
cp ~/.config/chapterdesk/data/chapterdesk.sqlite{-wal,-shm,} ~/chapterdesk-backups/ 2>/dev/null || true
# 3. remove the DB (the app recreates an empty one on next start)
rm -f ~/.config/chapterdesk/data/chapterdesk.sqlite{-wal,-shm,}
```

For the browser-only repo server, replace the path with
`chapterdesk-api-server/data/chapterdesk.sqlite`. If the server is running, SQLite keeps the
file open — stop the server first, or snapshot with `sqlite3 … "PRAGMA wal_checkpoint;"`
(follow `PRAGMA busy_timeout=5000;` first).

**Full reset — IndexedDB mode:** DevTools → Application → IndexedDB → delete the
`chapterdesk` databases, or clear site data.

**Partial reset — browser/Electron storage (per-`it` hygiene):** the app remembers lots of
things in localStorage. Clear these (or use “Clear site data”) before a run that depends on
defaults:

| Key(s) | Holds | Clears |
| --- | --- | --- |
| `chat.demoData.loadedV1` | demo-load marker | re-offers demo |
| `chat.illustrateOptions.v1` | illustrate dialog memory (incl. `historyMode`, `historyNodes`, `storyboardHistoryNodes`) | dialog defaults |
| `chat.createImage.constantByChatId` / `chat.createImage.imagesByChatId` / `chat.createImage.model.v1` | create-image dialog memory | dialog defaults |
| `chat.prependByNodeId` | per-node prepend-used flag | prepend re-enable |
| `chat.chapterDescriptions.paramsByChatId` / `chat.chapterDescriptions.model.v1` | chapter-descriptions memory | dialog defaults |
| `chat-client.elaborate.byChatId` | elaborate last chapter/characters per chat | elaborate defaults |
| `chat.sort.prefs` | sort mode per page | default ordering |
| `chat-client.navbar.height.*`, `sidebar width` | per-chat UI layout | default layout |
| `chat-client.chat.usage.*` | per-chat cost totals | Σ usage reset |
| `chat.nodeClipboard.v1` | copy/cut/paste clipboard | empty paste group |

**Snapshot / reproduce “safe”** (do not touch your main DB): copy the trio to a scratch dir,
start a second API on another port (`PORT=3901 … node …/dist/server.js`), and drive it with
curl (the browser always lands on 3847). Work on the copy, keep the original intact.

### 5.3 Reset checklist used before every use-case pass

1. Reset environment (B: compose down+up; A: delete DB or clear site data).
2. If B: open `http://127.0.0.1:8081`. If A: start API + app.
3. Load test data — “Load demo” on the Import page (or confirm the empty-workspace auto-load).
4. Press **“Add mock provider”** — this registers **Mock Writer** (text) **and** **Mock Image**
   (pictures) and defaults the generation tasks (incl. **Image creation → Mock Image**);
   both are key-free. (In Docker the demo bootstrap does this for you.)
5. Clear the dialog-memory keys above so each dialog opens with defaults.

---

## 6. Screen map — where the elements are

All labels below are the **English UI text** (EN catalog). The app also ships German — text
differs, the position/behaviour does not. **Hierarchy:** left **navbar** (all nodes) → main
**tree** (the active path only) → a **node card** per section → **footer buttons** per card →
**editor** (when you edit) → **right-click context menu** per card → **dialogs** (modeless
over the tree) → **top toolbar** (chat-wide actions).

### Toolbar (chat page, top of the main pane)

| Element | Label | Opens / does |
| --- | --- | --- |
| Reader view | “Reader view” (or icon) | the book view |
| Title | “Title” | `structure-title` for the whole story |
| Introduction | “Introduction” | `structure-overview` |
| Headings | “Headings” | `structure-headings` (all chapters) |
| Elaborate | “Elaborate” | the elaborate dialog (only enabled when there is a last answer) |

### Node card (in the tree)

- Header row: the role badge **“Direction”** / **“Chapter”** / **“Structure”**; **“v{n}”**
  (version); **“{n} chars”**; the branch switcher **“‹ {cur} / {total} ›”** (previous/next
  continuation); then buttons:
  - **“Heading”** — generates a heading for this chapter (`structure-heading`),
  - **“Remove Section”** — delete only this section,
  - **“Delete Continuation”** — delete this section + following text.
- While an answer is generating, the card header instead shows **“Stop”** and
  **“Finish & stop”**; the card body grows live with the streamed text.
- Attachments live on the card (thumbnails for pictures, file chips for the `prompt-N.txt` /
  `refused-prompt-N.txt` / `image-description.txt` files the app adds).

### Footer buttons (bottom of a node card)

| Visible on | Label | Use case |
| --- | --- | --- |
| Chapter (assistant) | **“Regenerate”** | `send-regenerate` |
| Chapter (assistant) | **“Rewrite in place”** | `send-rewrite` |
| Chapter (assistant) | **“Illustrate”** | opens the Illustrate dialog (1–5) |
| Chapter (assistant) | **“Create image”** | `image-send` (needs marked text first) |
| Direction (user) | **“Chapter descriptions”** | `send-chapter-descriptions` dialog |
| Direction (user, answered) | **“Prepend”** | `send-prepend` dialog |
| Direction (user, empty closed leaf) | **“Continue”** / **“Switch characters”** (with a **− n +** repeat counter) | auto directions |
| All | **“Edit”** (pencil) | opens the in-place editor |

### Editor (replaces the card content while editing)

- Placeholders: **“Write the next direction…”** (leaf/composer) or **“Edit this section…”**.
- Buttons above the box: **“Check my English”** (`language-check`), **“Rewrite”**
  (`rewrite-selection`), **“Show Preview” / “Hide Preview”**.
- Buttons below the box:
  - unsent leaf: **“Send”** (`append`), **“Chapter descriptions”**, then (when empty)
    repeat counter **− n +**, **“Continue”**, **“Switch characters”**;
  - existing section: **“OK”** (save a version — no LLM), **“Continuation”**
    (`send-branch`), **“Insert”** (`send-insert`).
- Hint in the box: `Ctrl+Enter` sends/saves, `Ctrl+S` saves, `Esc` cancels.

### Right-click context menu (on any node card)

**“Copy” · “Edit” · “Rewrite selection…” · “Prior versions” · “Continue” · “Switch characters”
· “Add heading” · “Regenerate” · “Rewrite in place” · “Illustrate” · “Create image of
selection…” · “Prepend director” · “Chapter descriptions…” · “Exclude from model context” ·
“Remove section” · “Delete section & following”.** Each is the same action as the footer/
toolbar button with the matching name.

### Illustrate dialog

| Element | Label(s) | Purpose / maps to |
| --- | --- | --- |
| Model | select, first option **“Default (from settings) — {model}”**, then image models | which image model |
| Use case | radio **“Plan descriptions first (text model)”** / **“Direct to image model”** / **“Pure picture mode (descriptions only)”** | → planned / direct (storyboard-direct) / pure (always plans) |
| Number of pictures / scenes | number input (1..64) | `count` |
| Story text to use | radio **“Current text only”** / **“Last beats up to this point”** (+ inline number, disabled until picked) / **“All story text up to this point”** | → render-node / render-window / render-full |
| Additional rules | textarea (placeholder “Optional: extra instructions…”) | storyboard prompt |
| Style | single-line input (placeholder “e.g. comic style, ink, watercolor…”) | style |
| Confirm | **“Generate”** | runs the use case |

> The dialog opens with the LAST used settings (memory per `chat.illustrateOptions.v1`).
> All three “Use case” radios AND the “Story text to use” radios are always visible, even
> for count=1.

### Other dialogs

| Dialog | Fields & confirm button |
| --- | --- |
| **Director instruction** (prepend) | hint text, one textarea (placeholder “How the following events and actions occurred…”), **“Use this instruction”** |
| **Create chapter descriptions** | “Number of chapters”, “Sentences per description”, “First chapter number”, “Model”, “What the chapters should achieve”, **“Send & generate”** |
| **Create image** | “Constant for this chat”, “Marked text”, “Reference images (optional)” + **“Add image”**, “Model”, **“Create”** |
| **Rewrite selection** | “Marked text”, “Directions (optional)”, “Model”, “Context the model should consider” (**No context / The current node / Up to the marked part / The whole text**), **“Rewrite”** + **“Use my edited text”**; suggestions render as **① Minimal · ② Clearer · ③ Rewritten** each with **“Use this”** |
| **Elaborate chapters** | “First chapter”, “Last chapter”, “Chapter number prefix”, “Characters”, “Hints”, **“Stick to last chapter”** (checkbox), “Model”, a “Prompt preview”, **“Elaborate”** |
| **Illustrate** | see table above, **“Generate”** |

### Browser alerts (native dialog — check the text!)

| Trigger | Alert text (EN) |
| --- | --- |
| No image model enabled | “No image model is enabled. Choose one in Settings → Generation tasks.” (`node.imageModelMissing`) |
| No chapter to attach to | “There is no chapter yet to attach the picture to. Send the direction first.” (`node.imageNoChapter`) |
| Zero pictures | “The model returned no picture” (`node.imageEmpty`), with the model reply appended |
| Partial storyboard | “Only {got} of {want} pictures were created.” (`node.imagePartial`) |
| Image failure | “Picture generation failed: {error}” |

### LLM log page

Nav item **“Logs”** (route `/logs`). One card per request: time, use case, model/provider,
token usage/cost, streaming badge, and expandable **request** (the exact messages sent) and
**response**. This is where you verify *what the app really sent* per use case.

---

## 7. The checklists

Legend: **Prep** = what the screen must look like first (including dialog settings),
**Do** = exactly which screen element to operate, **Expect** = what must appear on the screen
(and, where noted, in the **Logs** page) for the check to pass.

> Wordbook (from the README): you write a **Direction** (user node), you read back a
> **Chapter** (assistant node). “Illustrate” is the button on the chapter footer.

### 0. Frame setup — do once before every pass

1. Reset (§5). 2. Open the app. 3. **Import** page → **“Built-in demo”** section → press
   **“Load built-in demo”** (it turns into “Demo workspace already loaded”). 4. On the same
   page press **“Add mock provider”** (registers **Mock Writer** for text AND **Mock Image**
   for pictures, and defaults the task models — key-free). 5. Open the demo story and
   verify a last chapter is selected in the tree (the canvas must be non-empty).

**Image sections (7.1 D1–D7, 7.2–7.5, 7.12) run against “Mock Image”** after step 4 — no
provider key needed; every render returns a small SVG (colours/captions change with the
prompt, and the `mock:…` triggers in §3.5 force partial/refused/fallback/error paths). The
“No image model is enabled” alert now only occurs when you deliberately unset the Image
creation task (D8).

### 7.1 Dispatch sanity (do first, every pass)

> **Image use-case prerequisite — how the mock provides an image model now.**
>
> Illustrate needs a model that **generates images** (`canGenerateImages`). **“Mock (no key)”*
> now provides TWO models: **Mock Writer** (text-only) and **Mock Image** (image-capable).
> After pressing **“Add mock provider”**, the **Settings → Generation Tasks → “Image
> creation”** card is prefilled with **Mock Image**, so Illustrate works out of the box and
> returns a small SVG picture per request (see §3.5 for content-triggered behaviour +
> `mock:…` triggers).
>
> The alert **“No image model is enabled. Choose one in Settings → Generation tasks.”**
> therefore only occurs when you have **no** image-capable model — for example when the mock
> was never added, or after you **Reset** the “Image creation” card / disabled all image
> models. That is the deliberate negative check **D8**.
>
> **Screen path if you ever need to configure/restore it:**
> 1. **Settings** (left nav) → subm-nav tab **“Generation Tasks”** → **“Image creation”** card
>    (i18n `config.generation.tasks['image-create']`).
> 2. Set the **Provider** select to **“Mock (no key)”** and the **Model** input to
>    **`mock-image` / Mock Image** (the datalist lists only enabled image-capable models;
>    if it says “No enabled models for this provider…”, enable Mock Image under **Settings →
>    “Providers / Models”**).
> 3. For the negative check (D8) use the card's **Reset** button to unset it, then redo it.

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| D1 | chapter selected; image model configured (§7.1 prerequisite — normally **Mock Image** after “Add mock provider”) | click chapter footer **“Illustrate”** | dialog opens with title “Illustrate”; you see Model, the three **Use case** radios, **Number of pictures / scenes**, the three **Story text to use** radios, **Additional rules**, **Style** and the **“Generate”** button |
| D2 | image model configured (Mock Image) | set count **1**, Use case **“Direct to image model”**, Story text **“Current text only”** → **“Generate”** | picture (small SVG) appears on the chapter; **Logs**: 1 request titled `render-node`, messages = instruction + scene text only |
| D3 | — | count **1**, “Last beats up to this point” = **2** → **Generate** | **Logs**: request `render-window`; history contains exactly the previous 1 assistant chapter |
| D4 | — | count **1**, Use case **“Pure picture mode (descriptions only)”** → **Generate** | card header shows **“Stop”**; **Logs**: 2 requests — planning (contains “The beat to depict is: …”), then render; render sees only derived descriptions |
| D5 | — | count **3**, Use case **“Direct to image model”** → **Generate** | **Logs**: 1 request (`storyboard-direct`), no planning |
| D6 | — | count **3**, Use case **“Plan descriptions first”**, story text whatever → **Generate** | **Logs**: planning request (`planned-scenes` templates) then render |
| D7 | — | count **3**, “Plan descriptions first” but the image model accepts only one call — use single picture scope | see 2.1 for the en-block variant; **Logs** show `planned-enblock` when pure/single |
| D8 | “Image creation” model **unset** (Reset button on the card) or all image models disabled | click **“Illustrate”** | native alert **“No image model is enabled. Choose one in Settings → Generation tasks.”**; nothing else happens; afterwards **restore** Mock Image (§7.1 note) |

### 7.2 Use case 1 — storyboard-direct (count>1, no planning)

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 1.1 | image model returns several pictures | Illustrate → count **3**, Use case **“Direct to image model”**, some **Additional rules** → **Generate** | **Logs**: exactly **1** render request. Chapter shows **3** pictures + chips `illustration-1..3` and `prompt-1.txt`…`prompt-3.txt` |
| 1.2 | model returns only 1 of 3 | same | alert **“Only 1 of 3 pictures were created.”**; chapter keeps the 1 picture + 1 prompt chip (no loss) |
| 1.3 | model refuses all | same | alert **“The model returned no picture”** (+ reply); chapter has `refused-prompt-1..3.txt` chips, no pictures |
| 1.4 | three-scene run started | press **“Stop”** in the card header mid-run | run ends; pictures already attached stay; the **“Stop”** button disappears; toolbar no longer shows an active generation |

### 7.3 Use case 2 — planned-enblock

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 2.1 | text model (planning) + image model, story with ≥2 beats | Illustrate → count **2**, Use case **“Plan descriptions first”** (NOT pure), Story text “Current text only” → **Generate** | **Logs**: 2 requests — `planned-enblock` planning (contains the beat) then render; the **render** request contains NO raw chapter text, only derived descriptions |
| 2.2 | render returns 0 | same → leave it running | **Logs**: one render request **per scene** (each only its own description); each picture appears on the chapter the moment it is ready; **“Stop”** remains available |
| 2.3 | partial (1..N-1 succeeded) | let it finish | pictures all present on the chapter; a final reprise request appears only when **>1** succeeded |
| 2.4 | planning refuses/times out | let it fall through | no crash; the scene prompts fall back to the raw anchor (check in **Logs**) |

### 7.4 Use case 3 — planned-scenes

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 3.1 | as 2.1 but count **3** and Use case **“Plan descriptions first”** (NOT single-scope) | **Generate** | **Logs**: planning request uses the scene-oriented template (`image.planning-scenes`), render uses `image.one-shot-scenes` — prompts differ from 2.1 |
| 3.2 | batch returns ≥1 picture but < count | **Generate** | use case **stops** — no per-scene requests in **Logs**, no reprise; the returned picture(s) are kept |
| 3.3 | batch returns 0 | **Generate** | per-scene fallback fills every scene (Logs: N requests); each picture attaches immediately |

### 7.5 Use cases 4 / 4b / 5 — render-full / render-window / render-node

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 5.1 | chapter selected | Illustrate → count **1**, Use case “Direct to image model”, Story text **“Current text only”** → **Generate** | **Logs**: `render-node`; request body = instruction + “… to illustrate:” + scene text, **no** history messages |
| 4b.1 | story with ≥4 assistant chapters | count **1**, Story text **“Last beats up to this point” = 4** → **Generate** | **Logs**: `render-window`; history = the last **3** assistant chapters only (user directions/lore do not count toward the 4); anchor = current chapter |
| 4.1 | legacy | navigate away + reopen the chat; re-open Illustrate | the **“All story text up to this point”** option is still offered, but after a reload stored `'full'` settings normalize to “Current text only” (`render-node` in Logs) |
| x.2 | model refuses | any render → **Generate** | alert **“The model returned no picture”**; chapter keeps `refused-prompt-1.txt` |

### 7.6 Use cases 6 / 7 — append, append-with-images

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 6.1 | Mock Writer enabled; a trailing leaf composer visible | click the composer (placeholder “Write the next direction…”), type a direction, press **“Send”** | an assistant bubble appears under it and **streams live** (text grows chunk by chunk); when done the chapter is saved with “v” bumped; the editor closes |
| 6.2 | — | send with an empty/refused response | no crash, no empty fragment left dangling (chapter either has content or a “Generation stopped” marker) |
| 7.1 | — | in the leaf composer click **“Add attachment”** (paperclip), pick an image, then **“Send”** | **Logs**: first a **non-stream** interpret request (text), then the streaming answer; the **direction node text** now reads “{direction} + automatically generated image description”; the chapter’s attachment chips include `image-description.txt` |
| 7.2 | after 7.1 | edit + **“Send”** the same direction again | **Logs**: **no** interpret request (description already stored) |
| 7.3 | change the image / remove the record | **“Send”** again | **Logs**: interpret request runs again |

### 7.7 Use case 8 — send-branch

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 8.1 | open a **question** node for editing | press **“Continuation”** under the editor | a new **sibling** question appears next to it with a streaming answer under it; the branch counter **“‹ n / m ›”** reflects the new sibling count |
| 8.2 | open an **assistant** (chapter) node for editing | press **“Continuation”** | a new **child question under the chapter** appears (thread continues from that point), answer streams under it |
| 8.3 | editor has a different model selected (its own model dropdown) | **“Continuation”** | **Logs**: new question + writer use the model from the editor, not the node’s |

### 7.8 Use case 9 — send-insert

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 9.1 | a question with a sibling and a mounted branch | open it, press **“Insert”** | the **editor closes immediately**; the stream is **visible in the tree from the start** (active path switches before streaming); when done the old sibling(s) sit **under the new answer** |
| 9.2 | three siblings, insert the middle one | **“Insert”** on the middle | all siblings (including yours) hang under the fresh answer; the leaf you inserted stays the active child |

### 7.9 Use cases 10 / 11 — send-regenerate / send-rewrite

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 10.1 | a chapter with following text and an image | chapter footer **“Regenerate”** → confirm the dialog | whole subtree disappears; a fresh answer streams under the same question; **no** old attachments on the new chapter |
| 10.2 | a chapter with children | **“Regenerate”** → confirm (dialog warns it deletes following text) | children are gone too (subtree delete) |
| 11.1 | a chapter with following text | footer **“Rewrite in place”** → confirm (dialog shows “{n} following text(s)”) | only that chapter is replaced; following text remains and hangs under the **new** version |
| 11.2 | chapter has `illustration-1` | **“Rewrite in place”** with the model producing a new image | fresh chapter shows **both** `illustration-1` (kept) and `illustration-2` (new) |

### 7.10 Use case 12 — send-prepend

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 12.1 | a direction that is not the composer | footer **“Prepend”** → dialog **“Director instruction”**, type text, **“Use this instruction”** | a new direction (the director) appears **above** the current one, with a streamed result; the original direction is adopted **under** that result |
| 12.2 | — | open prepend and confirm with an empty textarea | nothing happens / button inactive (no node created) |
| 12.3 | a prepend already used on this node | open prepend again | the flag blocks it (button inactive) or the dialog is not offered again |

### 7.11 Use case 13 — send-elaborate

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 13.1 | a last answer exists | toolbar **“Elaborate”** → set First=1 Last=2 (no names) → **“Elaborate”** | chapter 1 gets a question + answer under the visible last answer; chapter 2’s question appears **under chapter 1’s answer** (chain) |
| 13.2 | an empty user leaf exists under the anchor | **“Elaborate”** | the empty leaf is **reused** (filled with the prompt), not duplicated |
| 13.3 | — | pick a non-default **Model** in the dialog → **“Elaborate”** | **Logs**: every request uses the chosen model (override wins) |
| 13.4 | 2-chapter run started | press **“Stop”** (or **“Finish & stop”**) after chapter 1 completes | chapter 1 stays; no further chapters run; no error alert |
| 13.5 | after 13.1 | re-open **“Elaborate”** | **First chapter** = last+1, **Characters** restored from the last run |

### 7.12 Use case 14 — image-send (“Create image of a selection”)

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 14.1 | select text in a chapter (drag over words) | chapter footer **“Create image”** → dialog shows the marked text → **“Create”** | **Logs**: exactly the constant + marked text sent AS-IS (no planning, no drawing instruction); picture attaches under the chapter |
| 14.2 | — | in the dialog press **“Add image”**, pick a reference → **“Create”** | **Logs**: the request carries the reference as an `image_url` part together with the text |
| 14.3 | model refuses | **“Create”** | refused result with the model’s reason surfaced (alert/log) |

### 7.13 Use cases 15–18 — structure (title / overview / heading / headings)

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 15.1 | a story with chapters | toolbar **“Title”** | a **Structure** card appears at the very top holding the title; the chat tab/sidebar **title** changes to it |
| 15.2 | title exists | toolbar **“Introduction”** | an intro **Structure** card right **under** the title; without a title it becomes the first node |
| 17.1 | one chapter | chapter header **“Heading”** (or ctx “Add heading”) | a **Structure** heading card wraps the chapter; if a heading card already exists it is **patched** (content replaced) |
| 18.1 | several unheaded chapters | toolbar **“Headings”** | heading cards appear in chapter order (check insertions between chapters); already-headed chapters keep their heading and are not regenerated |
| 18.2 | multi-chapter run started | press **“Finish & stop”** mid-run | the in-flight heading is still saved; the run stops before the next chapter |
| 18.3 | model returns empty | **“Headings”** with empty reply | error alert; no broken half-created heading |

### 7.14 Use cases 19 / 20 — language-check / rewrite-selection

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 19.1 | a direction is being edited | press **“Check my English”** (above the editor) | the editor shows **① Minimal · ② Clearer · ③ Rewritten** variants; the tree is **unchanged** (no new nodes) |
| 20.1 | select text | press **“Rewrite”** → dialog → pick a **Context** mode → **“Rewrite”** | the variants area streams in with live progress; **Logs** show the context mode chosen (none/node/upto/whole changes the body) |
| 20.2 | nothing selected / empty | open rewrite with empty selection | friendly message (“Mark the text to rewrite first”), no request |

### 7.15 Use case 21 — send-chapter-descriptions

| # | Prep | Do | Expect |
| --- | --- | --- | --- |
| 21.1 | last node is an empty leaf (the composer) | footer **“Chapter descriptions”** → dialog **“Create chapter descriptions”** → **“Send & generate”** | a **sibling** branch question streams the numbered list; the empty leaf with **“Continue”** stays untouched |
| 21.2 | — | set **Number of chapters=3**, **Sentences per description=2**, **First chapter number=5**, **Goal** text → **“Send & generate”** | **Logs**: the request contains those exact parameter lines and ends with “Return only the chapter list, starting at chapter 5.” |
| 21.3 | rerun | re-open the dialog | last params are prefilled with **First chapter number** = previous first + count (continue) |

---

## 8. After a run — filling in the results sheet

For each check, record:

- **Environment** (A/B), **DB reset** done?, **dialog memory cleared**?
- **Use case**, the exact dialog settings (count, use-case radio, story-text radio, style,
  additional rules, model) — read them off the dialog before confirming.
- **What you saw** vs **Expected** — name the exact screen element (button/dialog field/alert
  text/Logs entry) that matched or differed; paste the relevant **Logs** request.

If you find a failure:

1. Note the use case + dialog settings + the LLM-log request excerpt.
2. Try to reproduce on Environment **B** (deterministic seed, one-command reset).
3. For image flows, also test with a **known-good image model** to separate app bugs from
   provider/model quirks (a text-only model legitimately fails early).
4. If it involves a mid-run **Stop**, restart the app and confirm the run is not stuck
   (no frozen spinner, no lingering **“Stop”**, no dangling “Generation stopped” bubble).

---

## 9. Quick reference — commands & paths

| Action | Command / path |
| --- | --- |
| Run E2E stack | `npm run e2e:build && npm run e2e:serve` → http://127.0.0.1:8081 |
| Reset E2E stack | `docker compose -f docker-compose.e2e.yml down` |
| Run Electron dev | `npm run electron:dev` |
| Run browser + API | `npm run build:server && node chapterdesk-api-server/dist/server.js` + `npm start` |
| Real Electron DB | `~/.config/chapterdesk/data/chapterdesk.sqlite` (`-wal`, `-shm`) |
| Repo SQLite (browser-only) | `chapterdesk-api-server/data/chapterdesk.sqlite` |
| Load demo (on demand) | **Import** page → **Load demo** |
| Server-side LLM mock | `chapterdesk-api-server/src/http/mock-llm.ts` (text only; register **Mock (no key)**) |
| LLM log UI | **Logs** nav page (route `/logs`) — per-request model/messages/stream |
| Reset app memory | DevTools → Application → Clear site data (covers localStorage + IndexedDB) |