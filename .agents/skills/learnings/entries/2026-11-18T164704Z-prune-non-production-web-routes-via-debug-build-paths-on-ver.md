---
recorded: 2026-11-18T16:47:04Z
incident_date: 2026-11-18
---
# Prune non-production web routes via --debug-build-paths on Vercel and never pair cpus: 1 with workerThreads

**Rule:** Keep `apps/web/vercel.json`'s `buildCommand` on Turbopack (`NODE_OPTIONS=--max-old-space-size=3584 next build`) with `--debug-build-paths` excluding non-production routes (`!app/**/debug/**`, `!app/**/presentations/**`, `!app/**/design-system/**`, `!app/**/capture/**`, `!app/**/eval*/**`, `!app/**/loopmaxxing/**`, `!app/**/rauch/**`, `!app/**/a1o/**`), keep `buildCommand` at or under 256 characters, never switch Vercel to `--webpack`, and never set `turbopackPluginRuntimeStrategy: 'workerThreads'` alongside `cpus: 1` in `apps/web/next.config.ts`.

**Trigger surface:** Editing `apps/web/vercel.json`, `apps/web/next.config.ts`, `apps/web/src/config/turbopack-build-cache.ts`, adding new internal/debug/eval/demo route trees under `apps/web/src/app`, or syncing upstream merges into `apps/web`.

**Incident:** Between 2026-11-16 and 2026-11-18 (after `1ec5c24581`), ~20 consecutive Vercel deployments failed. Upstream merges had grown `apps/web/src/app` to 198 entrypoints (including 32 `/debug/*` visual test harnesses, `/design-system/*`, `/presentations/*`, `/capture/*`, and `/eval*`), pushing cold Turbopack RSS slightly past the 8 GB Vercel cgroup ceiling (`[BUILD_UTILS_SPAWN_SIGKILL]`). Switching to `--webpack` failed at both 4096 MB (`SIGABRT` heap exhaustion) and 5120–6144 MB (`SIGKILL` container OOM), and setting `turbopackPluginRuntimeStrategy: 'workerThreads'` with `cpus: 1` deadlocked `@tailwindcss/oxide` N-API and custom loaders for 30+ minutes. Restoring the `1ec5c24581` Turbopack config and pruning 54 non-production routes via `--debug-build-paths` (198 -> 144 routes, 236-char `buildCommand`) made the Vercel build succeed cleanly.

**Enforcement:** `apps/web/src/config/turbopack-build-cache.test.ts` asserts that `apps/web/vercel.json` `buildCommand` is `<= 256` characters, does not use `--webpack`, passes `--debug-build-paths` excluding non-production route globs, that `resolveTurbopackFileSystemCacheForBuild()` returns `false` on Vercel, and that `apps/web/next.config.ts` never enables `turbopackPluginRuntimeStrategy: 'workerThreads'`.
