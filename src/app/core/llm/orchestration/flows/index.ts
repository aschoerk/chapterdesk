/**
 * Structural text-send FLOWS — controllers + dispatch + top-level runner.
 *
 * Groups the former single `flows.ts` by concern:
 *   – env.ts       (FlowEnv + FlowController — shared types)
 *   – text-send.ts (the SHARED text-send pipeline: prepareTextSend,
 *                   streamAnswerNode, image-only answer helpers — also used by
 *                   the append use cases in usecases/append.ts)
 *   – sends.ts     (the chat-mutating send controllers: branch / insert /
 *                   regenerate / rewrite / prepend / elaborate /
 *                   chapter-descriptions)
 *   – structure.ts (structure-title/overview/heading/headings, language-check,
 *                   rewrite-selection — non-mutating or structure-node text
 *                   completions)
 *   – runner.ts    (dispatch table + LlmFlowRunner)
 *
 * The barrel re-exports ONLY the public surface the old `flows.ts` exposed,
 * so `orchestration/index.ts` and the consumers that import from a bare
 * `'./flows'` (flows.spec.ts, usecases/append.ts, usecases/runner.ts) keep
 * resolving unchanged.
 */
export * from './env';
export { prepareTextSend, generatedImageAttachments, imageOnlyAnswerContent } from './text-send';
export { isFlowUsecase, flowControllerFor, LlmFlowRunner } from './runner';