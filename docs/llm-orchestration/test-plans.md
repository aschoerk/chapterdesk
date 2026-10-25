# Test plans — LLM orchestration use cases 1–13

This document is the **test plan** for the LLM-orchestration `UsecaseKind` union — the 13 use
cases described in `usecase-01..13-*.puml` PLUS the remaining `UsecaseKind` members that
share the same machinery (`render-window`, `image-generation` already inside the illustrated
ones, `structure-title/overview/heading/headings`, `language-check`, `rewrite-selection`, and
`send-chapter-descriptions`). It maps each use case to the **existing test coverage** (so we
never duplicate) and lists the **planned test cases** per use case — including the gaps that
are not yet asserted anywhere.

Full `UsecaseKind` union being planned (23 kinds): storyboard-direct · planned-enblock ·
planned-scenes · render-full · **render-window** · render-node · image-generation · image-send ·
**structure-title · structure-overview · structure-heading · structure-headings ·
language-check · rewrite-selection** · append · append-with-images · send-branch ·
send-insert · send-regenerate · send-rewrite · send-prepend · send-elaborate ·
**send-chapter-descriptions**.

The plans are grounded in the real implementation, not just the diagrams:

| Concern | Implementation |
| --- | --- |
| Dispatch / env / runner | `src/app/core/llm/orchestration/usecases/` (was `usecases.ts`): `runner.ts` (`pickUsecase`, `controllerFor`, `LlmUseCaseRunner`), `env.ts`, `storyboard.ts`, `renders.ts`, `append.ts`, `render-pipeline.ts` |
| Structural flows (8–13) | `src/app/core/llm/orchestration/flows/`: `runner.ts` (`FLOW_CONTROLLERS`, `LlmFlowRunner`), `sends.ts`, `text-send.ts` (`prepareTextSend`, `persistInterpretation`, `streamAnswerNode`, `generatedImageAttachments`, `imageOnlyAnswerContent`) |
| Structure / language / rewrite flows (15–21) | `src/app/core/llm/orchestration/flows/structure.ts` (`textCompletion`, `addStructureNode`, `structureResult`, `wholeStoryContext`, the four `structure-*` controllers, `languageCheck`, `rewriteSelection`) |
| Transport | `transport.ts` (fallback tree, modalities, `/images` routing), `orchestrator.ts`, `evaluators.ts`, `postprocessor.ts` |
| UI entry points | `chat-node.component.ts` (`illustrate`, `sendDraft`/`streamAppendOrchestrated`, `saveAsBranchAndSend`, `saveAsInsertAndSend`, `regenerateAnswer`, `regenerateInPlace`, `openPrependDialog`), `chat.component.ts` (`confirmElaborate`, `openElaborateDialog`) |

## Where the tests live & how to run

- **Core orchestration** (use cases 1–4b–5, image paths incl. 14): `src/app/core/llm/orchestration/orchestration.spec.ts`
- **Append** (use cases 6–7): `src/app/core/llm/orchestration/append.spec.ts`
- **Structural flows** (use cases 8–13 + 21 + lore/sync) **and the structure/language/rewrite flows** (use cases 15–20): `src/app/core/llm/orchestration/flows.spec.ts`
- **Component/UI**: `src/app/components/chat-node/chat-node.component.spec.ts`,
  `src/app/pages/chat/chat.component.spec.ts`, `src/app/components/illustrate-dialog/*`,
  `src/app/components/prepend-dialog/*`, `src/app/components/create-image-dialog/*`

Run a single file:

```bash
npx ng test --watch=false --include="src/app/core/llm/orchestration/orchestration.spec.ts"
```

## Coverage matrix

| UC | Use case | Core covered? | Gap candidates to add |
| --- | --- | --- | --- |
| 1 | storyboard-direct | ✅ fallback / progressive / no-fallback | refusal-per-scene, alert mapping, prompt shape of `storyboardInstruction` scenes |
| 2 | planned-enblock | ✅ reprise / 1-success-skip / attach | pure-mode prompt template, 0-success reprise skip, beat missing from batch |
| 3 | planned-scenes | ✅ shared pipeline + scene templates | scene template on reprise, batch-early-return invariant (already partly) |
| 4 | render-full | ✅ no attachments | legacy `'full'` normalization, full-chat context + anchor shape |
| 4b | render-window | ✅ counts beats in ASSISTANT nodes only (in `orchestration.spec.ts`) | window slice boundaries (1 keeps no prior beat), windowed planning scope, `historyNodes` clamp |
| 5 | render-node | ✅ no attachments | history-only-anchor (no context msgs), scene-text priority |
| 6 | append | ✅ basics | imageCapable image-only, non-stream config, log usage retarget, live paint |
| 7 | append-with-images | ✅ interpret + record | "description already part of content" skip clause, signature mismatch re-interpret |
| 8 | send-branch | ✅ happy + image-only + non-stream + /images | branch-from-answer vs branch-from-question parent rule, carried attachments dedupe |
| 9 | send-insert | ✅ adopt siblings | immediate active-path switch during stream, editor-closes-first timing |
| 10 | send-regenerate | ✅ subtree delete + re-stream | whole-subtree tombstone (children too), no attachment preservation |
| 11 | send-rewrite | ✅ keep-children + preserve attachments | renumber of preserved+new (illustration-2), legacy-only-preserved finalize |
| 12 | send-prepend | ✅ happy | `followingText` token cap, empty-director error slot, flag rollback on failure |
| 13 | send-elaborate | ✅ fresh question + reuse draft | chain under previous answer, `isFirst` template, Stop-cancels-chain |
| 14 | image-send | ✅ AS-IS prompt + refs + refusal | empty-prompt fallback, negative ref-forwarding |
| 15 | structure-title | ✅ wrap + set chat title | empty-title error, empty-chat context, reparent of first child |
| 16 | structure-overview | ✅ after-structure + first-node | empty-intro error |
| 17 | structure-heading | ✅ wrap new + patch existing | non-assistant guard, empty-heading error |
| 18 | structure-headings | ✅ happy + skip already-headed | abort/graceful-stop between chapters (persist current), empty-heading abort, active-path filter |
| 19 | language-check | ✅ raw variants, no mutation | empty-direction error |
| 20 | rewrite-selection | ✅ all 4 context modes + stream | empty-selection error, directions line, `all`-mode prefixes |
| 21 | send-chapter-descriptions | ✅ branch + history | param clamps, goal line, "Return only the chapter list" suffix, excludeFromContext |
| — | cross-cutting | dispatch, guards, postprocessor, evaluators, transport | glossary below |

## Shared conventions for the new tests

- **Mock transport.** Existing core specs stub `global.fetch` and build `Response`-shaped
  objects with the helpers in `orchestration.spec.ts` / `flows.spec.ts` / `append.spec.ts`
  (`sseResponse`, `textResponse`, `jsonImagesResponse`, `sseImagesResponse`). New tests
  reuse those helpers.
- **Fetch-index discipline.** A `planned-enblock` / `planned-scenes` run issues the
  **planning call first (index 0)**, then the render call. Tests asserting "raw chapter
  text never reaches the image model" must assert on the **render** fetch (index ≥ 1),
  because the planning call deliberately contains the beat (`The beat to depict is: …`).
- **Signals.** Storyboard use cases receive `applySignal = chatService.beginOperation('illustrate')`.
  To test Stop, abort the returned signal and assert `isOperationCancelled()` short-circuits
  and pictures already attached stay.
- **Versioning.** `editAssistant`/`editAssistant(…, attachments, …)` returns a NEW node id.
  Assert against the **versioned** id, not the placeholder. LLM-log usage must be re-targeted
  (`llmLog.retargetNode`) — assert `entries()` identity changes and `nodeUsage(nodeId)` > 0.
- **Component tests** use `test-helpers/factories.ts` (`seedApi`, `makeNode`, `makeChat`)
  + `test-helpers/in-memory-chat-api.ts`, with `provideZonelessChangeDetection()`,
  `provideHttpClient()`, `{ provide: CHAT_API, useValue: api }` and a mocked `Router`.
- **localStorage** persists across `it`s in Vitest — `localStorage.clear()` in `beforeEach`
  before creating components when asserting dialog/option defaults.

---

## Use case 1 — storyboard-direct

> Dialog: count > 1, plan descriptions OFF. Image model gets the raw chat text + one
> "render N consistent scenes" prompt. No planning pass.

**Dispatch (verified in `pickUsecase`):** `count > 1 && vars.planDescriptions === false → 'storyboard-direct'`.

**Existing coverage (orchestration.spec.ts):**
- `storyboard-direct does NOT send attachments to the image model either`
- `storyboard-direct: when the one-shot returns NOTHING, the per-scene fallback fills every picture and NO reprise runs`
- `storyboard-direct: fires onImages progressively as each per-scene fallback picture is ready`
- `storyboard-direct: a one-shot that returns every picture performs NO fallback at all`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC1-T1 | core | Batch returns N → one scene record | Mock render returning N images in ONE call | `storyboard.scenes` length 1 with all N images; exactly 1 image fetch; no per-scene calls |
| UC1-T2 | core | Batch returns 0 → per-scene fallback generates `storyboardInstruction(i,count)` scenes | Mock 0 from batch, 1 image per scene call | N scene records; each scene prompt = anchor + `storyboardInstruction(i, N)`; NO reprise fetch |
| UC1-T3 | core | Moderation/refusal of one scene in fallback | Scene call returns refusal with reason | That scene is `refused: true`, carries the reason; other scenes keep images (`partial survival`, mirror of existing `keeps previously collected images…`) |
| UC1-T4 | core | All scenes refused | All scene calls refused | `plan().summary.allRefused === true`, `imagesTotal === 0`; refused-prompt-1..N.txt attachments |
| UC1-T5 | core | Count==1 against storyboard-direct path | `count:1, planDescriptions:false` | PickUseCase does NOT pick storyboard-direct (covered by dispatch, but assert via `pickUsecase` unit) |
| UC1-T6 | component | Partial → alert | `illustrate()` with model returning 2 of 3 | `alert` fired with `imagePartial` (`got:2, want:3`); 2 images + prompt persisted on versioned chapter |
| UC1-T7 | component | Zero → alert with reply | Model refuses all | `imageEmpty` alert contains first 300 chars of model reply; refused-prompt attachments remain on node |
| UC1-T8 | component | Stop mid-fallback | Abort `beginOperation('illustrate')` signal between scene calls | Fallback loop breaks; pictures already attached stay on the versioned node; `isIllustrating` cleared; no `imageFailed` alert |

---

## Use case 2 — planned-enblock

> Text (planning) model derives picture descriptions; ALL go as ONE block to the image model.

**Dispatch (verified):** `purePictures → 'planned-enblock'` (even count 1 — pure mode always plans);
else `count > 1 && singleCall → 'planned-enblock'`.

**Existing coverage (orchestration.spec.ts):**
- `planned-enblock: reprise embeds ONLY the successful descriptions and adapts total to their count; skipped when ≤1 success`
- `planned-enblock: NO reprise runs when only ONE picture succeeded`
- `ATTACHES the fallback + reprise images to the chapter via the postprocessor`
- `planning includes the current ChatNode as the beat to depict`
- `tells the planning model the WINDOW scope (last N beats) when window mode is chosen`
- `does NOT forward reference attachments to the image model after planning`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC2-T1 | core | Pure-picture mode prompt template | `purePictures: true`, count 1 | `pickUsecase` → `planned-enblock`; render fetch uses `purePicturesPrompt` (image.pure) — assert the render prompt does NOT contain raw chapter text |
| UC2-T2 | core | Non-pure template | `purePictures: false` | Render prompt = `oneShotStoryboardPrompt(instruction, descs, …)`; image model only ever sees the derived descriptions |
| UC2-T3 | core | Planning degraded → raw-anchor fallback | Planning returns unusable → `descriptions = []` | `renderBatchWithFallback` scene prompts fall back to `plannedScenePrompt` → raw `anchor` (+ `storyboardInstruction` when >1); **no crash** |
| UC2-T4 | core | `plannedScenePrompt` with description uses instruction, NOT anchor | Success path, desc present | Per-scene fallback prompt starts from `env.instruction.trim()` ("Render exactly this picture description…"), never the chapter text |
| UC2-T5 | core | 0 successes → reprise builder returns null | All images refused | No reprise fetch (only batch + per-scene); spaces where `successTexts.length <= 1` |
| UC2-T6 | core | Partial reprise merges into missing slots | Reprise returns fewer than count | Each returned reprise image merged into a still-missing slot; successful originals kept |
| UC2-T7 | core | Beat missing from render call | Assert render fetch body | Render fetch message list contains NO `The beat to depict is:…` (only present on planning fetch index 0) |
| UC2-T8 | core | Abort during planning | Abort signal during planning call | Planning aborts → error slot; no render call |
| UC2-T9 | component | Pure + count 1 → storyboard-style run | `illustrate()` with purePictures, count 1 | `isStoryboard` true (Stop button), progressive `onImages` writes, final plan replaces interim |

---

## Use case 3 — planned-scenes

> Identical pipeline to planned-enblock; different prompt templates
> (`pictureScenePlanningInstruction` + `oneShotScenesPrompt`).

**Dispatch (verified):** `count > 1` (no singleCall, not pure, planning ON) → `'planned-scenes'`.

**Existing coverage (orchestration.spec.ts):**
- `uses the SCENE-oriented planning prompt for planned-scenes (fewer stills, more scenes)`
- `planned-scenes: when the scene one-shot returns NOTHING, the per-scene fallback + reprise behave exactly like planned-enblock (scene template)`
- `plans then renders ALL scenes in ONE en-block call; a batch that returns anything stops immediately (one picture or none)`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC3-T1 | core | Render + reprise both use `oneShotScenesPrompt` | Success, then partial fallback | Both the initial batch prompt AND the reprise prompt are built by `oneShotScenesPrompt` (identical template, different description list) |
| UC3-T2 | core | Batch early-return invariant | Batch returns ≥1 picture (fewer than count) | Use case STOPS — no per-scene fallback, no reprise; the batch scene record carries the returned images |
| UC3-T3 | core | Scene planning prompt shape | Assert planning fetch (index 0) | Prompt built by `pictureScenePlanningInstruction` with scope line when window mode (`--storyboardHistoryNodes`) |

---

## Use case 4 — render-full

> Count 1, historyMode `'full'`: render the current node knowing the COMPLETE chat.

**Dispatch (verified):** `count === 1 && historyMode === 'full' → 'render-full'` (kept for backward compat; the dialog no longer produces it — legacy stored `'full'` normalizes to `'single'`).

**Existing coverage (orchestration.spec.ts):**
- `render-full does NOT send attachments to the image model either`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC4-T1 | core | Full context + anchor | Mock one image | Request messages = text-only full-history context + single `renderMessages(anchor)`; exactly 1 image fetch |
| UC4-T2 | core | Legacy normalization | Component load with stored `historyMode:'full'` (`chat.illustrateOptions.v1`) | Normalizes to `'single'` → `render-node` on next use (memory-bullet behavior), no `'full'` emitted |
| UC4-T3 | component | Placement | Success | `illustration-1` + `prompt-1.txt` attached via `editAssistant` (versioned), `activate` emitted, `pendingAction` cleared |
| UC4-T4 | component | Refusal | Model refuses | `refused-prompt-1.txt` + `imageEmpty` alert |

---

## Use case 4b — render-window

> Count 1, historyMode `'window'`: render the current node knowing a bounded WINDOW of the
> last `historyNodes` beats (counted in ASSISTANT nodes only — the current node is the anchor,
> so a window of N keeps N-1 earlier chapters; user directions/lore never count).

**Dispatch (verified):** `count === 1 && historyMode === 'window' → 'render-window'`.
Runner = `buildContextMessagesWindow(chatId, cParentId, precedingNodes)` where
`precedingNodes = max(0, historyNodes - 1)`. The same windowed context feeds the storyboard
planning pass (`runPlanning` uses `env.contextMessages`), so storyboards can be bounded too.

**Existing coverage (orchestration.spec.ts):**
- `render-window counts beats in ASSISTANT nodes only and keeps the current chapter`
- (window scope line for planning: `tells the planning model the WINDOW scope …`, `planning includes the current ChatNode as the beat to depict` — shared with planned-enblock)

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC4B-T1 | core | Window slice boundaries | `historyNodes: 2`, structure: dir → a1(assistant) → dir → a2(assistant, current) | Context contains ONLY a1 (the single prior assistant beat), NOT the first direction system/lore/user gaps beyond it; anchor = current node text |
| UC4B-T2 | core | Window of 1 keeps NO prior beat | `historyNodes: 1` | Context empty; only `renderMessages(anchor)` + the anchor message reaches the model |
| UC4B-T3 | core | Non-window storage `'full'` normalizes | Legacy stored `historyMode:'full'` loaded (component) | Normalizes to `'single'` (render-node), `'window'` no longer emitted by the dialog (memory-bullet behavior) |
| UC4B-T4 | core | Windowed planning scope for storyboards | `historyMode:'window'`, count>1 → any planned storyboard | Planning prompt carries `illustrationScopeText('window', historyNodes)` "last N beats" scope line; the runner bounded the planning context with the same `historyNodes - 1` window |
| UC4B-T5 | core | `historyNodes` clamp | Dialog/state `historyNodes` < min / > max | `clampHistoryNodes` clamps to `ILLUSTRATE_HISTORY_NODES_MIN..MAX`; window width uses the clamped value |
| UC4B-T6 | core | `<=0` window width | `precedingNodes` computed as `max(0, …)` | No crash; behaves like full path when the width is 0 |

---

## Use case 5 — render-node

> Count 1, historyMode `'single'`: render the CURRENT NODE only.

**Dispatch (verified):** any other single-picture case (default) → `'render-node'`.

**Existing coverage (orchestration.spec.ts):**
- `render-node does NOT send attachments to the image model either`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC5-T1 | core | No context messages | Mock one image | Request = ONLY `renderMessages(anchor)` — **no** preceding history content messages |
| UC5-T2 | core | Scene-text priority | `vars.promptText`, `vars.content`, empty node | Priority order `promptText → content → node.content`; empty → `(no text)` anchor suffix |
| UC5-T3 | core | Pure + count 1 regression guard | `purePictures:true, historyMode:'single'` | `pickUsecase` → `planned-enblock` (NOT render-node) — guards the fixed raw-anchor leak |
| UC5-T4 | component | Per-use-case window width | Single picture uses `historyNodes`, storyboard uses `storyboardHistoryNodes` | `activeHistoryNodes` correct per count; both remembered separately |

---

## Use case 6 — append

> Normal send: full history + topic system prompt, streamed text answer.

**Entry:** `chat-node.sendDraft()` → `streamAppendOrchestrated()` → `runner.run({usecase:'append'})`.
Runner resolves the WRITE model, builds full-chat messages, streams via orchestrator.

**Existing coverage (append.spec.ts):**
- `streams the answer with full history as context, then appends an assistant node`
- `uses the saved node content when no draft override is given`
- `surfaces an empty stream as empty (no fragment), never throws`
- `uses the "default" generation task model when a node has no model binding`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC6-T1 | core | No writing model enabled | Remove all write-capable models | Error slot `No writing model is enabled.`; nothing streamed |
| UC6-T2 | core | Topic system prompt injected | Chat without a system message | Request has `system` (topic) message first (`buildSendMessages`/Ex `defaultSystemPrompt`) |
| UC6-T3 | core | imageCapable write model → image-only | Write model `canGenerateImages`, returns 200 `{content:'',thinking:''}` + image (the empty-200 fix) | `streamAnswerNode` fills chapter with the ORIGINAL direction; generated attachment present |
| UC6-T4 | core | Non-stream chat config | `stream:false` in textExtras | `completion` issued `stream:false`; full JSON answer persisted |
| UC6-T5 | core | Live paint during stream | `onChunk` capturing | Node content grows per chunk (partial); final `finalizeStream` settles the text slot |
| UC6-T6 | core | Log + usage retarget | Success with usage | Log entry recorded under placeholder nodeId; `llmLog.retargetNode` to versioned id; `nodeUsage(versionedId)` reports tokens |
| UC6-T7 | component | Editor closes on Send / auto-exclude | `sendDraft` (Continue/Switch) | `closeEditor()` runs before streaming; auto-generated directions patched `excludeFromContext:true` |

---

## Use case 7 — append-with-images

> Send with images: interpret ONLY when the description is not already stored.

**Rule (verified in `prepareTextSend`):** `needsImageInterpretation` =
images present AND no matching `image-description.txt` record AND stored description not already
part of node content.

**Existing coverage:** `append.spec.ts` (`interprets the attached images…`, `falls back to a plain append when no image-interpret model is configured`) + `flows.spec.ts` interpretation block
(`needsImageInterpretation: fresh images → true; after a stored record → false; new images → true`,
`append-with-images: interprets + stores the record; a second run does NOT re-interpret`,
`forces text modality when the interpret model can also generate images`,
`does not merge a placeholder when the interpret reply carries no text`).

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC7-T1 | core | "Already part of content" skip clause | Node content already contains the stored description string | NO interpret call; plain `buildSendMessagesEx` |
| UC7-T2 | core | Record signature mismatch | Different images than the stored record | Re-interpreted; new merged content + new record replaces stale (dedupe keeps images, record refreshed) |
| UC7-T3 | component | Persist merged direction + record | `streamAppendOrchestrated`, interpret success | `patchNode(question)` content = direction + description; record attachment added; re-send does not interpret |
| UC7-T4 | component | Content already matches | Merged == question content | Only record appended to the question attachments (no content change) |

---

## Use case 8 — send-branch

> New sibling question + streamed answer. Model override from the editor wins.

**Existing coverage (flows.spec.ts):** happy path, IMAGE-ONLY answers (stream + non-stream),
NON-STREAMING full text, stream:false config, `/images` image-generation write model,
lore re-arm tests.

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC8-T1 | core | Branch from a QUESTION → sibling | `node.role === 'user'` | `branchQuestion`; new question parent = node's parent (sibling), not node |
| UC8-T2 | core | Branch from an ANSWER → child question | `node.role === 'assistant'` | `addNode` child under the answer; thread continues from that point |
| UC8-T3 | core | Carried attachments dedupe | Node has 2 attachments, draft repeats one by dataUrl | `carryAttachments` output has no duplicates |
| UC8-T4 | core | No writing model | Remove write models | `LlmFlowRunner` error slot, no chat mutation |
| UC8-T5 | component | Editor closes after OK, activate | `saveAsBranchAndSend` | `closeEditor()` runs only when flow returns true; `activate(newQuestion)` emitted |
| UC8-T6 | component | Model override wins | Editor selected different model than node | New question + writer use `vars.modelId/providerId` |

---

## Use case 9 — send-insert

> New sibling + answer that ADOPTS the old siblings.

**Implementation notes (verified):** `branchQuestion` + IMMEDIATE `setActiveChild(parentId, newQuestion.id)`
(before streaming, so it paints), `adoptNodeIds` = all siblings under parentId except the new question,
`streamAnswerNode({adoptNodeIds})`, then `setActiveChild(answerNodeId, firstAdopt)` where
`firstAdopt = node.id` when the source node is in the adopt list.

**Existing coverage (flows.spec.ts):**
- `send-insert: creates a sibling + answer and hangs the old siblings under the new answer`
- `send-insert: re-arms the shared lore node of the direction being inserted above so the new direction gets the lore`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC9-T1 | core | Active-path switch BEFORE stream | Mock a pending stream; inspect `getActivePath()` | After `branchQuestion`, the active path already contains the new question (not the editing node) |
| UC9-T2 | core | Adopt set excludes new question | Siblings = [A, node, B] | `adoptNodeIds = [A, node, B]`; all re-parented under the versioned answer |
| UC9-T3 | core | firstAdopt = source node | Source node in adopt list | `setActiveChild(answer, node)` so the user stays on their leaf |
| UC9-T4 | component | Editor closes BEFORE flow | `saveAsInsertAndSend` | `closeEditor()` runs before `runFlow` (timing mirroring Send) |
| UC9-T5 | component | Only from user nodes | Press on assistant | Guard returns early (no flow) |

---

## Use case 10 — send-regenerate

> Confirm → delete the answer + subtree → re-stream a fresh answer under the question.

**Implementation notes (verified):** `parentQuestion(env, node)` (error slot `No question node to regenerate.`
if absent), `ensureLoreNodeBefore(question)` re-arms lore, `deleteNode(chatId, node.id)` **whole subtree**,
prepare on the QUESTION (content+attachments), `streamAnswerNode`, activate question.

**Existing coverage (flows.spec.ts):**
- `send-regenerate: deletes the old answer and re-streams under the same question`
- `send-regenerate: an IMAGE-ONLY answer fills the fresh answer with the direction and attaches the image`
- `send-regenerate: clears the exclude flag of the lore node before the assistant and re-sends the lore`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC10-T1 | core | Whole subtree tombstoned | Answer has child nodes | ALL descendants deleted (`deleteNode` full-subtree), NOT keepChildren |
| UC10-T2 | core | Old attachments NOT preserved | Old answer has illustration-1 | After regenerate, old image GONE; only fresh images attached (by design) |
| UC10-T3 | core | No parent question | Node with `parentId: null` or parent missing | Error slot; no delete, no stream |
| UC10-T4 | component | Confirm cancel | `regenerateAnswer()` dialog cancelled | Nothing deleted/streamed, `isLoading` false |
| UC10-T5 | component | Usage on fresh answer | Success with usage | Log entry re-targeted to the NEW versioned answer; node shows usage |

---

## Use case 11 — send-rewrite

> Delete ONLY the answer (keep children), re-stream, re-adopt children + preserve old attachments.

**Implementation notes (verified):** `adoptNodeIds = children(node.id)`,
`preservedAttachments = (node.attachments ?? []).slice()`, `deleteNode(..., {keepChildren:true})`,
`streamAnswerNode({adoptNodeIds, preserveAttachments})`,
`mergeAnswerAttachments` = preserved + new generated images renumbered after kept
(`startIndex = existingGeneratedImageCount(preserved)` → new image becomes `illustration-2`).

**Existing coverage (flows.spec.ts):**
- `send-rewrite: deletes only the answer and re-adopts the preserved children`
- `send-rewrite: routes an image-GENERATION WRITE model to /images and re-attaches the picture`
- `send-rewrite: PRESERVES the old answer's attachments and merges the new image (previous pictures stay available)`
- `send-rewrite: clears the exclude flag of the lore node before the assistant and re-sends the lore`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC11-T1 | core | Renumber preserved + new | Old `illustration-1` present, model returns 1 new image | Fresh node has `illustration-1` (kept) + `illustration-2` (new), names unique |
| UC11-T2 | core | Only preserved, no new image | No fresh image | Finalize still runs (guard `preserveAttachments.length > 0`); preserved attachments attached |
| UC11-T3 | core | Keep-children re-parent chain | Children under answer | After delete they re-parent to the question, then re-adopt under fresh answer; `setActiveChild(answer, firstAdopt)` |
| UC11-T4 | component | Confirm shows child count | `regenerateInPlace()` | Confirm message includes children count; cancel → no mutation |

---

## Use case 12 — send-prepend

> Director (user) node + streamed result BEFORE the current direction, adopting the current node.

**Implementation notes (verified):** prompt = `directorText + followingText` (from
`followingAssistantContent(node)`), error slot `No director text to prepend.` when empty,
`addNode` director under parent, `buildSendMessagesEx(directorNode, contentOverride)`,
`streamAnswerNode({adoptNodeIds:[node.id]})`, `reparent + setActiveChild(parent, director)`.
On failure the component rolls back `chat.prependByNodeId` → `prependEnabled = false`.

**Existing coverage (flows.spec.ts):**
- `send-prepend: inserts a director node + result BEFORE the current direction, adopting it`
- prepend dialog component spec (`prepend-dialog.component.spec.ts`)

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC12-T1 | core | Following-text prompt | `followingText` set | Final user message = director + following chapters (`\n\n` joined); history text-only up to current node |
| UC12-T2 | core | Empty director | no directorText | Error slot; no node created |
| UC12-T3 | core | Adopt the current direction | Success | Current node re-parented under the fresh answer; `setActiveChild(parent, director)` keeps leaf intact |
| UC12-T4 | core | Following chapters ≤ ~5000 tokens | Long following content | `followingAssistantContent` truncates; chapters after node included up to cap |
| UC12-T5 | component | Failure rollback | Flow throws / refused | `chat.prependByNodeId` removed → prepend re-enabled; director node may remain but no result inserted |
| UC12-T6 | component | One prepend per node guard | Flag already set | Second Prepend on same node disabled / silently no-op |

---

## Use case 13 — send-elaborate

> Append one chapter elaboration: create/reuse a question under the anchor and stream an answer.

**Implementation notes (verified):**
- Anchor = `activeTreeAssistantNode()` (currently visible tree, NOT most-recent-by-timestamp).
- Per chapter/name: `render('structure.elaborate[-view]', { chapter[, name] })`; model override from dialog wins.
- `getOrCreateElaborateQuestion`: reuse an empty user leaf (no content, no attachments) via
  `persistQuestion`, else `addNode`; both get `excludeFromContext: true` (auto-generated meta-direction).
- Chain: next iteration anchors under the PREVIOUS answer (`slots.flow.value.answerNodeId`).
- `beginOperation('elaborate')`; a Stop cancels the whole chain.

**Existing coverage (flows.spec.ts):**
- `send-elaborate: append an answer under a fresh question under the anchor, honoring the model override`
- `send-elaborate: reuses an existing empty user leaf draft under the anchor`
- chat.component.spec regression: anchors elaborate on the currently visible tree, not the most recent branch

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC13-T1 | core | Fresh question created under anchor | No draft leaf | New user question under anchor; `excludeFromContext:true`; streamed answer under it |
| UC13-T2 | core | Reused draft path | Empty user leaf exists | `persistQuestion` onto the draft (not a new node); `change excluded` |
| UC13-T3 | core | Chained anchoring | 2+ chapters | Chapter 2's question is a child of chapter 1's ANSWER (parent chain); `isFirst` differs per iteration |
| UC13-T4 | core | Model override wins | Dialog model ≠ node model | `resolveWriteModel(anchor, modelId, providerId)` uses override; question + writer carry it |
| UC13-T5 | core | Empty prompt | blank content | Error slot `No elaborate prompt.`; nothing created |
| UC13-T6 | component | Stop cancels whole chain | Abort after chapter 1 completes | Chapter 1 answer stays; no further chapters; `beginOperation('elaborate')` cleaned up |
| UC13-T7 | component | Prompt template `{{#if isFirst}}` | First vs follow-up view | First view: free writing; follow-up: "only new plot material, no repetition" from TEMPLATE text |
| UC13-T8 | component | Remembered state | `saveElaborateState` | `lastChapter` + `characters` restored on next dialog open |

---

## Use case 14 — image-send (bonus; same dispatch family)

Registered alongside the illustrated use cases (`image-send`): prompt sent AS-IS (no planning,
no drawing-instruction template), optional reference images forwarded as `image_url` parts,
picture attached to the assistant node by the caller.

**Existing coverage (orchestration.spec.ts, `describe('LLM orchestration — image-send …')`):**
- `sends the combined constant + marked text AS-IS (no drawing instruction, no refs)`
- `an explicit modelId in vars wins over the settings image-create default`
- `a stale/missing providerId must NOT silently drop the chosen model for the settings default`
- `forwards reference images as image_url parts when attached`
- `turns a moderation refusal into a refused scene with the reason`
- `image-generation (explicit single picture)` describe block

**Gap candidates:** reference images NOT forwarded when `attachments` empty/absent (already positive-tested;
add the negative assert), and `promptText` empty → `(no text)` / "See the attached reference image(s)." fallback.

---

## Use case 15 — structure-title

> Generate a story TITLE from ALL current chapters, wrap the story under a structural node at
> the root, and make the title the chat title.

**Implementation (flows/structure.ts):** `textCompletion` (non-streaming, write model) with
`structureInstruction('title')` + `wholeStoryContext` + "Return only the resulting text.".
Empty result → error slot `No title generated.`. Then `addStructureNode(parentId: null)`, and
when a root child exists it is re-parented under the new title (`reparentNodes` + `setActiveChild`
chain); always `updateChatTitle`.

**Existing coverage (flows.spec.ts):**
- `structure-title: wraps the story under a root title and sets the chat title`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC15-T1 | core | Empty chat context | No current assistant chapters | Completion body contains `(empty chat)`; title still produced |
| UC15-T2 | core | Empty title result | Model returns blank/whitespace | Error slot `No title generated.`; NO structural node created, chat title untouched |
| UC15-T3 | core | Refused/error completion | Completion refused | Error/refused slot surfaces; no `flow.structureNodeId` |
| UC15-T4 | core | Log usecase attribution | Spy on `LlmLogService.record` | Entry `usecase === 'structure-title'`, `chatId` set |
| UC15-T5 | core | Whole-story context only | Direction text in the chat | `wholeStoryContext` includes ONLY current assistant chapters, not user directions |
| UC15-T6 | component | Chat title updates | Confirm | `updateChatTitle` called with generated title (row title reflects it) |

## Use case 16 — structure-overview

> Generate an INTRODUCTION from ALL current chapters; place it right after an existing
> structural node, or as the FIRST node when none exists.

**Existing coverage (flows.spec.ts):**
- `structure-overview: places the introduction right after an existing structure node`
- `structure-overview: becomes the first node when the story has no structure node`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC16-T1 | core | Empty intro result | Model returns whitespace | Error slot `No introduction generated.`; no node created |
| UC16-T2 | core | Placement under existing structure | Title exists → `rootChildren.find(role==='structural')` | Intro `parentId === title.id`; the first active child of the title is re-parented under intro; `setActiveChild` chain restored |
| UC16-T3 | core | Re-parent preserves tree | Story already has children under the title | `reparentNodes([firstChild], intro.id)` then active = intro → firstChild (order preserved) |
| UC16-T4 | core | Whole-story context rule | Directions present | Same assistant-only `wholeStoryContext` rule as UC15-T5 |

## Use case 17 — structure-heading

> Generate a heading for ONE chapter (the current node). Patch the chapter's structural
> parent when one exists, else wrap the chapter under a new structural node.

**Implementation:** guard `node.role !== 'assistant'` → error `No assistant chapter to head.`;
context = ONLY the chapter's own text; empty result → `No heading generated.`;
`existingHeading` = parent node is structural → `patchNode` on it; else `addStructureNode` +
`reparentNodes([node])` + active chain.

**Existing coverage (flows.spec.ts):**
- `structure-heading: wraps the chapter under a NEW heading using only the chapter text`
- `structure-heading: PATCHES the existing structural parent of the chapter`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC17-T1 | core | Non-assistant guard | Run on a user node | Error slot `No assistant chapter to head.`; no fetch, no mutation |
| UC17-T2 | core | Empty heading result | Blank completion | Error `No heading generated.`; nothing wrapped/patched |
| UC17-T3 | core | Only chapter text reaches model | Direction text in parent | Completion body contains chapter content, NOT the parent direction |
| UC17-T4 | core | Wrapped under new structure with parentId | Chapter parent = a user node | New heading `parentId === chapter.parentId`; chapter re-parented under heading; active = heading → chapter |
| UC17-T5 | core | Patched node provenance | Existing heading patched | `patchNode` sets `content` + `modelId/providerId` of the flow writer |

## Use case 18 — structure-headings

> Generate a heading for EVERY chapter on the active path that has none yet. Already-headed
> chapters stay in context (as previous chapters incl. their headings) but are NOT regenerated.
> One Stop (hard abort OR graceful `shouldStopAfterCurrentStep`) cancels the run between
> chapters, but the heading that is CURRENTLY being generated is still fetched and persisted.

**Implementation (flows/structure.ts):** loop over `getActivePath()` assistant chapters with
content; per chapter: stop-check → skip if parent is structural (push to `previous`) → build
blocks (prior chapters + generated headings + the current unheaded one) → completion →
**hard abort break** → empty-heading → error (aborts whole run) → add/reparent/active →
push to `previous` + `createdIds`. Result `structureResult({}, lastId, createdIds)`.

**Existing coverage (flows.spec.ts):**
- `structure-headings: heads every unheaded chapter, keeping prior headings in context`
- `structure-headings: skips chapters that already have a heading but keeps them in context`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC18-T1 | core | Hard abort between chapters | 2 unheaded chapters; abort signal after first completion resolves | First heading persisted; loop breaks; NO request for second chapter; no error slot |
| UC18-T2 | core | Graceful `shouldStopAfterCurrentStep` | Stop flag set before a chapter's request | Current in-flight heading STILL fetched + persisted; run ends after that chapter |
| UC18-T3 | core | Empty heading mid-run | Second completion blank | Error slot `No heading generated.`; whole run aborts; previously created headings stay |
| UC18-T4 | core | Active-path filter | An assistant exists off the active path | Only active-path assistants are headed; off-path chapter untouched |
| UC18-T5 | core | Context includes earlier generated headings | Before heading for chapter N | Body contains `<that chapter> — heading: "…"` blocks for chapters 1..N-1 with their generated headings |
| UC18-T6 | core | StructureNodeIds creation order + activation | 3 unheaded chapters | `structureNodeIds` length 3 in creation order; flow `structureNodeId` = last created |
| UC18-T7 | core | No unheaded chapters | All headed | No fetches; `structureNodeIds` empty; active path unchanged |

## Use case 19 — language-check

> Copy-edit a writing direction and return the RAW corrected variants (no chat mutation —
> the caller parses `text`).

**Existing coverage (flows.spec.ts):**
- `language-check: returns the raw corrected variants (no chat mutation)`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC19-T1 | core | Empty direction | `vars.content` blank | Error slot `No direction to check.`; no fetch, no mutation |
| UC19-T2 | core | Prompt shape | Completion | Body = `englishCheckInstruction` + "Original direction:" + the text; non-streaming |
| UC19-T3 | core | No chat mutation (all paths) | Success + refusal | Node count unchanged in both cases; no structural nodes created |
| UC19-T4 | core | Raw value | JSON-list reply | `slots.text.value ===` exact raw string (caller parses) |

## Use case 20 — rewrite-selection

> Propose corrected variants of a MARKED piece of text, optionally grounded in surrounding
> context. No chat mutation; STREAMED (so the dialog shows live progress).

**Implementation (flows/structure.ts):** context scope `'none' | 'node' | 'upto' | 'all'`
(default `'node'`); body = `rewriteInstruction` + optional `User directions — the rewrite MUST
follow these:` + optional `Context the marked text appears in:` + `Marked text to rewrite:`;
`upto` slices `nodeContent.slice(0, max(0, selectionEnd))`; `all` uses `buildSendMessagesEx`
rendered as `User:/Assistant:/System:` prefixed blocks; `textCompletion(…, { stream: true })`.

**Existing coverage (flows.spec.ts):**
- `isFlowUsecase recognizes rewrite-selection`
- `no context: sends only instructions + directions + the marked text`
- `current-node context: the whole node content is included`
- `upto context: only the node text up to and including the marked part`
- `whole-text context: the entire thread up to the node is included`
- `streams chunks through onChunk so the caller can show live progress`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC20-T1 | core | Empty marked text | `content` blank | Error slot `No text to rewrite.`; no fetch |
| UC20-T2 | core | Default mode is `node` | `contextMode` omitted | Context = whole node content (existing "current-node" path) — assert no `all`-mode prefixes |
| UC20-T3 | core | `upto` boundary | `selectionEnd` beyond length or negative | Slice clamped via `max(0, end)`; no throw |
| UC20-T4 | core | Stream flag + onChunk | Spy on transport body | `stream: true`; `onChunk` invoked per chunk so dialog can refresh |
| UC20-T5 | core | No chat mutation | Success | Node/attachment counts unchanged; only `text` slot filled |
| UC20-T6 | core | `all`-mode prefixes | `contextMode:'all'` | Body contains `User:`, `Assistant:`, `System:` prefixed history blocks and the final `Marked text to rewrite:` line |

## Use case 21 — send-chapter-descriptions

> Plan a chapter description list as ANOTHER branch: branch a new sibling question off the
> empty leaf (the FULL previous chat content is the history) whose text requests the list
> with the parameters, then stream the answer under it. The empty leaf question where
> Continue lives stays untouched.

**Implementation (flows/sends.ts):** `request = chapterDescriptionsInstruction()` + parameter
lines (`count`, `sentences`, `first`, optional `goal`, `Return only the chapter list, starting
at chapter {first}.`); `branchQuestion` off the current (empty-leaf) node, `setActiveChild`
IMMEDIATELY, `patchNode(excludeFromContext:true)`, `ensureLoreNodeBefore`, `prepareTextSend`,
`streamAnswerNode`; result `flowResult({ questionNodeId, answerNodeId, activateId: answer, branchNodeId })`.
Parameter clamps: `max(1, floor(Number(...) || 1))` for count/sentences/firstChapter.

**Existing coverage (flows.spec.ts):**
- `send-chapter-descriptions: branches a sibling question with the request and streams the list (previous chat content as history)`

**Planned new tests:**

| ID | Level | Scenario | Steps | Expected |
| --- | --- | --- | --- | --- |
| UC21-T1 | core | Param clamps | `chapterCount: 0`, `sentencesPerChapter: NaN`, `firstChapter: -3` | Eff 1 / 1 / 1; request lines say `Number of chapters to plan: 1` etc. |
| UC21-T2 | core | Goal included when set / omitted when absent | Goal `'end a scene'` vs none | Only present builds the `What the chapters are meant to achieve:` block |
| UC21-T3 | core | Request tail | Any | Request ends with `Return only the chapter list, starting at chapter {first}.` |
| UC21-T4 | core | Empty leaf stays untouched | Flow on an empty composer leaf | Leaf node itself NOT mutated; branch sibling created; `excludeFromContext:true` on the new question |
| UC21-T5 | core | Lore + exclusion | After send | `markSentOnceExcluded` finalizes the one-shot lore; `excludeFromContext` remains on the request question |

---

## Cross-cutting test responsibilities

| Area | Covered by | Planned additions |
| --- | --- | --- |
| Dispatch table `pickUsecase` | `maps dialog vars to the 5 use cases` | Exhaustive table incl. pure+count1 → planned-enblock, window, singleCall, planDescriptions:false |
| `controllerFor` unknown | — | Throws for an unknown kind |
| No-model guards (image & write) | orchestration.spec error-slot cases | Component: `node.imageModelMissing` alert when no `image-create` model |
| Evaluators | `LLM orchestration — evaluators (pure, never throw)` block | — |
| Transport fallback tree | `LLM orchestration — transport fallbacks` block (refusals, /images, modalities retry, non-stream retry, include_usage, timeout/abort) | — |
| Postprocessor placement | partially in `ATTACHES the fallback + reprise images…` | Pure plan tests: naming `illustration-N`/`prompt-N`/`refused-prompt-N`, `allRefused`/`partial`/`imagesTotal`/`imagesRefused`, `resolveChapterNode` assistant-vs-current-assistant-child, `plan() → null` when no chapter |
| Progressive storyboard writes (component `onImages`) | `fires onImages progressively…` (core) | Component: interim writes version + re-target `currentTargetId`, final plan replaces interim without duplicates |
| Versioning + log retarget | usage.spec / llm-log.service.spec / append.spec | Covered per-use-case above (UC6-T6, UC10-T5) |
| Lore re-arm per flow | flows.spec lore block (regenerate/rewrite/insert) | Add branch + prepend + elaborate lore re-arm |
| `markSentOnceExcluded` after send | `ensureLoreNodeBefore…` tests | Assert it runs in `finally` even when the stream errors |

## Suggested implementation order

1. **Dispatch + guards** (small, unblocks everything): exhaustive `pickUsecase` + `controllerFor` + no-model guards.
2. **Postprocessor pure plan suite** (pure functions, no mocks): attachment naming + summaries + `resolveChapterNode`.
3. **Use-case gaps with the highest regression value first:**
   `UC2-T1` (pure→planned-enblock prompt leak guard — ties to a real fixed bug),
   `UC1-T3/UC1-T4` (refusal per scene),
   `UC5-T3` (pure+count1 regression guard),
   `UC9-T1` (send-insert active-path timing — real user symptom),
   `UC11-T1` (attachment renumber), `UC12-T5` (prepend rollback), `UC13-T3/T6` (chain + Stop).
4. **Component-level tests** (alerts, editor timing, progressive interim writes) in
   `chat-node.component.spec.ts` / `chat.component.spec.ts`.