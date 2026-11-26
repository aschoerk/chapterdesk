import { Injectable } from '@angular/core';
import { Chat, ChatNode } from '../../models/chat';
import { createModalState } from './modal-state';

/**
 * Per-chat persistence for the "Design a story concept" dialog. The last
 * inputs are remembered per chat so the next press of the button provides
 * them again; the model is remembered globally (like the other dialogs).
 */
const LS_PARAMS = 'chat.storyConcept.paramsByChatId';
/** Last model selected in the dialog (remembered for the next run). */
const LS_MODEL = 'chat.storyConcept.model.v1';

/** A persona resolved for the concept (only the fields the prompt needs). */
export interface StoryConceptPersona {
  id: string;
  name: string;
  shortName: string;
  description: string;
}

/** The inputs the user enters in the "Design a story concept" dialog. */
export interface StoryConceptParams {
  /** Free-form idea the concept should be designed from. */
  prompt: string;
  /** Personas that must become characters of the concept (ids). */
  personaIds: string[];
  /** Number of chapters to plan; `null` = let the model decide. */
  chapterCount: number | null;
  /** Target length of the finished story in words; `null` = no target. */
  targetWords: number | null;
}

/** What the user confirms in the dialog. */
export interface StoryConceptResult extends StoryConceptParams {
  /** The selected personas resolved to name + description for the prompt. */
  personas: StoryConceptPersona[];
  /** Writing model selected in the dialog. */
  modelId: string;
  /** Provider of the selected model. */
  providerId: string;
}

/** The open dialog state: the prefilled fields + the resolve callback. */
interface StoryConceptData extends Omit<StoryConceptResult, 'personas'> {
  chatId: string;
  chat: Chat | null;
  /** The direction node the concept is branched from. */
  node: ChatNode;
}

/** A remembered model choice (id + provider). */
interface RememberedModel {
  modelId: string;
  providerId: string;
}

function readParamsMap(): Record<string, StoryConceptParams> {
  try {
    const raw = localStorage.getItem(LS_PARAMS);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, StoryConceptParams> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const p = value as Partial<StoryConceptParams>;
      out[key] = {
        prompt: typeof p.prompt === 'string' ? p.prompt : '',
        personaIds: Array.isArray(p.personaIds)
          ? p.personaIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
          : [],
        chapterCount: optionalPositive(p.chapterCount),
        targetWords: optionalPositive(p.targetWords),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeParamsMap(map: Record<string, StoryConceptParams>): void {
  try {
    localStorage.setItem(LS_PARAMS, JSON.stringify(map));
  } catch {
    // storage may be unavailable (private mode / quota) — best-effort.
  }
}

/** Positive integer or `null` (0 / empty / invalid = "not set"). */
function optionalPositive(n: unknown): number | null {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function readModel(): RememberedModel {
  try {
    const raw = localStorage.getItem(LS_MODEL);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { modelId: '', providerId: '' };
    }
    return {
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
      providerId: typeof parsed.providerId === 'string' ? parsed.providerId : '',
    };
  } catch {
    return { modelId: '', providerId: '' };
  }
}

function writeModel(model: RememberedModel): void {
  try {
    localStorage.setItem(LS_MODEL, JSON.stringify(model));
  } catch {
    // storage may be unavailable (private mode / quota) — best-effort.
  }
}

/**
 * Holds the open state of the "Design a story concept" dialog (mounted once in
 * the app root, mirroring ChapterDescriptionsDialogService). The result ends
 * in a chapter description list, which the flow stores as the same
 * `chapter-plan.json` record a later Elaborate run consumes.
 */
@Injectable({ providedIn: 'root' })
export class StoryConceptDialogService {
  private readonly modal = createModalState<StoryConceptData, StoryConceptResult>();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;

  /**
   * Open the dialog for the direction node the concept is branched from.
   * Remembers the last inputs per chat and the last model globally.
   */
  open(opts: {
    chatId: string;
    chat: Chat | null;
    node: ChatNode;
    /** Caller-provided default model (current model of the node). */
    defaultModelId: string;
    defaultProviderId: string;
  }): Promise<StoryConceptResult | null> {
    const stored = readParamsMap()[opts.chatId];
    const remembered = readModel();

    return this.modal.open({
      chatId: opts.chatId,
      chat: opts.chat,
      node: opts.node,
      prompt: stored?.prompt ?? '',
      personaIds: stored?.personaIds ?? [],
      chapterCount: stored?.chapterCount ?? null,
      targetWords: stored?.targetWords ?? null,
      // Remembered model wins; the current model stays the fallback.
      modelId: remembered.modelId || opts.defaultModelId,
      providerId: remembered.providerId || opts.defaultProviderId,
    });
  }

  /** Confirm: remember the inputs for this chat + the model and resolve. */
  submit(result: StoryConceptResult): void {
    const cur = this.current();
    if (!cur) return; // no dialog open — the values are just not resolved
    const normalized: StoryConceptResult = {
      ...result,
      prompt: (result.prompt ?? '').trim(),
      personaIds: (result.personaIds ?? []).filter(id => !!id?.trim()),
      chapterCount: optionalPositive(result.chapterCount),
      targetWords: optionalPositive(result.targetWords),
      modelId: (result.modelId ?? '').trim(),
      providerId: (result.providerId ?? '').trim(),
    };

    const params = readParamsMap();
    params[cur.chatId] = {
      prompt: normalized.prompt,
      personaIds: normalized.personaIds,
      chapterCount: normalized.chapterCount,
      targetWords: normalized.targetWords,
    };
    writeParamsMap(params);

    writeModel({
      modelId: normalized.modelId,
      providerId: normalized.providerId,
    });

    this.modal.close(normalized);
  }

  /** Cancel — close without designing. */
  cancel(): void {
    this.modal.close(null);
  }
}
