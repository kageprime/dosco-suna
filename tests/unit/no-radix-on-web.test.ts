import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, readRepoFile } from '../src/fixtures/repo';

// The web UI's headless layer is Base UI (`@base-ui/react`), behind the
// `@kortix/ui` primitives. Radix and the packages built on it (`cmdk`,
// `vaul`) were removed. This test keeps them out of every web package.
//
// apps/mobile is React Native: `@rn-primitives` pulls web Radix for its own
// web target, and Base UI has no React Native build. It is out of scope.

const BANNED = /^(?:@radix-ui\/.+|radix-ui|cmdk|vaul)$/;
const BANNED_IMPORT = /\bfrom\s+['"](?:@radix-ui\/[^'"]+|radix-ui|cmdk|vaul)['"]|\brequire\(\s*['"](?:@radix-ui\/[^'"]+|radix-ui|cmdk|vaul)['"]/;

const WEB_PACKAGES = ['packages/ui', 'apps/web', 'apps/white-label/lumen', 'apps/white-label/reskin', 'apps/white-label/team-console'];

// The white-label boundary scanners name the banned kits in their own fixtures.
const FIXTURES = new Set(['apps/white-label/lumen/tests/unit/sdk-boundary.test.ts', 'apps/white-label/reskin/tests/e2e/sdk-boundary.test.ts']);

describe('no Radix on web', () => {
  it.each(WEB_PACKAGES)('%s declares no Radix, cmdk or vaul dependency', (dir) => {
    const manifest = JSON.parse(readRepoFile(`${dir}/package.json`)) as Record<string, Record<string, string> | undefined>;
    const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((section) =>
      Object.keys(manifest[section] ?? {}),
    );
    expect(declared.filter((name) => BANNED.test(name))).toEqual([]);
  });

  it('no web source file imports Radix, cmdk or vaul', () => {
    const files = execFileSync('git', ['ls-files', '--', ...WEB_PACKAGES.map((dir) => `${dir}/**/*.ts`), ...WEB_PACKAGES.map((dir) => `${dir}/**/*.tsx`)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .filter((file) => !FIXTURES.has(file));
    expect(files.length).toBeGreaterThan(1000);
    expect(files.filter((file) => BANNED_IMPORT.test(readRepoFile(file)))).toEqual([]);
  });
});
