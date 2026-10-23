/**
 * LLM message / attachment utilities — partitioned from the former monolithic
 * `llm-message.ts` utility bag into cohesive modules:
 *
 *   – mime.ts    (mime/attachment-metadata detection + data-url decoding)
 *   – image.ts   (image-generation parsing, prompt-record detection, attachment builders)
 *   – message.ts (message-part types, node→content composition, message serialization)
 *
 * This barrel re-exports the EXACT public surface the old `llm-message.ts`
 * exposed (verified against `llm-message.spec.ts` + all 20 importers), so
 * existing `import … from '…/llm-message'` resolves unchanged. The internal
 * module helpers (`EXT_MIME`, `clipText`, `hasUsableDataUrl`, `IMAGE_MIME_EXT`,
 * `extractImageUrlsFromText`, …) are deliberately NOT re-exported.
 */
export type { MessagePart } from './message';
export { PREPEND_MAX_TOKENS, estimateContentTokens, messageText, nodeToMessageContent, normalizeChatMessages } from './message';

export {
  fileExtension,
  inferMimeType,
  mimeFromDataUrl,
  resolvedMime,
  isImageMime,
  isTextualMime,
  decodeDataUrlToText
} from './mime';

export {
  isPromptRecordAttachment,
  isGeneratedImageAttachment,
  extractLlmRefusal,
  extractLlmImages,
  estimateDataUrlBytes,
  imagePartToAttachment,
  textPromptAttachment
} from './image';
export type { LlmImagePart } from './image';