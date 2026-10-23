/**
 * Image-render USE CASES — controllers + dispatch + top-level runner.
 *
 * Groups the former single `usecases.ts` by concern:
 *   – env.ts            (UsecaseEnv + UsecaseController — shared types)
 *   – render-pipeline.ts (image-model request primitives: batch + fallback +
 *                        reprise, single-scene wrapping)
 *   – storyboard.ts      (storyboardDirect / planned-enblock / planned-scenes)
 *   – renders.ts         (render-full / render-window / render-node /
 *                        image-generation / image-send)
 *   – append.ts          (append / append-with-images — text sends that
 *                        delegate the shared text-send machinery to flows.ts)
 *   – runner.ts          (pickUsecase + dispatch table + LlmUseCaseRunner)
 *
 * The barrel re-exports ONLY the public surface the old `usecases.ts` exposed
 * (the env types + the dispatch/runner), so `orchestration/index.ts` and the
 * spec files that import from a bare `'./usecases'` keep resolving unchanged.
 */
export * from './env';
export * from './runner';