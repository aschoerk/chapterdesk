/**
 * Use-case context factory — decomposed along its concerns.
 *
 *   – types.ts   (shared types + image-description record helpers)
 *   – topic.ts   (per-run prompt-topic scope state)
 *   – models.ts  (model/provider resolution + request extras)
 *   – messages.ts(chat-thread messages + image interpretation)
 *   – prompts.ts (instruction / prompt-template builders)
 *   – factory.ts (UsecaseContextFactory facade)
 *
 * The barrel re-exports the original `context.ts` public surface (plus the
 * individual concern services), so every consumer that imports from a bare
 * `'./context'` (the use-case/flow runners, flows, and `orchestration/index.ts`)
 * keeps resolving unchanged.
 */
export {
  IMAGE_DESCRIPTION_RECORD,
  isImageDescriptionRecord,
  imageSetSignature,
  parseStoredImageDescription
} from './types';
export type {
  StoredImageDescription,
  ModelRef,
  BuildContext,
  NodeAttachmentLike,
  ChatNode
} from './types';
export { UsecaseContextFactory } from './factory';
export { ContextTopicService } from './topic';
export { ContextModelResolverService } from './models';
export { ContextMessageBuilderService } from './messages';
export { ContextPromptBuilderService } from './prompts';