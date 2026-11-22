import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The removed `/workspaces` index took the `?new=1` query-string form with
 * it: it opened the create modal. Create now lives on `/workspaces/new`.
 *
 * Scoped to the query-string form deliberately, not to the bare `/workspaces`
 * string: `/workspaces` itself is still a real prefix for `/workspaces/:id`, so a
 * whole-string sweep cannot tell a destination (wrong, must repoint) from a
 * prefix/allowlist check (`startsWith('/workspaces')`, `pathname.indexOf(...)`)
 * that legitimately still matches every open project. `?new=1` has no such
 * double meaning — nothing needs it to survive.
 */
const SRC = join(import.meta.dir, '..', '..');

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full;
  }
}

describe('no links to the removed projects index', () => {
  test('nothing routes to /workspaces?new=1 — create lives at /new', () => {
    const offenders = [...sourceFiles(SRC)].filter((file) =>
      readFileSync(file, 'utf8').includes('/workspaces?new=1'),
    );
    expect(offenders).toEqual([]);
  });
});
