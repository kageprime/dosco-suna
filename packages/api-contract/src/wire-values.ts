/**
 * The closed value sets the session wire carries, defined once.
 *
 * Each set is a `const` tuple, its type is derived from it, and each decision a
 * client makes on a value is a function here, so no client compares a free
 * string of its own. They live in the published `@kortix/sdk` now
 * (`packages/sdk/src/core/wire-values.ts`); this file keeps every import path
 * (`@kortix/api-contract/wire-values`, the barrel in `index.ts`) and every
 * exported name, so apps/api and kortixd keep resolving it. kortixd's
 * standalone build vendors the SDK file the way it already does
 * `wire-message-id` (`KORTIXD_SHARED_SOURCES`, tsconfig paths, Dockerfile
 * COPY).
 */
export * from '@kortix/sdk/wire-values';
