import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { resolveTurbopackFileSystemCacheForBuild } from './turbopack-build-cache';

const GB = 1024 ** 3;
const nextConfig = readFileSync(new URL('../../next.config.ts', import.meta.url), 'utf8');

describe('resolveTurbopackFileSystemCacheForBuild', () => {
  const KEY = 'KORTIX_TURBOPACK_BUILD_CACHE';
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
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
    expect(resolveTurbopackFileSystemCacheForBuild(11.3 * GB)).toBe(false);
  });

  test('unset: 16 GB CI runner keeps upstream default (on)', () => {
    delete process.env[KEY];
    expect(resolveTurbopackFileSystemCacheForBuild(16 * GB)).toBe(true);
  });

  test('empty string is not an override', () => {
    process.env[KEY] = '';
    expect(resolveTurbopackFileSystemCacheForBuild(16 * GB)).toBe(true);
    expect(resolveTurbopackFileSystemCacheForBuild(11.3 * GB)).toBe(false);
  });

  test('a typo falls back to the memory-based default', () => {
    process.env[KEY] = 'ful';
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
});
