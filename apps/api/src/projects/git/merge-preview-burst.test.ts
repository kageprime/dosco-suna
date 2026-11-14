// A burst of merge previews on one project must not each fetch the whole mirror (KRTX-4868).
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { previewMerge } from './merge';
import { createPartialStoreFixture, type PartialStoreFixture } from './__tests__/partial-store-fixture';

let fx: PartialStoreFixture | null = null;
let shimDir: string | null = null;
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  await fx?.cleanup();
  if (shimDir) await rm(shimDir, { recursive: true, force: true });
  fx = null;
  shimDir = null;
});

/** Put a `git` first on PATH that logs each call's arguments, then runs the real one. */
async function logGitCalls(): Promise<() => Promise<string[][]>> {
  shimDir = await mkdtemp(join(tmpdir(), 'git-shim-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const log = join(shimDir, 'calls.log');
  await writeFile(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
  await chmod(join(shimDir, 'git'), 0o755);
  process.env.PATH = `${shimDir}:${originalPath}`;
  return async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => line.split(' '));
}

describe('merge-preview burst', () => {
  test('previews of many heads fetch each head alone, never the whole mirror again', async () => {
    fx = await createPartialStoreFixture({ 'notes.md': 'one\n' });
    const heads = ['cr-a', 'cr-b', 'cr-c', 'cr-d'];
    for (const head of heads) await fx.push({ [`${head}.md`]: `${head}\n` }, head, head);
    const calls = await logGitCalls();
    await previewMerge(fx.project, 'main', heads[0]);
    const afterFirst = (await calls()).filter((args) => args[0] === 'fetch' && args.includes('--prune')).length;

    for (const head of heads) {
      expect(await previewMerge(fx.project, 'main', head)).toMatchObject({ can_merge: true, conflicts: [] });
    }

    const wholeMirrorFetches = (await calls()).filter((args) => args[0] === 'fetch' && args.includes('--prune')).length;
    expect(wholeMirrorFetches - afterFirst).toBe(0);
  });

  test('a head pushed after the first preview is seen by the next one', async () => {
    fx = await createPartialStoreFixture({ 'notes.md': 'one\n' });
    await fx.push({ 'a.md': 'a\n' }, 'a', 'cr');
    const first = await previewMerge(fx.project, 'main', 'cr');
    const newTip = await fx.push({ 'b.md': 'b\n' }, 'b', 'cr');
    const second = await previewMerge(fx.project, 'main', 'cr');
    expect(first.head_sha).not.toBe(newTip);
    expect(second.head_sha).toBe(newTip);
  });
});
