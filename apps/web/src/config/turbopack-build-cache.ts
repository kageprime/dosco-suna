import os from 'os';

/**
 * Whether `next build` uses Turbopack's persistent build cache
 * (`experimental.turbopackFileSystemCacheForBuild`).
 *
 * Measured on this app (KRTX-4741, 2026-11-11, an 11 GB sandbox with no swap):
 * with the cache on, the single `next build` process peaked at 9.4-9.5 GB RSS
 * during compile and the kernel OOM killer SIGKILLed it (shell exit 137,
 * `/proc/vmstat` `oom_kill`). With the cache off, the same build peaked at
 * 7.2 GB across compile and 1,567 prerender pages, and completed. A sandbox
 * cannot hold the cache; a 16 GB CI runner can — and it keeps the warm build
 * the cache buys (compile 36.3 s -> 1.9 s warm, see the 16.3 posture note in
 * next.config.ts). So the default is memory-based, with an explicit override.
 *
 * `KORTIX_TURBOPACK_BUILD_CACHE=on|off` forces the decision; unset resolves on
 * total RAM (off below 14 GB, upstream's `on` at or above it). Validate the
 * raw string rather than cast: an unset var, an empty string (`FOO= pnpm build`)
 * and a typo are three different mistakes, and only the first should silently
 * mean "decide for me".
 */
const SMALL_MACHINE_BUILD_CACHE_MAX_BYTES = 14 * 1024 ** 3;

export function resolveTurbopackFileSystemCacheForBuild(totalMem: number = os.totalmem()): boolean {
  const raw = process.env.KORTIX_TURBOPACK_BUILD_CACHE;
  if (raw === 'off' || raw === 'false') return false;
  if (raw === 'on' || raw === 'true') return true;
  if (raw !== undefined && raw !== '') {
    console.warn(
      `[next.config.ts] Ignoring KORTIX_TURBOPACK_BUILD_CACHE=${JSON.stringify(raw)} — ` +
        `expected one of 'on', 'off'. Falling back to the memory-based default.`,
    );
  }
  return totalMem >= SMALL_MACHINE_BUILD_CACHE_MAX_BYTES;
}
