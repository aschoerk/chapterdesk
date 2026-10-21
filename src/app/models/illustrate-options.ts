/**
 * User choices captured by the Illustrate dialog. The values are persisted
 * (last-used) so the next Illustrate starts from the previous configuration.
 */
export interface IllustrateOptions {
  /** Number of scenes to render (1 = single picture, N>1 = storyboard). */
  count: number;
  /** Free-form style hint, e.g. "comic style, sketchy ink". Empty = none. */
  style: string;
  /**
   * Extra storyboard instruction applied when count > 1 (e.g. "no explicit
   * images, hide behind bystanders, furniture, shadows"). Unused for count=1.
   */
  storyboardPrompt: string;
  /**
   * Pure picture mode: send the image model ONLY temporal-free picture
   * descriptions derived from the story text (plus the consistency rules),
   * never the raw story prose. Image models are less tolerant of sensitive
   * story content than text models, so stripping the temporal context lowers
   * moderation rejects. The derived descriptions are sent to the image model
   * EN-BLOCK first so the image model itself controls character / setting /
   * style consistency across all pictures.
   */
  purePictures: boolean;
  /**
   * Image model chosen in the dialog that renders the picture(s)
   * (`ModelEntry.modelId`, e.g. `openai/gpt-image-1`). Empty means "use the
   * configured default image-create task model".
   */
  modelId: string;
  /** Provider of the chosen model (`ModelEntry.providerId`). */
  providerId: string;
  /**
   * How much story context is delivered to the model:
   * - 'single' (default): only the current node's text is sent as a single
   *   final message.
   * - 'window': the content of the last `historyNodes` chat nodes up to (and
   *   including) the current node is sent in normal form as user/assistant
   *   messages, with the current node's text as the final message — a bounded
   *   slice of the story instead of the complete chat.
   * - 'full': the complete chat up to (and including) the current node is
   *   sent as context.
   * For a single picture this bounds what the image model sees; for a
   * storyboard (count > 1) it bounds what the planning text model sees.
   */
  historyMode: 'single' | 'window' | 'full';
  /**
   * Window width for 'window' mode when rendering a SINGLE picture
   * (count === 1): number of recent assistant-node texts used as context,
   * INCLUDING the current node (1 = just the current beat). Remembered
   * separately from the storyboard width, because the two use cases usually
   * want a different amount of context. Ignored in 'single' mode.
   */
  historyNodes: number;
  /**
   * Window width for 'window' mode when rendering a STORYBOARD (count > 1):
   * number of recent assistant-node texts used as context, INCLUDING the
   * current node (1 = just the current beat). This bounds what the planning
   * (text) model sees before it derives the picture descriptions. Remembered
   * separately from the single-picture width. Ignored in 'single' mode.
   */
  storyboardHistoryNodes: number;
  /**
   * Picture-description planning: run a TEXT model first to turn the story
   * into concrete picture descriptions, then let the image model render from
   * those. On by default and used for storyboards, assistant chapters and
   * pure picture mode. When disabled the planning pass is skipped and — for a
   * single picture — the story text that would have been sent to the planning
   * model is sent to the image generating model directly (the whole chat up
   * to this point, delivered as one completion — a one-shot even though only
   * one image is requested). Forced back on in pure picture mode, which needs
   * the derived descriptions.
   */
  planDescriptions: boolean;
}

export type IllustrateHistoryMode = IllustrateOptions['historyMode'];

/**
 * The illustration approach chosen in the dialog's "Use case" radio group.
 * Replaces the two separate `purePictures` / `planDescriptions` checkboxes:
 * - 'planned': a TEXT model expands the story into concrete picture
 *   descriptions before the image model renders them (planDescriptions=true,
 *   purePictures=false). Used for storyboards.
 * - 'direct': the story text is sent straight to the image model without a
 *   planning pass (planDescriptions=false, purePictures=false).
 * - 'pure': ONLY derived, temporal-free picture descriptions reach the image
 *   model — never the raw story prose (purePictures=true, planning forced on).
 */
export type IllustrateUsecase = 'planned' | 'direct' | 'pure';

export const ILLUSTRATE_COUNT_MIN = 1;
export const ILLUSTRATE_COUNT_MAX = 64;
/** Window width in 'window' mode: at least 1 (just the current beat), at most 64. */
export const ILLUSTRATE_HISTORY_NODES_MIN = 1;
export const ILLUSTRATE_HISTORY_NODES_MAX = 64;
/** Default window width: the current beat only. */
export const ILLUSTRATE_HISTORY_NODES_DEFAULT = 1;

export function isIllustrateHistoryMode(v: unknown): v is IllustrateHistoryMode {
  return v === 'single' || v === 'window' || v === 'full';
}

export function isIllustrateUsecase(v: unknown): v is IllustrateUsecase {
  return v === 'planned' || v === 'direct' || v === 'pure';
}

export function defaultIllustrateOptions(): IllustrateOptions {
  return {
    count: 1,
    style: '',
    storyboardPrompt: '',
    purePictures: false,
    modelId: '',
    providerId: '',
    historyMode: 'single',
    historyNodes: ILLUSTRATE_HISTORY_NODES_DEFAULT,
    storyboardHistoryNodes: ILLUSTRATE_HISTORY_NODES_DEFAULT,
    planDescriptions: true
  };
}

export function clampIllustrateCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(ILLUSTRATE_COUNT_MIN, Math.min(ILLUSTRATE_COUNT_MAX, Math.floor(count)));
}

export function clampHistoryNodes(n: number): number {
  if (!Number.isFinite(n)) return ILLUSTRATE_HISTORY_NODES_DEFAULT;
  return Math.max(ILLUSTRATE_HISTORY_NODES_MIN, Math.min(ILLUSTRATE_HISTORY_NODES_MAX, Math.floor(n)));
}