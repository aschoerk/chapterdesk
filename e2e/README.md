# ChapterDesk E2E tests (Playwright, Docker single-origin)

Browser-driven tests that **control the real UI** so you don't have to repeat
usecases by hand. The workflow:

> **Record** real usecase-steps once (by hand or via codegen) → **save** them as
> reusable step helpers → **parameterize** the steps over data tables so the
> same usecase runs repeatably for every scenario.

---

## The test stack (why Docker)

One Docker container serves **SPA + API + LLM proxy on a single origin**:

```
http://127.0.0.1:8081
   ├─ /                the Angular SPA (dist/chat/browser)
   ├─ /api/*           chapterdesk-api-server (memory, seeded from JSON)
   └─ /proxy/chat/completions   LLM calls (intercepted by the browser mock)
```

Single origin means **no CORS allowlist, no `?port=` query param, no hash-router
surprises** — the Angular client resolves `apiBase`/`proxyBase` from
`window.location` and everything just works. The API runs in **memory
persistence seeded from `e2e/fixtures/seed.json`** (`PERSISTENCE=memory` +
`CHAPTERDESK_SEED_FILE`), so every run starts from the same deterministic data.

---

## One-time setup

```sh
npm install            # @playwright/test is a dev dependency
npm run e2e:build      # builds API dist + SPA + the chapterdesk-dev image
npm run e2e:install    # one-time: download Playwright browsers  (npx playwright install chromium)
```

`npm run e2e` then:

1. starts the Docker stack (`docker compose -f docker-compose.e2e.yml up`),
2. waits for `http://127.0.0.1:8081/api/health`,
3. runs the specs in `/e2e/tests`.

Sanity-check the seeded stack manually:

```sh
npm run e2e:serve      # keep it running in a terminal
curl -s http://127.0.0.1:8081/api/projects   # → demo project
# open http://127.0.0.1:8081 in a browser
```

> Note: the seeded data lives in the container's ephemeral memory — recreate
> the container (`docker compose -f docker-compose.e2e.yml down`) to reset.

---

## How the LLM is simulated (wiremock-style)

The UI streams answers from `POST {proxyBase}/chat/completions`. Instead of a
real provider, `e2e/support/llm-mock.ts` intercepts that request in the browser
(`page.route('**/proxy/chat/completions')`) and fulfills it with canned SSE —
exactly like a wiremock.

```ts
await mockLlm(page, { answer: ['The hero is Ada.'] });
await askQuestion(page, 'Who is the hero?');
await expectNodeText(page, 'The hero is Ada.');
```

`mockLlm` returns a log of every request it saw, so assertions can check which
model/provider/messages the UI actually sent.

---

## The record → parameterize workflow

### 1. Record the steps (one time)

**Option A — by hand:** `npm run e2e:serve`, open `http://127.0.0.1:8081`, do the
usecase, note the steps.

**Option B — Playwright Codegen:**

```sh
npm run e2e:serve      # terminal 1: docker stack
npm run e2e:codegen    # terminal 2: records your clicks into a spec skeleton
```

### 2. Promote the steps to helpers

Put each recorded step behind a named function in `e2e/support/ui.ts`
(e.g. `newStory`, `askQuestion`, `expectNodeText`). Tests then read like prose.

### 3. Parameterize (make it repeatable)

```ts
const scenarios = [
  { project: 'Demo Project', question: 'Who is the hero?', answer: 'The hero is Ada.' },
  { project: 'Demo Project', question: 'Where does it happen?', answer: 'In a floating castle.' },
];

for (const s of scenarios) {
  test(`create a story and ask: "${s.question}"`, async ({ page }) => {
    await mockLlm(page, { answer: [s.answer] });
    await openApp(page);
    await newStory(page, s.project);
    await askQuestion(page, s.question);
    await expectNodeText(page, s.answer);
  });
}
```

One recorded usecase → a repeatable matrix. Adding a scenario = one row.

---

## Layout

```
e2e/
  fixtures/seed.json      # deterministic backend state (memory persistence)
  support/
    llm-mock.ts           # wiremock-style /proxy/chat/completions + /proxy/images
    ui.ts                 # reusable recorded steps (helpers)
    config.ts             # /config/* settings page helpers (+ /proxy/models mock)
  manual/                 # USER-MANUAL generator (NOT part of the test suite)
    manual-*.spec.ts      # one manual chapter per feature area (see below)
    manual-support.ts     # newManual() + API-based cleanup helpers
    build-index.mjs       # generate docs/manuals/index.md (table of contents)
    wiki-export.mjs       # push docs/manuals into the GitHub wiki (Home.md)
  tests/                  # one file per usecase-template
    chat-create-navigate.spec.ts
    llm-orchestration-text.spec.ts    # UC6–13, UC15–21 (text/flows)
    llm-orchestration-images.spec.ts  # UC1–5, UC14 (illustrate / image-send)
    topics-crud.spec.ts / projects-crud.spec.ts / personas-crud.spec.ts
    sidebar-chat-move.spec.ts         # move stories between books (buttons/drag)
    node-nav-bar.spec.ts / node-context-menu.spec.ts
    readonly-navigation.spec.ts       # the /read book view
    trash-usage.spec.ts               # soft-delete → restore / purge
    settings-appearance.spec.ts       # theme + language (localStorage)
    settings-providers.spec.ts        # provider/preset CRUD, test, fetch, filters
    settings-generation-tasks.spec.ts  # per-task provider/model/prompt + reset
    settings-prompts.spec.ts          # versions: save/edit/rename/delete, topic scope, reset-all
docker-compose.e2e.yml    # single-origin test stack (memory + seeded)
```

## Generating the user manual (Markdown + screenshots)

The `e2e/manual` scenarios drive the REAL UI step by step and record an
annotated screenshot per step using **playwright-scenario-recorder**. They
share the exact same Docker stack + support helpers as the assertion suite, so
the screenshots show the real app.

```sh
npm run docs:manual        # run the 11 manual scenarios → docs/manuals/*.md + screenshots/
npm run docs:manual:index  # regenerate docs/manuals/index.md (table of contents)
npm run docs:manual:full   # both of the above
```

- Output lands in `docs/manuals/` (git-ignored — it is a regenerated artifact).
- `docs/manuals/index.md` is the entry point; every chapter embeds its
  `screenshots/<chapter>/step-NN.png`.
- Scenarios are deterministic: they use the seeded story / mock LLM and each
  cleans up after itself (API-based deletes avoid flaky UI races in teardown).

### Publishing to the GitHub project wiki

The manual can be pushed to the repo's GitHub wiki as separate pages, with the
screenshots committed alongside them (GitHub wikis need images inside the wiki
repo, not remote URLs):

```sh
npm run docs:manual:wiki   # docs:manual:full + node e2e/manual/wiki-export.mjs
node e2e/manual/wiki-export.mjs --dry-run   # build pages locally, don't push
```

The wiki remote is derived from `git remote get-url origin`
(`…/chapterdesk.git` → `…/chapterdesk.wiki.git`; the legacy `chapterly` repo
name is normalized to `chapterdesk`); override with `WIKI_REMOTE=…`.
It clones the wiki into `.wiki-stage/` (git-ignored), rewrites the image paths
to wiki-relative `screenshots/…`, writes a `Home.md` index, then commits +
pushes every chapter page.

> First-time setup: the wiki must exist before export — open the repo on
> GitHub → **Wiki** → **Create the first page**. After that, `docs:manual:wiki`
> fully replaces its content on every run.

## Editing the seed

`e2e/fixtures/seed.json` is a `PersistenceSnapshot`:
`{ topics: [TopicSnapshot], providers: [ProviderSnapshot] }`. Change the demo
project/chat/nodes there to shape what a fresh run starts from. The API server
imports it via `CHAPTERDESK_SEED_FILE` (see
`chapterdesk-api-server/src/persistence/factory.ts`).

The provider ships THREE enabled preset models so every LLM-orchestration use
case resolves a model in environment B:

| modelId | displayName | architecture | used by |
| --- | --- | --- | --- |
| `mock-model` | Mock Model | — (text) | default writer (`append`, flows, planning) |
| `mock-image` | Mock Model Image | `input [text,image]`, `output [image,text]` | Illustrate render (UC1–5) + `image-send` (UC14) |
| `mock-vision` | Mock Model Vision | `input [image]`, `output [text]` | image interpretation (`append-with-images`, UC7) |

`enabledModels()` sorts by display name, so `Mock Model` stays the default
writer while `Mock Model Image` / `Mock Model Vision` remain reachable for the
image render and interpret steps.

## Rebuilding after source edits

The compose mounts `chapterdesk-api-server/dist` and `dist/chat/browser`, so after
editing app/server sources, rebuild before re-running:

```sh
npm run build:server   # chapterdesk-api-server/dist
npx ng build           # dist/chat/browser
```

(Dockerfile.dev bakes a build too, but the mounts take precedence in this stack.)

## LLM-orchestration specs

- `llm-orchestration-text.spec.ts` — every text use case against the real UI:
  `append` (6), `append-with-images` (7), `send-branch` (8), `send-insert` (9),
  `send-regenerate` (10), `send-rewrite` (11), `send-prepend` (12),
  `send-elaborate` (13), `structure-title/overview/heading/headings` (15–18),
  `language-check` (19), `rewrite-selection` (20),
  `send-chapter-descriptions` (21). Each seeds a fresh story, drives the exact
  button/dialog, and asserts the DOM outcome (new node text, structural node,
  alert text, branch count…).
- `llm-orchestration-images.spec.ts` — the Illustrate use cases against the
  real dialog: `storyboard-direct` (1), `planned-enblock` (2),
  `planned-scenes` (3), `render-full` (4), `render-window` (4b),
  `render-node` (5) and `image-send`/“Create image of selection” (14). The
  wiremock answers render calls with deterministic `image_url` parts and
  planning calls with a `{pictures:[…]}` completion, so each run lands real
  thumbnails (asserted by `expectImageThumbs`).

### Mocking multi-call use cases

`append-with-images` (interpret → stream), `planned-enblock` /
`planned-scenes` (planning → render) and storyboard fallbacks need different
answers per call. Use `mockLlmScripts(page, [script1, script2, …])` — each mock
consumes the next script (the last one repeats):

```ts
await mockLlmScripts(page, [
  { planning: 2 },  // call 1: planning pass returns 2 descriptions
  { images: 2 },    // call 2: render returns 2 picture parts
]);
```

### Verify the new specs

```sh
npm run e2e                 # full suite (builds + starts the stack)
# or a single spec:
npx playwright test e2e/tests/llm-orchestration-images.spec.ts
```

## Settings specs

The four `/config/*` pages are covered by `settings-*.spec.ts`:

- `settings-appearance.spec.ts` — theme (System/White/Dark, resolved on
  `<html data-theme>`, persisted in localStorage) and language (en↔de,
  re-labels the UI, persisted). Both are per-browser-context, so no cleanup.
- `settings-providers.spec.ts` — provider CRUD (masked key), required-API-key
  alert, connection test ok/fail, fetching a mocked model catalog into the
  table, provider filter, preset CRUD with modality chips, model search and
  enabled/disabled filters. Providers/presets live on the shared API, so tests
  use `uniqueName()` and delete what they create (like the entity-CRUD specs).
- `settings-generation-tasks.spec.ts` — per-task provider/model/prompt is
  localStorage; the Docker bootstrap pre-fills authoring tasks with the
  key-free mock writer, and Reset returns a task to inherit/empty.
- `settings-prompts.spec.ts` — save-as-version (user + topic scope), edit the
  active version (Save changes), rename/delete versions, unknown-token warning,
  revert-to-default and Reset all. Versions live in the shared DB and are
  deleted per test.

The provider "Test"/"Fetch Models" calls go through the backend `/proxy`; they
are mocked in-browser by `mockProviderModels()` (config.ts) returning
`{ "data": [...] }` — deterministic connection checks.

## Tips

- `fullyParallel: false` + `workers: 1`: one seeded in-memory API is shared;
