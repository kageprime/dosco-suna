import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { resolveTurbopackFileSystemCacheForBuild } from './turbopack-build-cache';

const GB = 1024 ** 3;
const nextConfig = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');
const vercelJson = JSON.parse(
  readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'),
) as { buildCommand?: string };

describe('resolveTurbopackFileSystemCacheForBuild', () => {
  const KEY = 'KORTIX_TURBOPACK_BUILD_CACHE';
  const VERCEL_KEY = 'VERCEL';
  const saved = process.env[KEY];
  const savedVercel = process.env[VERCEL_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    if (savedVercel === undefined) delete process.env[VERCEL_KEY];
    else process.env[VERCEL_KEY] = savedVercel;
  });

  test('explicit override wins over memory', () => {
    process.env[KEY] = 'off';
    expect(resolveTurbopackFileSystemCacheForBuild(32 * GB)).toBe(false);
    process.env[KEY] = 'on';
    expect(resolveTurbopackFileSystemCacheForBuild(4 * GB)).toBe(true);
  });

  test('unset: small machine (KRTX-4741 sandbox) defaults off', () => {
    // The measured OOM: 11 GB sandbox, no swap — the persistent build cache
    // pushed the build to 9.5 GB RSS and the kernel OOM killer SIGKILLed it.
    delete process.env[KEY];
    delete process.env[VERCEL_KEY];
    expect(resolveTurbopackFileSystemCacheForBuild(11.3 * GB)).toBe(false);
  });

  test('unset on Vercel container defaults off even when host os.totalmem() exceeds 14 GB', () => {
    delete process.env[KEY];
    process.env[VERCEL_KEY] = '1';
    expect(resolveTurbopackFileSystemCacheForBuild(32 * GB)).toBe(false);
  });

  test('unset: 16 GB CI runner keeps upstream default (on)', () => {
    delete process.env[KEY];
    delete process.env[VERCEL_KEY];
    expect(resolveTurbopackFileSystemCacheForBuild(16 * GB)).toBe(true);
  });

  test('empty string is not an override', () => {
    process.env[KEY] = '';
    delete process.env[VERCEL_KEY];
    expect(resolveTurbopackFileSystemCacheForBuild(16 * GB)).toBe(true);
    expect(resolveTurbopackFileSystemCacheForBuild(11.3 * GB)).toBe(false);
  });

  test('a typo falls back to the memory-based default', () => {
    process.env[KEY] = 'ful';
    delete process.env[VERCEL_KEY];
    expect(resolveTurbopackFileSystemCacheForBuild(16 * GB)).toBe(true);
    expect(resolveTurbopackFileSystemCacheForBuild(11.3 * GB)).toBe(false);
  });
});

describe('next.config.ts wiring', () => {
  // A source-level contract, like turbopack-gc.test.ts: next.config.ts's default
  // export runs the blume docs build, so a unit test cannot call it and assert
  // the resolved value. Both lines are pinned so deleting either fails.
  test('build cache goes through the resolver', () => {
    expect(nextConfig).toMatch(
      /^import \{ resolveTurbopackFileSystemCacheForBuild \} from '\.\/src\/config\/turbopack-build-cache';$/m,
    );
    expect(nextConfig).toMatch(/^\s*turbopackFileSystemCacheForBuild: resolveTurbopackFileSystemCacheForBuild\(\),$/m);
  });

  test('next.config.ts never pairs cpus: 1 with turbopackPluginRuntimeStrategy: workerThreads', () => {
    // Pairing cpus: 1 with workerThreads deadlocks @tailwindcss/oxide N-API and custom
    // loaders inside the single worker thread for 30+ minutes on Vercel.
    expect(nextConfig).not.toMatch(/turbopackPluginRuntimeStrategy:\s*['"](?:force)?[wW]orkerThreads['"]/);
  });

  test('vercel.json buildCommand fits <= 256 chars, uses Turbopack, and prunes non-prod routes', () => {
    const cmd = vercelJson.buildCommand ?? '';
    expect(cmd.length).toBeGreaterThan(0);
    expect(cmd.length).toBeLessThanOrEqual(256);
    expect(cmd).not.toContain('--webpack');
    expect(cmd).toContain('--debug-build-paths');
    expect(cmd).toContain('!app/**/debug/**');
    expect(cmd).toContain('!app/**/presentations/**');
    expect(cmd).toContain('!app/**/design-system/**');
    expect(cmd).toContain('!app/**/capture/**');
    expect(cmd).toContain('!app/**/eval*/**');
  });
});
