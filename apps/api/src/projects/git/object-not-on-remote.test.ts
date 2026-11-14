import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { classifyGitError, ensureStoreObjects, isTransientGitMirrorError, refreshMirror, transientGitMirrorCause } from './mirror';
import { fetchObjects, isObjectNotOnRemoteError } from './object-store';

// KRTX-4890: `git fetch of 1 objects failed (exit 128): fatal: remote error:
// upload-pack: not our ref <id>` paged as a plain Error. The remote (GitHub)
// refuses an object no advertised ref reaches: a force-push or deleted branch
// left the store pointing at it. A local upstream cannot reproduce the server
// side of that refusal, so a `git` shim ahead of the real one emits GitHub's
// exact stderr for the `fetch`.

const exec = promisify(execFile);
const OID = 'a'.repeat(40);
const REAL_GIT = Bun.which('git') ?? 'git';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storeWithFetchShim(stderrLine: string): Promise<{ store: string; env: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-not-our-ref-'));
  roots.push(root);
  const store = join(root, 'store.git');
  await exec('git', ['init', '--quiet', '--bare', store]);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const shim = join(bin, 'git');
  await writeFile(shim, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = fetch ] && { echo "${stderrLine}" >&2; exit 128; }; done\nexec ${REAL_GIT} "$@"\n`);
  await chmod(shim, 0o755);
  return { store, env: { PATH: `${bin}:${process.env.PATH ?? ''}` } };
}

describe('an object the remote no longer serves', () => {
  test('fetchObjects throws ObjectNotOnRemoteError carrying the git message', async () => {
    const { store, env } = await storeWithFetchShim(`fatal: remote error: upload-pack: not our ref ${OID}`);
    const error = await fetchObjects(store, [OID], { env, maxBytes: 1_000_000 }).catch((e: unknown) => e);
    expect(isObjectNotOnRemoteError(error)).toBe(true);
    expect((error as Error).message).toBe(`git fetch of 1 objects failed (exit 128): fatal: remote error: upload-pack: not our ref ${OID}`);
  });

  test('any other fetch failure stays a plain Error', async () => {
    const { store, env } = await storeWithFetchShim('fatal: unable to access remote');
    const error = await fetchObjects(store, [OID], { env, maxBytes: 1_000_000 }).catch((e: unknown) => e);
    expect(isObjectNotOnRemoteError(error)).toBe(false);
    expect((error as Error).message).toContain('unable to access remote');
  });

  test('the not-our-ref stderr is a transient mirror failure; an unrelated fatal stays loud', () => {
    const notOurRef = classifyGitError({ code: 128, stderr: `fatal: remote error: upload-pack: not our ref ${OID}\n` }, ['fetch'], 1000);
    expect(isTransientGitMirrorError(notOurRef)).toBe(true);
    expect(isTransientGitMirrorError(classifyGitError({ code: 128, stderr: 'fatal: bad object HEAD\n' }, ['fetch'], 1000))).toBe(false);
  });
});

describe('ensureStoreObjects on a refusal of the remote', () => {
  test('surfaces a transient GitOperationError (retryable 503), not a plain Error that pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kortix-not-our-ref-store-'));
    roots.push(root);
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    await exec('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    await exec('git', ['init', '--quiet', '--initial-branch=main', work]);
    await exec('git', ['-C', work, '-c', 'user.name=Test', '-c', 'user.email=a@kortix.ai', 'commit', '--allow-empty', '-m', 'seed']);
    await exec('git', ['-C', work, 'push', '--quiet', remote, 'main']);
    const previousCache = process.env.KORTIX_GIT_CACHE_DIR;
    const previousPath = process.env.PATH;
    process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');
    try {
      const project = { projectId: crypto.randomUUID(), repoUrl: remote, defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: 'synthetic' };
      const store = await refreshMirror(project, true);
      const { env } = await storeWithFetchShim(`fatal: remote error: upload-pack: not our ref ${OID}`);
      process.env.PATH = env.PATH;
      const error = await ensureStoreObjects(store, [OID]).catch((e: unknown) => e);
      const cause = transientGitMirrorCause(error);
      expect(cause).not.toBeNull();
      expect(cause?.message).toContain(`not our ref ${OID}`);
    } finally {
      process.env.PATH = previousPath;
      if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
    }
  });
});
