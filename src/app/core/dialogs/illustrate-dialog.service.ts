import { Injectable, signal } from '@angular/core';
import {
  clampHistoryNodes,
  clampIllustrateCount,
  defaultIllustrateOptions,
  IllustrateOptions,
  isIllustrateHistoryMode
} from '../../models/illustrate-options';
import { createModalState } from './modal-state';

const LS_KEY = 'chat.illustrateOptions.v1';

function readLast(): IllustrateOptions {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultIllustrateOptions();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultIllustrateOptions();
    const purePictures = typeof parsed.purePictures === 'boolean' ? parsed.purePictures : false;
    return {
      count: clampIllustrateCount(typeof parsed.count === 'number' ? parsed.count : 1),
      style: typeof parsed.style === 'string' ? parsed.style : '',
      storyboardPrompt: typeof parsed.storyboardPrompt === 'string' ? parsed.storyboardPrompt : '',
      purePictures,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
      providerId: typeof parsed.providerId === 'string' ? parsed.providerId : '',
      historyMode: isIllustrateHistoryMode(parsed.historyMode) ? parsed.historyMode : 'single',
      historyNodes: clampHistoryNodes(typeof parsed.historyNodes === 'number' ? parsed.historyNodes : undefined),
      storyboardHistoryNodes: clampHistoryNodes(typeof parsed.storyboardHistoryNodes === 'number' ? parsed.storyboardHistoryNodes : undefined),
      // Pure picture mode requires the derived descriptions, so planning is
      // always on there — even for legacy/corrupt stored entries.
      planDescriptions: purePictures ? true : (typeof parsed.planDescriptions === 'boolean' ? parsed.planDescriptions : true)
    };
  } catch {
    return defaultIllustrateOptions();
  }
}

function persist(opts: IllustrateOptions): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(opts));
  } catch {
    // storage may be unavailable (private mode / SSR) — ignore.
  }
}

/**
 * Holds the open state of the Illustrate dialog (mounted once in the app root,
 * mirroring ConfirmService/ConfirmDialogComponent) and remembers the last-used
 * count / style / storyboard prompt between runs.
 */
@Injectable({ providedIn: 'root' })
export class IllustrateDialogService {
  private readonly modal = createModalState<IllustrateOptions, IllustrateOptions>();

  /** The dialog entry, or null when the dialog is closed. */
  readonly current = this.modal.current;
  /** Last confirmed options (seeded from localStorage). */
  readonly last = signal<IllustrateOptions>(readLast());

  /**
   * Open the dialog. Resolves with the chosen options, or null on cancel.
   *
   * @param seed initial overrides for fields not (or no longer) remembered —
   *   e.g. `{ modelId, providerId }` for the default rendering model that the
   *   caller resolved. The dialog starts from the last-used options and only
   *   falls back to a seeded model when nothing was remembered yet — the
   *   user's own last choice wins over the settings default.
   */
  open(seed: Partial<IllustrateOptions> = {}): Promise<IllustrateOptions | null> {
    const last = this.last();
    const seeded = { ...last, ...seed };
    return this.modal.open({
      ...seeded,
      // Last-used model wins over the settings-default seed; the seed only
      // fills the gap when no model was remembered yet.
      modelId: last.modelId || seeded.modelId,
      providerId: last.providerId || seeded.providerId
    });
  }

  /** Confirm: remember + resolve with the chosen options. */
  submit(options: IllustrateOptions): void {
    const clamped: IllustrateOptions = {
      count: clampIllustrateCount(options.count),
      style: (options.style || '').trim(),
      storyboardPrompt: (options.storyboardPrompt || '').trim(),
      purePictures: !!options.purePictures,
      modelId: (options.modelId || '').trim(),
      providerId: (options.providerId || '').trim(),
      historyMode: isIllustrateHistoryMode(options.historyMode) ? options.historyMode : 'single',
      historyNodes: clampHistoryNodes(options.historyNodes),
      storyboardHistoryNodes: clampHistoryNodes(options.storyboardHistoryNodes),
      // Pure picture mode REQUIRES the derived descriptions (raw story prose
      // must never reach the image model), so planning is forced back on.
      planDescriptions: options.purePictures ? true : (options.planDescriptions !== false)
    };
    this.last.set(clamped);
    persist(clamped);
    this.modal.close(clamped);
  }

  /** Cancel: close and resolve with null. */
  cancel(): void {
    this.modal.close(null);
  }
}