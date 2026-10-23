import type { ChatMessage } from '../../../../models/chat';
import type { EvalSlots } from '../types';
import { makeSlot, okSlot } from '../slots';
import { renderBatchWithFallback } from './render-pipeline';
import type { UsecaseEnv } from './env';

// ---------------------------------------------------------------------------
// 1. storyboard-direct — the chat AS-IS (TEXT only), one render request
// ---------------------------------------------------------------------------
async function storyboardDirect(env: UsecaseEnv): Promise<EvalSlots> {
  const count = env.cx.vars.count ?? 1;
  // One-shot storyboard prompt heads the call; the chat's TEXT is the context.
  // The image model only ever receives the prompt + story text — NO
  // attachments (prior illustrations / hand-attached images never reach it).
  const batchPrompt = env.factory.oneShotStoryboardPrompt(
    env.anchor, [], count, env.cx.vars.storyboardPrompt
  );
  const contextText = env.factory.textOnlyMessages(env.contextMessages);
  const scenePrompt = (i: number) =>
    env.anchor + (count > 1
      ? `\n\n${env.factory.storyboardInstruction(i, count, env.cx.vars.storyboardPrompt)}`
      : '');
  // The final "consistency" attempt re-runs the anchor one-shot (there are no
  // per-scene descriptions in storyboard-direct — the model picks the scenes
  // from the anchor itself).
  const batch = await renderBatchWithFallback(
    env, count, batchPrompt, scenePrompt, contextText
  );
  return {
    images: okSlot(batch.images, {}),
    storyboard: makeSlot('ok', batch.scenes, undefined, {})
  };
}

/**
 * The per-scene render prompt for a PLANNED description. The base is the
 * drawing INSTRUCTION (`env.instruction`, the "how to draw" task prompt) —
 * NOT the raw anchor/prose, so the last assistant node's chapter text NEVER
 * reaches the image model (that was the legacy behavior too: the description
 * IS the scene). Only when NO description is available (planning degraded)
 * does the prompt fall back to the raw anchor as the story cue.
 */
function plannedScenePrompt(
  env: UsecaseEnv,
  desc: string | undefined,
  i: number,
  count: number,
  extra?: string
): string {
  if (desc) {
    const base = env.instruction.trim();
    return base
      ? `${base}\n\nRender exactly this picture description (it overrides any scene cue above):\n${desc}`
      : desc;
  }
  // No description → the anchor (instruction + the beat to depict) is the
  // only story cue; append the per-scene storyboard instruction when >1.
  return env.anchor + (count > 1
    ? `\n\n${env.factory.storyboardInstruction(i, count, extra)}`
    : '');
}

/** The prompt templates that distinguish the two planned storyboard use cases. */
interface PlannedStoryboardTemplates {
  /** Build the planning instruction (the prompt prefix for the planning pass).
   *  `scope` is the story-scope line computed from `historyMode`/`historyNodes`
   *  — tells the planning (text) model how many beats to generate pictures for. */
  planning: (count: number, scope?: string) => string;
  /** Build the DEFAULT en-block render prompt — used for the initial batch AND
   *  the reprise (enblock: image.pure / image.one-shot; scenes: image.one-shot-scenes). */
  render: (descs: string[], total: number) => string;
}

/**
 * Shared "plan → ONE en-block render (+ per-picture fallback + reprise)"
 * pipeline used by `planned-enblock` and `planned-scenes`. The two use cases
 * are IDENTICAL except for the prompt TEMPLATES passed in (the planning
 * prefix and the render prefix); the call flow, the batch early-return, the
 * per-scene fallback and the consistency reprise are the same code.
 */
async function plannedStoryboard(env: UsecaseEnv, tpl: PlannedStoryboardTemplates): Promise<EvalSlots> {
  const count = env.cx.vars.count ?? 1;
  // Tell the planning (text) model which story scope it is planning pictures
  // for: the last `historyNodes` beats (window mode) or the current beat with
  // the full text up to it as context. In pure picture mode the derived
  // descriptions ARE what reaches the image model, so the planner must know
  // exactly which beats to cover.
  const scopeText = env.factory.illustrationScopeText(env.cx.vars.historyMode, env.cx.vars.historyNodes);
  const planSlots = await runPlanning(env, c => tpl.planning(c, scopeText));
  const descriptions = planSlots.descriptions?.value ?? [];

  // The DEFAULT render prompt builder — the SAME one that renders all
  // pictures in one go. It is used for the initial batch AND for the fallback
  // reprise, so the reprise always uses the identical default prompt, just
  // combined with a DIFFERENT description list (the successfully rendered
  // ones), keeping the template consistent with the initial batch.
  const buildRenderPrompt = tpl.render;

  const batchPrompt = buildRenderPrompt(descriptions.map(d => d.text), count);

  const scenePrompt = (i: number) =>
    plannedScenePrompt(env, descriptions[i]?.text, i, count, env.cx.vars.storyboardPrompt);

  // The final "consistency" attempt uses the SAME DEFAULT render prompt builder
  // as the initial one-shot, but embeds ONLY the descriptions of the pictures
  // that were successfully rendered and adapts `total` to their REAL count
  // (never the missing/failed ones, never the whole list). It runs ONLY when
  // MORE THAN ONE picture succeeded — a single description gives too little
  // style context to re-render against — otherwise it is skipped entirely.
  const batch = await renderBatchWithFallback(
    env, count, batchPrompt, scenePrompt, [],
    (successful) => {
      const successTexts = successful
        .map(i => descriptions[i]?.text)
        .map(t => (t ?? '').trim())
        .filter(t => t.length > 0);
      if (successTexts.length <= 1) return null;
      return buildRenderPrompt(successTexts, successTexts.length);
    }
  );
  return {
    ...planSlots,
    images: okSlot(batch.images, {}),
    storyboard: makeSlot('ok', batch.scenes, undefined, {})
  };
}

// ---------------------------------------------------------------------------
// 2. planned-enblock — plan → ONE en-block render (+ fallback + reprise)
//    with the STATIC-STILL planning template and the default render prompts
//    (image.pure in pure picture mode, image.one-shot otherwise).
// ---------------------------------------------------------------------------
async function plannedEnblock(env: UsecaseEnv): Promise<EvalSlots> {
  return plannedStoryboard(env, {
    planning: (count, scope) =>
      env.factory.picturePlanningInstruction(count, env.cx.vars.storyboardPrompt, scope),
    render: (descs, total) =>
      env.cx.vars.purePictures
        ? env.factory.purePicturesPrompt(
            env.instruction, descs, total, env.cx.vars.storyboardPrompt)
        : env.factory.oneShotStoryboardPrompt(
            env.instruction, descs, total, env.cx.vars.storyboardPrompt)
  });
}

// ---------------------------------------------------------------------------
// 3. planned-scenes — IDENTICAL to `planned-enblock`, only the prompt
//    TEMPLATES differ: the SCENE-oriented planning prefix (image.planning-
//    scenes) and the scene one-shot render template (image.one-shot-scenes) —
//    fewer static stills, more alive, action-bearing scenes.
// ---------------------------------------------------------------------------
async function plannedScenes(env: UsecaseEnv): Promise<EvalSlots> {
  return plannedStoryboard(env, {
    planning: (count, scope) =>
      env.factory.pictureScenePlanningInstruction(count, env.cx.vars.storyboardPrompt, scope),
    render: (descs, total) =>
      env.factory.oneShotScenesPrompt(
        env.instruction, descs, total, env.cx.vars.storyboardPrompt)
  });
}

// ---------------------------------------------------------------------------
// Shared planning step (IDENTICAL code for the two planned use cases; the
// planning prompt/prefix is passed in by the caller).
// ---------------------------------------------------------------------------
async function runPlanning(
  env: UsecaseEnv,
  planningPrompt: (count: number) => string
): Promise<EvalSlots> {
  const count = env.cx.vars.count ?? 1;
  const textOnly = env.factory.textOnlyMessages(env.contextMessages);
  const planPrompt = planningPrompt(count);
  // The current beat (the ChatNode the user pressed Illustrate on) MUST reach
  // the planning model: the context above only covers the history before it,
  // so the beat text is appended as its own message — the planning prompt
  // then refers to "the story so far AND the illustration request".
  const beat = (env.cx.vars.content ?? env.cx.node?.content ?? '').trim();
  const messages: ChatMessage[] = beat
    ? [
        ...textOnly,
        { role: 'user', content: `The beat to depict is:\n${beat}` },
        { role: 'user', content: planPrompt }
      ]
    : [...textOnly, { role: 'user', content: planPrompt }];
  return env.orch.completion(env.cx, {
    model: env.plan.model,
    provider: env.plan.provider,
    messages,
    extras: await env.factory.resolveExtras(env.plan.model, env.cx.chat)
  }, { expect: 'descriptions', prompt: planPrompt, signal: env.signal });
}

export {
  storyboardDirect,
  plannedEnblock,
  plannedScenes
};
export type { PlannedStoryboardTemplates };