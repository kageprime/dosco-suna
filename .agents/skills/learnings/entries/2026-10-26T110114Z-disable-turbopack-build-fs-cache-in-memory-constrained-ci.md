---
recorded: 2026-10-26T11:01:14Z
incident_date: 2026-10-26
---
# Disable Turbopack build filesystem cache in memory-constrained CI environments

**Rule:** Always set `experimental.turbopackFileSystemCacheForBuild: false` in `next.config.ts` when building on platforms with strict build cache size limits (such as Vercel Hobby's 1.5 GB limit). Pair with `turbopackMemoryEviction: 'full'` and `turbopackGc: { minProgressMs: 100, rootTtlMs: 0 }`.

**Trigger surface:** Next.js 16 production builds (`next build`) in CI/CD containers with ≤ 8 GB RAM where persistent build cache is pruned or unsupported.

**Incident:** On 2026-10-26, after merging 596 upstream commits, Vercel frontend builds failed repeatedly with exit code `[BUILD_UTILS_SPAWN_SIGKILL]`, error `out_of_memory`. Next.js 16 defaults `experimental.turbopackFileSystemCacheForBuild` to `true`. On this monorepo, Turbopack wrote a 2.39 GB build cache to `.next/cache`. Because Vercel Hobby discards any cache over 1.5 GB, each build started cold and wasted ~1–1.5 GB resident memory buffering and serializing cache data. Combined with default `turbopackMemoryEviction: 'auto'` and 3-day `rootTtlMs`, container RSS exceeded the 8 GB ceiling during compilation. Disabling the build cache, enforcing `'full'` memory eviction, and immediate GC root expiration brought compilation safely into the 8 GB envelope and allowed production deployment to complete in 10m46s.

**Enforcement:** `apps/web/next.config.ts` validates `resolveTurbopackFileSystemCacheForBuild()`, returning `false` whenever `process.env.VERCEL` is set.
