# ChapterDesk UX Playbooks

**Version:** 1.1
**Date:** 2026-10-26
**Purpose:** Structured UX guidance for designing, evaluating, and improving the ChapterDesk local writing studio. These playbooks are derived from the project’s README, wiki structure, E2E test coverage, and core user flows (Topics → Environments → Stories → Directions → Chapters).

## Playbook Index

1. [Onboarding & Time-to-First-Chapter](#1-onboarding--time-to-first-chapter)
2. [Core Story Steering Loop](#2-core-story-steering-loop)
3. [Organization: Topics, Environments, Personas](#3-organization-topics-environments-personas)
4. [Settings, Providers & Trust](#4-settings-providers--trust)
5. [Navigation, Continuity & Book View](#5-navigation-continuity--book-view)
6. [Illustration & Multimodal Moments](#6-illustration--multimodal-moments)
7. [Accessibility, Language & Appearance](#7-accessibility-language--appearance)
8. [Error Recovery & Confidence](#8-error-recovery--confidence)

---

## How to Use These Playbooks

- **Product / Design:** Use the “UX Goals”, “Happy Path”, “Friction Points”, and “Heuristics” sections to audit or redesign flows.
- **Development:** Align implementation with the “Key UI Moments” and “Success Criteria”.
- **Testing:** Convert the scenarios into additional Playwright manual or E2E cases.
- **User Documentation:** Adapt the step-by-step guidance for the wiki. Two sources feed the wiki today: the **curated pages** (Home, install, concepts, FAQ, privacy — hand-written under `e2e/manual/wiki/`) and the **auto-generated chapter pages** (from the E2E scenarios in `e2e/manual/`).

Each playbook ends with measurable success criteria. ChapterDesk is **local-first and ships no telemetry** (see `PRIVACY.md`), so the criteria are framed as **manual usability-test checklists**, not product analytics.

> **Terminology convention:** the user-facing UI uses *Topic / Environment / Story / Direction / Chapter* and *continuation* (not “branch” or “fork”). Keep this wording when anything here becomes user-facing (see the README “Words on the screen” table). Inside these playbooks, “continuation” and “branch/fork” are used interchangeably to describe the same interaction.

---

## 1. Onboarding & Time-to-First-Chapter

### UX Goal
Get a new user from “app launched” to “first readable chapter returned” quickly, with a clear mental model of Topic / Environment / Story / Direction / Chapter — and without forcing an API key on them before they have written anything.

### Happy Path
The first-run experience branches three ways; the user should always be able to *skip* any step and still succeed:

1. Launch ChapterDesk (local server starts automatically).
2. Land on a clear empty or seeded state with a prominent “Start your first story” call-to-action.
3. **Option A — no key, no setup:** choose **“Play with the built-in mock model (no key)”** in the setup wizard (or load the built-in **demo workspace** — “Reader & Editor Tour” + “The Lantern Keeper” — which shows structure, the reader and the editor with no model configured). A first chapter is reachable in seconds.
4. **Option B — bring a provider:** add provider (OpenRouter recommended) → test connection → enable one model → create Topic with example system prompt → create Environment (short setting idea) → attach 1–2 Personas → create Story → enter the first Direction.
5. Streamed chapter appears; the user can immediately give the next direction or switch to Book View.

### Key UI Moments
- Empty state that explains the five concepts without jargon.
- Inline examples (the night-train environment and Mara letter situation from the README).
- Provider token entry with clear “stored only on this machine” reassurance.
- Model catalog fetch with “Mark as preset” affordance.
- The no-key mock / demo path discoverable at exactly the moment a user lacks a key.
- Progressive disclosure: advanced settings hidden until the first chapter is generated.

### Friction Points to Avoid
- Forcing an API key and a long system prompt before any generation.
- Unclear difference between Topic (narrator rules) and Environment (setting).
- Silent failure if no model is selected.
- Overwhelming sidebar on first launch.

### Heuristics Checklist
- [ ] “First chapter” reachable in < 5 min **without an API key** (mock model path).
- [ ] Mental model mapping visible in the UI (or one-click help).
- [ ] Example content can be inserted with one click (demo workspace / sample directions).
- [ ] User can skip guidance and still succeed.

### Success Criteria (manual usability-test checklists — no telemetry)
- [ ] 5/5 testers on a clean machine reach a first chapter in < 5 min using the built-in mock model.
- [ ] In moderated sessions, no tester asks “what is a Topic vs Environment” before their first chapter.
- [ ] A tester with a working API key configures OpenRouter successfully on the first attempt without documentation.

---

## 2. Core Story Steering Loop

### UX Goal
Make the primary loop (Direction → Chapter → next Direction) feel like steering a narrative rather than chatting with an AI. Support continuations without cognitive overhead.

### Happy Path
1. User is inside a Story.
2. Composer (draft leaf) is obvious; user types a short direction.
3. Ctrl+Enter sends; chapter streams in.
4. User can:
   - Continue with a new direction on the same path.
   - Create a continuation / fork from any point.
   - Regenerate, rewrite, elaborate, or insert via context menu.
5. Navigation bar shows the active path clearly.

### Key UI Moments
- Distinction between “Direction” (user cue) and “Chapter” (model draft) in visual hierarchy.
- Streaming indicator that feels progressive, not blocked.
- Context menu (section actions) that surfaces common operations without hunting.
- A continuation creates a visible sibling path; the user can switch between versions (prev/next continuation).

### Friction Points to Avoid
- Treating the interface like a generic chat (history dump, no path awareness).
- Losing the active path when switching stories.
- Branching that feels destructive or irreversible.
- Overly long system prompts leaking into every generation without user control.

### Heuristics Checklist
- [ ] Active path is always visible in the navigation bar.
- [ ] One-keystroke send for experienced users (Ctrl+Enter).
- [ ] Creating a continuation is reversible and labeled.
- [ ] User can stop generation mid-stream (Stop / Finish & stop).

### Success Criteria (manual checklists)
- [ ] In a think-aloud session, users describe the loop as “I am directing the story” rather than “I am chatting with an AI.”
- [ ] A user who has never used the app creates a continuation without asking for help.
- [ ] No lost-work report when switching between continuations.

---

## 3. Organization: Topics, Environments, Personas

### UX Goal
Make Topics, Environments, and Personas the durable spine of longer works while keeping the day-to-day interface focused on Stories.

### Happy Path
- Sidebar or dedicated views for Topics → Environments → Stories.
- Create Topic → paste or choose narrator rules (system prompt).
- Create Environment inside Topic with short setting idea.
- Create Personas and attach them to the Environment.
- Move Stories between Environments when the setting changes (sidebar “Move to another environment”, or drag & drop).

### Key UI Moments
- Clear ownership: Personas belong to Environments; Environments belong to Topics.
- Move / drag-and-drop for Stories between Environments.
- Topic-level default system prompt that can be overridden per Story if needed.
- Search / filter when the library grows.

### Friction Points to Avoid
- Flat list of everything that loses hierarchy.
- Difficulty attaching or detaching Personas.
- No way to see which Stories use which Environment.

### Success Criteria (manual checklists)
- [ ] A user reorganizes a multi-story project without data loss and without assistance.
- [ ] “Create a new Environment + attach a Persona” completes in < 2 minutes on the second attempt, unaided.

---

## 4. Settings, Providers & Trust

### UX Goal
Make provider and model configuration trustworthy, reversible, and non-blocking for the writing flow.

### Happy Path
1. Settings → Providers: add name, base URL, token.
2. Test connection + Fetch Models.
3. Enable desired models; mark one as preset.
4. Per-task overrides (writer, illustrator, etc.) available but optional.
5. Prompt versions can be saved, renamed, and scoped to topic or global.

### Key UI Moments
- Token masked by default; clear “local only” messaging.
- Connection test result visible immediately.
- Model catalog with modality indicators (text, image, vision).
- Reset-to-inherit for task-specific settings.
- Appearance (theme, language) changes apply instantly and persist.

### Friction Points to Avoid
- Silent token validation failures.
- Catalog fetch that hangs without feedback.
- Accidental overwrite of carefully crafted prompt versions.
- Language switch that loses unsaved work.

### Success Criteria (manual checklists)
- [ ] A tester configures OpenRouter from a blank state in under 5 minutes on the first attempt.
- [ ] No data-loss report related to settings changes (e.g. reset while a prompt draft is open).

---

## 5. Navigation, Continuity & Book View

### UX Goal
Let users move freely between the steering (composer + tree) view and a continuous reading (Book) view without losing place or context.

### Happy Path
- Navigation bar shows the path of the current Story.
- Click any section to jump.
- “Read as book” (Ctrl+B) opens a clean continuous text view of the active path.
- Returning to the steering view returns to the same Story and continuation.
- Continuations / next-direction suggestions stay available.

### Key UI Moments
- Persistent nav path.
- Book view that hides composer chrome.
- Ability to highlight or jump back to a specific chapter from the book.
- Preference “always open at the last section” controls where the tree reopens after a switch.

### Friction Points to Avoid
- Losing the reading position on every round-trip.
- Book view that still shows editing chrome.

### Success Criteria (manual checklists)
- [ ] A user switches between steering and reading multiple times per session without losing the current Story/continuation.
- [ ] No “I lost my place” report in usability sessions.

---

## 6. Illustration & Multimodal Moments

### UX Goal
Support image generation and interpretation as optional enrichments, not interruptions to the text flow.

### Happy Path
- From a chapter or selection: “Illustrate” or “Create image of selection”.
- Planning step (optional) → render.
- Images appear as thumbnails attached to the relevant section.
- Vision models can interpret uploaded or generated images when needed.

### Key UI Moments
- Clear separation between text generation and image generation tasks.
- Progress indication for multi-step illustration flows.
- Ability to regenerate a single image without redoing the whole chapter.

### Friction Points to Avoid
- Image generation blocking text continuation.
- Failure of the planning pass surfacing as a hard error.

### Success Criteria (manual checklists)
- [ ] A new user discovers “Illustrate” without documentation.
- [ ] When the image model fails, the test user can still continue the story in text.
- [ ] Regenerating one image does not touch the chapter text.

---

## 7. Accessibility, Language & Appearance

### UX Goal
Support dark/light/system themes, English/German (and future languages), and basic keyboard + screen-reader usability.

### Recommendations
- Theme and language controls in Settings with instant preview.
- Sufficient color contrast in both themes.
- **Keyboard shortcuts documented** — the app already ships:
  - `Ctrl+Enter` — send / save a version
  - `Ctrl+S` — save a version (in-place editor)
  - `Ctrl+B` — open Book (reader) view
  - `Ctrl+F` — search / replace
  - `F3` / `Shift+F3` — next / previous match
  - `Esc` — cancel / close a dialog or editor
- Focus management when dialogs and context menus open.
- Localizable strings for all user-facing text.

### Success Criteria (manual checklists)
- [ ] Theme and language preferences survive restart.
- [ ] No contrast failures in either theme.
- [ ] The documented shortcut list (above) is discoverable in-app (e.g. in help/hints or Settings).

---

## 8. Error Recovery & Confidence

### UX Goal
When something fails (network, provider, model, validation), the user always knows what happened and can recover without losing the current direction or chapter.

### Recommendations
- Inline, non-modal errors near the point of failure.
- Retry affordances for transient provider errors.
- Draft directions preserved if a send fails.
- Trash / soft-delete with restore for sections and stories.
- Clear distinction between “model refused” (content moderation) and “technical error”.

### Success Criteria (manual checklists)
- [ ] A test user recovers from a failed generation in ≤ 2 clicks.
- [ ] A test user soft-deletes a section, restores it from the Trash, and trusts the result.
- [ ] When a model refuses content, the user sees the reason (not a generic failure).

---

## Next Steps

1. Map each playbook to existing E2E specs (chat-create-navigate, settings-*, personas-crud, etc. — already largely covered).
2. Identify gaps where new manual scenarios or UI improvements are needed (candidates: onboarding w/ mock, keyboard-shortcut help, error-toast affordances).
3. Convert high-priority playbook steps into wiki pages or in-app empty-state guidance (several already exist: `concepts`, `faq`, `reader`, `trash`).
4. If product analytics are ever added, revisit the manual checklists as quantified KPIs — until then they live as usability-test checklists only.

---

*These playbooks are living documents. Update them as the UI evolves.*