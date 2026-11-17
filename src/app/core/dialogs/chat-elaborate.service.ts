import { Injectable, inject, signal } from '@angular/core';
import { ChatNode } from '../../models/chat';
import { ModelEntry, ProviderConfig } from '../../models/chat-config';
import { ChatService } from '../chat/chat.service';
import { LastModelService } from '../settings/last-model.service';
import { SettingsService } from '../settings/settings.service';
import { PromptDefaultsService } from '../prompts/prompt-defaults.service';
import { LlmUseCaseRunner } from '../llm/orchestration';
import { chapterPlanLabel, chapterPlanSlice } from '../llm/chapter-plan';
import type { HeldRun } from '../llm/orchestration/flows/env';
import { RevealQueue } from '../llm/reveal-queue';
import { ToastService } from '../toast/toast.service';
import { I18nService } from '../i18n/i18n.service';
import { isSentenceComplete, MAX_COMPLETION_DIRECTIONS } from '../util/helpers';
import { ChatElaborateDialogService } from './chat-elaborate-dialog.service';

/**
 * Owns the Elaborate ORCHESTRATION (open/cancel/confirm + the sequential
 * per-chapter LLM chain) that used to live inside ChatComponent. The dialog
 * STATE and its per-chat persistence stay in `ChatElaborateDialogService`;
 * this service reads/writes them and runs the chain, so the page stays a thin
 * delegate (it only adds the structure-generation guard on open).
 */
@Injectable({ providedIn: 'root' })
export class ChatElaborateService {
  private readonly dialog = inject(ChatElaborateDialogService);
  private readonly chatService = inject(ChatService);
  private readonly llmRunner = inject(LlmUseCaseRunner);
  private readonly promptDefaults = inject(PromptDefaultsService);
  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);

  /** True while the sequential elaboration chain is running. */
  readonly isElaborating = signal(false);

  // ------------------------------------------------------------------
  // Open / cancel / dialog helpers
  // ------------------------------------------------------------------

  /** Open the dialog, continuing where the last elaboration for THIS chat
   *  left off (First = previous Last + 1, characters = last used). */
  open(): void {
    const chatId = this.chatService.currentChatId();
    if (!chatId || this.isElaborating()) return;
    const anchor = this.activeTreeAssistantNode();
    if (!anchor) {
      alert(this.i18n.t('chat.elaborateNoAnchor'));
      return;
    }

    // Each chat keeps its own state (not a global default).
    const state = this.dialog.loadState(chatId);
    const next = state.lastChapter + 1;
    this.dialog.first.set(next);
    this.dialog.last.set(next);
    this.dialog.names.set(state.characters);
    this.dialog.prefix.set(state.prefix);
    this.dialog.hints.set(state.hints);
    this.dialog.stickLast.set(false);
    // Chapter-plan options are remembered per chat as well. “Add the chapter
    // descriptions to the lore” is ON by default whenever the chat actually
    // has a usable plan — only an explicit uncheck is remembered as opt-out.
    this.dialog.planNodeId.set(state.planNodeId ?? null);
    this.dialog.planChapters.set(
      state.planChapters ?? ChatElaborateDialogService.DEFAULT_PLAN_CHAPTERS,
    );
    this.dialog.usePlan.set(!!this.dialog.activePlan() && state.usePlanOff !== true);

    // initial model = the one that created the visible tree's last answer
    const model = this.resolveElaborateModel(anchor);
    this.dialog.modelId.set(model?.modelId ?? '');
    this.dialog.show.set(true);
  }

  /** Close the dialog (used by Cancel and Escape). */
  cancel(): void {
    this.dialog.close();
  }

  /** Clamp the "plan chapters" input (1..50) — templates cannot use Math. */
  setPlanChapters(value: number | string): void {
    this.dialog.setPlanChapters(value);
  }

  /** Toggle "stick to last chapter". While checked the First/Last fields are
   *  disabled and shown as the single chapter last elaborated for this chat;
   *  unchecking restores the default continuation (= last elaborated + 1). */
  onStickLastToggle(checked: boolean): void {
    this.dialog.onStickLastToggle(checked, this.chatService.currentChatId());
  }

  // ------------------------------------------------------------------
  // Anchor + model resolution
  // ------------------------------------------------------------------

  /** Last assistant answer ON THE CURRENTLY VISIBLE TREE (the active path),
   *  not the most recent one in the whole chat — a newer branch the user has
   *  navigated away from must never become the elaborate attach point. */
  private activeTreeAssistantNode(): ChatNode | null {
    const path = this.chatService.getActivePath();
    for (let i = path.length - 1; i >= 0; i--) {
      const n = path[i];
      if (n.role === 'assistant' && n.content?.trim()) return n;
    }
    return null;
  }

  /** Model of the visible tree's last assistant answer, resolvable to a ModelEntry. */
  private resolveElaborateModel(node: ChatNode): ModelEntry | null {
    const models = this.settings.enabledModels();
    return models.find(m => !!node.modelId && (m.modelId === node.modelId || m.id === node.modelId))
      ?? models.find(m =>
        m.modelId === this.lastModelService.selectedModelId() ||
        m.id === this.lastModelService.selectedModelId())
      ?? models[0]
      ?? null;
  }

  /** Resolve the selected (overrideable) elaborate model to entry + provider. */
  private resolveSelectedElaborateModel(): { model: ModelEntry; provider: ProviderConfig } | null {
    const models = this.settings.enabledModels();
    const model = models.find(m =>
      !!this.dialog.modelId() &&
      (m.modelId === this.dialog.modelId() || m.id === this.dialog.modelId())
    )
      ?? models.find(m =>
        m.modelId === this.lastModelService.selectedModelId() ||
        m.id === this.lastModelService.selectedModelId())
      ?? models[0];
    if (!model) return null;
    const provider = this.settings.providers().find(p => p.id === model.providerId);
    return provider ? { model, provider } : null;
  }

  // ------------------------------------------------------------------
  // Confirm — run the sequential elaborations
  // ------------------------------------------------------------------

  /** Confirm the dialog and run the sequential elaborations. */
  async confirm(): Promise<void> {
    const chatId = this.chatService.currentChatId();
    this.dialog.show.set(false);
    if (!chatId) return;

    const firstRaw = this.dialog.first();
    let first = Math.max(firstRaw, 1);
    let last = this.dialog.last();

    // "Stick to last chapter": ignore the First/Last values and re-elaborate
    // the chapter that was last elaborated for THIS chat. The new question is
    // chained under the visible tree's last assistant answer (which holds the
    // already generated text of that chapter), so the model continues it in
    // context.
    if (this.dialog.stickLast()) {
      const state = this.dialog.loadState(chatId);
      last = state.lastChapter > 0 ? state.lastChapter : Math.max(last, 1);
      first = last;
    }
    if (last < first) return;

    const names = this.dialog.names()
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const prefix = this.dialog.prefix().trim();
    const hints = this.dialog.hintsText();

    const anchor = this.activeTreeAssistantNode();
    if (!anchor) return;

    const resolved = this.resolveSelectedElaborateModel();
    if (!resolved) {
      alert(this.i18n.t('chat.elaborateNoModel'));
      return;
    }
    const { model, provider } = resolved;

    // Chapter plan: when enabled, every elaboration send carries the matching
    // entry plus the following ones (N in TOTAL, counting the elaborated
    // chapter) as a TEMPORARY lore section. The plan is the node's stored
    // `chapter-plan.json` record (or a parsed hand-written list); nothing is
    // written to chat.lore.
    const plan = this.dialog.usePlan() ? this.dialog.activePlan() : null;
    const planChapters = this.dialog.planChapters();

    // Remember what was used, per chat, for the next dialog opening.
    this.dialog.saveState(chatId, {
      lastChapter: last,
      characters: this.dialog.names(),
      hints: this.dialog.hints(),
      prefix,
      usePlan: this.dialog.usePlan(),
      usePlanOff: !this.dialog.usePlan(),
      planChapters,
      planNodeId: this.dialog.planNodeId()
    });

    // One Stop press cancels the whole chain (all chapters / views).
    const opSignal = this.chatService.beginChatOperation(chatId, 'elaborate');
    if (!opSignal) {
      this.toast.error(this.i18n.t('node.busy'));
      return;
    }
    this.isElaborating.set(true);
    this.chatService.elaborating = true;
    const started: HeldRun[] = [];
    // Hard Stop (aborted operation signal) ends the chain IMMEDIATELY; a
    // graceful "Finish & stop" (requestGracefulStop) also ends it, but only
    // AFTER the current chapter has streamed to completion and been saved.
    // The signal is forwarded into every held chapter stream, so a chapter
    // whose preparation was still running when Stop was pressed never issues
    // its LLM request.
    const stopped = () => opSignal.aborted || this.chatService.shouldStopAfterCurrentStep();
    try {
      const topicId = this.dialog.topicId(chatId);

      // Build the FULL list of prepared prompts first (each chapter, and each
      // named view within it). The stop checks still run between chapters and
      // views — nothing is started here. Each prompt remembers its CHAPTER
      // number, so the toolbar progress can show "chapter N → destination"
      // (a chapter may consist of several named views).
      const prompts: { prompt: string; chapter: number; loreExtra: string; kind?: 'complete' }[] = [];
      for (let chapter = first; chapter <= last; chapter++) {
        // Hard Stop aborts the operation; a graceful "Finish & stop" also
        // ends the chain, but only AFTER the current chapter's answer has
        // streamed to completion and been saved.
        if (stopped()) break;
        // No names → one generic elaboration per chapter.
        // With names → one elaboration per name, in first person; only the very
        // first view is "first" — the template renders the non-repetition
        // instruction via {{#if isFirst}} for every follow-up view. When
        // sticking to the last chapter we re-elaborate existing text, so no
        // view is ever the "first" one ({{#if isFirst}} always resolves false).
        const chapterPrompts = names.length > 0
          ? names.map((name, i) => this.promptDefaults.render('structure.elaborate-view', {
              chapter: `${prefix}${chapter}`,
              name,
              hints,
              isFirst: !this.dialog.stickLast() && i === 0
            }, topicId))
          : [this.promptDefaults.render('structure.elaborate', { chapter: `${prefix}${chapter}`, hints }, topicId)];
        // The plan slice is per CHAPTER (not per named view): "this chapter +
        // the next N" — the same temporary lore section for every view.
        const loreExtra = plan ? chapterPlanSlice(plan, chapter, planChapters) : '';
        for (const prompt of chapterPrompts) {
          if (stopped()) break;
          prompts.push({ prompt, chapter, loreExtra });
        }
        // A chapter that ends mid-sentence is completed by its OWN direction
        // message before the next chapter starts. The placeholder is skipped
        // at run time when the chapter's text already ended properly. The text
        // comes from the editable `structure.completeChapter` template.
        if (chapter < last) {
          prompts.push({
            prompt:
              this.promptDefaults.render('structure.completeChapter', {}, topicId)
              || 'complete the preceding chapter',
            chapter,
            loreExtra,
            kind: 'complete'
          });
        }
      }
      if (prompts.length === 0) return;
      // The plan is enabled but covers none of the requested chapters — say so
      // instead of silently sending without the plan section.
      if (plan && prompts.every(p => !p.loreExtra)) {
        this.toast.info(
          this.i18n.t('chat.elaboratePlanNoMatch', {
            first,
            last,
            range: chapterPlanLabel(plan),
          }),
        );
      }

      // A shared PRESENTER QUEUE decouples presenting from generation: each
      // chapter registers as a slot — the first becomes the live head (its
      // reveal slows to the input speed while the LLM fills it), every later
      // step's LLM call runs in the background BUFFERING its text (nothing
      // paints), and the queue reveals it in order once the current head has
      // fully revealed. Any batch producer can reuse this exact pattern.
      const queue = new RevealQueue(this.chatService.streamRevealPrefs(), (slot, content, thinking) => {
        this.chatService.updateNodes(list =>
          list.map(n => (n.id === slot.targetId ? { ...n, content, thinking } : n))
        );
      }, { onHeadChange: id => this.chatService.setPresentedNode(id, chatId) });

      let parentId: string | null = anchor.id;
      const startStep = async (
        prompt: string,
        loreExtra: string,
        prev?: HeldRun
      ): Promise<HeldRun> => {
        // The anchor for each step is the answer node of the previous one
        // (the first anchor is the visible tree's last assistant answer).
        const parentNode = parentId
          ? this.chatService.currentNodes().find(n => n.id === parentId) ?? anchor
          : anchor;
        const run = await this.llmRunner.runHeld({
          chat: this.chatService.chats().find(c => c.id === chatId) ?? null,
          node: parentNode,
          usecase: 'send-elaborate',
          vars: {
            content: prompt,
            modelId: model.modelId,
            providerId: model.providerId,
            // TEMPORARY lore section: this chapter's plan entry + the next N.
            ...(loreExtra ? { loreExtra } : {}),
            // The previous chapter's reveal pump clamps its node's displayed
            // content to the revealed slice while its tail is still pacing —
            // pass the FULL text so this chapter's context is never truncated.
            ...(prev?.answerNodeId
              ? { historyOverrides: { [prev.answerNodeId]: prev.finalContent() } }
              : {})
          }
        }, { signal: opSignal, queue });
        started.push(run);
        return run;
      };

      // The FIRST chapter is the queue head — it reveals live as it streams.
      // Every later chapter is prefetched as a background slot.
      this.chatService.batchProgress.set({ current: prompts[0].chapter, total: last, unit: 'chapter' });
      let current: HeldRun | null = await startStep(
        prompts[0].prompt,
        prompts[0].loreExtra,
      );
      for (let i = 1; i < prompts.length; i++) {
        // Wait for the current chapter's LLM to STOP, then finalize it — the
        // data model is complete from here on, so the NEXT chapter's context
        // (built when it is prefetched) is correct.
        await current.streamDone;
        await current.finalize(opSignal);
        parentId = current.answerNodeId ?? parentId;
        // Graceful / hard stop: drain the current tail, then stop the chain.
        if (stopped()) {
          await current.drain(opSignal);
          current = null;
          break;
        }
        // A "complete the preceding chapter" placeholder only gets sent when
        // the chapter's text did not end like a proper sentence; otherwise it
        // is skipped and the next chapter's prompt follows directly.
        //
        // The completion answer can itself stop mid-sentence, so it is sent
        // again — bounded by MAX_COMPLETION_DIRECTIONS so a model that keeps
        // truncating can never loop forever. The truncated tail simply stays
        // in the story and the chain continues from the last answer.
        if (prompts[i].kind === 'complete') {
          let attempts = 0;
          while (attempts < MAX_COMPLETION_DIRECTIONS && !isSentenceComplete(current.finalContent())) {
            if (stopped()) break;
            // Each attempt is anchored under the previous answer (the chapter
            // itself, then the preceding completion).
            parentId = current.answerNodeId ?? parentId;
            const completion = await startStep(
              prompts[i].prompt,
              prompts[i].loreExtra,
              current,
            );
            // A Stop / "Finish & stop" that landed while the completion was
            // being prepared ends the chain with the previous answer.
            if (stopped()) {
              await completion.discard();
              await current.drain(opSignal);
              current = null;
              break;
            }
            // Keep pacing the previous tail, then run the completion.
            await current.drain(opSignal);
            if (this.chatService.gracefulStop()) {
              await completion.discard();
              current = null;
              break;
            }
            await completion.streamDone;
            await completion.finalize(opSignal);
            parentId = completion.answerNodeId ?? parentId;
            current = completion;
            attempts++;
          }
          if (!current) break;
          // Nothing needed completing (or the last attempt still truncated):
          // keep pacing the current tail and continue with the next chapter.
          await current.drain(opSignal);
          if (this.chatService.gracefulStop()) {
            current = null;
            break;
          }
          continue;
        }
        // Prefetch the NEXT prepared chapter (or the completion direction) as
        // a BACKGROUND slot — its LLM runs immediately but its text buffers
        // (nothing paints yet).
        const next = await startStep(
          prompts[i].prompt,
          prompts[i].loreExtra,
          current,
        );
        // A Stop / "Finish & stop" that landed while this chapter was being
        // prepared (question/lore creation) ends the chain with the PREVIOUS
        // chapter: `next` never became the current one, so it is dropped
        // together with the nodes it just created.
        if (stopped()) {
          await next.discard();
          await current.drain(opSignal);
          current = null;
          break;
        }
        // Keep pacing the current tail; once it fully reveals, the queue
        // advances to `next` and the reveal flows seamlessly into it. The
        // chapter counter advances only THEN — it follows the chapter being
        // WRITTEN on screen, not the one merely prefetched in the background.
        await current.drain(opSignal);
        // A "Finish & stop" pressed while the tail was still revealing also
        // ends the chain with the CURRENT chapter — the prefetched chapter
        // never reached the screen.
        if (this.chatService.gracefulStop()) {
          await next.discard();
          current = null;
          break;
        }
        this.chatService.batchProgress.set({ current: prompts[i].chapter, total: last, unit: 'chapter' });
        current = next;
      }
      // Final chapter.
      if (current) {
        await current.streamDone;
        await current.finalize(opSignal);
        await current.drain(opSignal);
      }
    } catch (err: any) {
      if (this.chatService.isOperationCancelled()) return; // user stopped — not an error
      console.error(err);
      alert(this.i18n.t('chat.elaborateFailed', { error: err?.message || err }));
    } finally {
      // Abort any still-running held streams (error / hard stop).
      for (const run of started) run.abort();
      this.chatService.clearGeneration();
      this.chatService.batchProgress.set(null);
      this.isElaborating.set(false);
      this.chatService.elaborating = false;
      this.chatService.endChatOperation(chatId);
    }
  }
}