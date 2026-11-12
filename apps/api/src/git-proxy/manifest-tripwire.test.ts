/**
 * The manifest tripwire names a default branch that carries no kortix.yaml
 * after a push. That state is an expected, tolerated project configuration —
 * the push itself succeeded and the project runs its built-in agents — so the
 * tripwire logs at WARN, never at ERROR: an error-level line pages the error
 * sweep on every plain push of a manifest-less repo (KRTX-4605: 3 error lines
 * in 60 min from one project pushing a foreign repo, each after a 2xx push).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warnMissingManifestAfterPush } from './index';

const PROJECT_ID = 'b06a70f1-be0a-4fd0-b052-26fffb92713f';

/** A real local git repo on `main`, with or without a manifest file. */
async function initRepo(manifest: 'kortix.yaml' | 'kortix.yml' | null): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'manifest-tripwire-'));
  const run = async (args: string[]) => {
    const p = Bun.spawn(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    const code = await p.exited;
    const err = await new Response(p.stderr).text();
    await new Response(p.stdout).text();
    if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
  };
  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', 'test@example.test']);
  await run(['config', 'user.name', 'test']);
  if (manifest) await writeFile(join(repo, manifest), 'kind: test\n');
  await run(['add', '-A']);
  await run(['commit', '--allow-empty', '-m', 'init', '--no-gpg-sign']);
  return repo;
}

let repo: string;
let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;

afterEach(async () => {
  warn?.mockRestore();
  error?.mockRestore();
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe('warnMissingManifestAfterPush', () => {
  test('a manifest-less default branch logs at warn, never at error', async () => {
    repo = await initRepo(null);
    warn = spyOn(console, 'warn');
    error = spyOn(console, 'error');
    await warnMissingManifestAfterPush(PROJECT_ID, 'main', repo);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain(`MANIFEST MISSING after push to ${PROJECT_ID}`);
    expect(line).toContain('main has no kortix.yaml');
    expect(line).toContain('built-in agents only');
    expect(error).not.toHaveBeenCalled();
  });

  test('a default branch with kortix.yaml logs nothing', async () => {
    repo = await initRepo('kortix.yaml');
    warn = spyOn(console, 'warn');
    error = spyOn(console, 'error');
    await warnMissingManifestAfterPush(PROJECT_ID, 'main', repo);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test('a default branch with kortix.yml logs nothing', async () => {
    repo = await initRepo('kortix.yml');
    warn = spyOn(console, 'warn');
    error = spyOn(console, 'error');
    await warnMissingManifestAfterPush(PROJECT_ID, 'main', repo);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test('a git failure propagates to the caller (the tripwire-skipped catch)', async () => {
    repo = await mkdtemp(join(tmpdir(), 'manifest-tripwire-empty-'));
    warn = spyOn(console, 'warn');
    error = spyOn(console, 'error');
    // No commit on main: ls-tree fails, the handler's catch logs "skipped".
    expect(warnMissingManifestAfterPush(PROJECT_ID, 'main', repo)).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
