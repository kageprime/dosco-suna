// Change-request diffs and merges, the history viewer and API writes on a
// partial project store (object-store.ts): every object starts missing, and
// each read must fetch what it reads and nothing more. The repository holds a
// large data file that no test changes: none of these reads may download it.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { listBranches } from './branches';
import { commitFileToBranch, commitMultipleFilesToBranch } from './commit-writer';
import { getCommit, getCommitDiff, listCommits } from './commits';
import { getBranchDiff, mergeBranches, previewMerge } from './merge';
import { refreshMirror, runGitCapture } from './mirror';
import { createPartialStoreFixture, type PartialStoreFixture } from './__tests__/partial-store-fixture';
import { classifyMerge } from '../change-request-governance';

const exec = promisify(execFile);

let fx: PartialStoreFixture | null = null;
afterEach(async () => {
  await fx?.cleanup();
  fx = null;
});

const NOTES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** `main` with a small config, notes, and a 2 MB data file; `feature` changes the notes only. */
async function repoWithFeature(): Promise<{ fx: PartialStoreFixture; bigBlob: string }> {
  const fixture = await createPartialStoreFixture({
    'kortix.yaml': 'name: lab\n',
    'notes.md': NOTES,
    'data/big.bin': randomBytes(2_000_000),
  });
  await fixture.push({ 'notes.md': NOTES.replace('line 2\n', 'line 2 from feature\n') }, 'feature edit', 'feature');
  return { fx: fixture, bigBlob: await fixture.upstreamBlob('data/big.bin') };
}

async function upstream(fixture: PartialStoreFixture, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['--git-dir', fixture.upstream, ...args]);
  return stdout.trim();
}

describe('change requests on a partial store', () => {
  test('the diff of a branch fetches the changed file, not the large file', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    const diff = await getBranchDiff(fx.project, 'main', 'feature');
    expect(diff.files).toEqual([{ path: 'notes.md', old_path: null, status: 'modified', additions: 1, deletions: 1 }]);
    expect(diff.patch).toContain('+line 2 from feature');
    expect(diff.patch_truncated).toBe(false);
    expect(await fx.storeHas(await fx.upstreamBlob('notes.md', 'feature'))).toBe(true);
    expect(await fx.storeHas(setup.bigBlob)).toBe(false);
  });

  test('a renamed and edited file reads as a rename', async () => {
    fx = await createPartialStoreFixture({ 'docs/guide.md': NOTES, 'data/big.bin': randomBytes(2_000_000) });
    await fx.push({ 'docs/guide.md': null, 'docs/manual.md': `${NOTES}line 21\n` }, 'move guide', 'feature');
    const diff = await getBranchDiff(fx.project, 'main', 'feature');
    expect(diff.files).toEqual([{ path: 'docs/manual.md', old_path: 'docs/guide.md', status: 'renamed', additions: 1, deletions: 0 }]);
    expect(await fx.storeHas(await fx.upstreamBlob('data/big.bin'))).toBe(false);
  });

  test('a clean three-way merge fetches the shared file only and pushes the merge', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    await fx.push({ 'notes.md': NOTES.replace('line 19\n', 'line 19 from main\n') }, 'main edit', 'main');
    const preview = await previewMerge(fx.project, 'main', 'feature');
    expect(preview).toMatchObject({ can_merge: true, can_fast_forward: false, conflicts: [] });

    const merged = await mergeBranches(fx.project, 'main', 'feature');
    expect(merged.fast_forward).toBe(false);
    expect(await upstream(fx, 'rev-parse', 'main')).toBe(merged.merge_commit_sha);
    const notes = await upstream(fx, 'show', 'main:notes.md');
    expect(notes).toContain('line 2 from feature');
    expect(notes).toContain('line 19 from main');
    expect(await upstream(fx, 'rev-parse', 'main:data/big.bin')).toBe(setup.bigBlob);
    expect(await fx.storeHas(setup.bigBlob)).toBe(false);
  });

  test('a conflict lists its path; it is not mistaken for a failure', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    await fx.push({ 'notes.md': NOTES.replace('line 2\n', 'line 2 from main\n') }, 'main edit', 'main');
    const preview = await previewMerge(fx.project, 'main', 'feature');
    expect(preview).toMatchObject({ can_merge: false, conflicts: ['notes.md'] });
    expect(await fx.storeHas(setup.bigBlob)).toBe(false);
  });

  test('merge classification reads the manifest, the files the change adds and what the merge combines, nothing else', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    await fx.push({ 'kortix.yaml': 'name: lab\ndefault_agent: helper\n' }, 'pick agent', 'feature');
    await fx.push({ 'notes.md': 'main moved\n' }, 'main edit', 'main');
    const change = await classifyMerge(fx.project, { baseRef: 'main', headRef: 'feature' });
    expect(change.required.length).toBeGreaterThan(0);
    expect(change.secrets).toEqual({ findings: [], total: 0 });
    expect(await fx.storeHas(await fx.upstreamBlob('kortix.yaml', 'feature'))).toBe(true);
    // Both sides changed notes.md: the would-be merge (and the merge itself) reads it.
    expect(await fx.storeHas(await fx.upstreamBlob('notes.md', 'main'))).toBe(true);
    expect(await fx.storeHas(setup.bigBlob)).toBe(false);
  });

  test('the secret scan reads a merge commit on the branch by its resolution, without the large file', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    await fx.push({ 'notes.md': NOTES.replace('line 2\n', 'line 2 from main\n') }, 'main edit', 'main');
    const seed = `${fx.root}/seed`;
    const token = ['ghp', Array.from({ length: 36 }, (_, i) => 'aB3dE5gH7jK9mN2pQ4sT6vW8yZ'[(i * 7) % 26]).join('')].join('_');
    const run = (...args: string[]) => exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: seed });
    await run('checkout', '-q', 'feature');
    await run('merge', '-q', 'main').catch(() => undefined); // conflicts on notes.md
    await Bun.write(`${seed}/notes.md`, `${NOTES}TOKEN=${token}\n`);
    await run('add', 'notes.md');
    await run('commit', '-q', '--no-edit');
    await run('push', '-q', 'origin', 'HEAD:refs/heads/feature');
    const change = await classifyMerge(fx.project, { baseRef: 'main', headRef: 'feature' });
    expect(change.secrets.unscanned).toBeUndefined();
    expect(change.secrets.findings.map((f) => `${f.file}:${f.rule}`)).toEqual(['notes.md:github_token']);
    expect(await fx.storeHas(setup.bigBlob)).toBe(false);
  });

  test('ancestry and branch counts read commits only', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    const store = await refreshMirror(fx.project, true);
    const ancestor = await runGitCapture(['merge-base', '--is-ancestor', 'main', 'feature'], store);
    expect(ancestor.exitCode).toBe(0);
    const branches = await listBranches(fx.project);
    expect(branches.find((branch) => branch.name === 'feature')).toMatchObject({ ahead: 1, behind: 0 });
    expect(await fx.storeHas(setup.bigBlob)).toBe(false);
  });
});

describe('history viewer on a partial store', () => {
  test('commit detail and patch fetch the changed file only', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    const tip = await upstream(fx, 'rev-parse', 'feature');
    const commit = await getCommit(fx.project, tip);
    expect(commit?.files).toEqual([{ path: 'notes.md', old_path: null, status: 'modified', additions: 1, deletions: 1 }]);
    const diff = await getCommitDiff(fx.project, tip);
    expect(diff.patch).toContain('+line 2 from feature');
    expect(diff.parent).toBe(await upstream(fx, 'rev-parse', 'main'));
    expect(await fx.storeHas(setup.bigBlob)).toBe(false);
  });

  test('the history of one file walks every commit and follows a rename, without the large file', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    await fx.push({ 'data/big.bin': randomBytes(2_000_000) }, 'rerun', 'main');
    await fx.push({ 'notes.md': null, 'docs/notes.md': `${NOTES}line 21\n` }, 'move notes', 'main');
    await fx.push({ 'kortix.yaml': 'name: lab 2\n' }, 'rename lab', 'main');

    const history = await listCommits(fx.project, { ref: 'main', path: 'docs/notes.md' });
    expect(history.commits.map((commit) => commit.subject)).toEqual(['move notes', 'initial']);
    const data = await listCommits(fx.project, { ref: 'main', path: 'data/big.bin' });
    expect(data.commits.map((commit) => commit.subject)).toEqual(['rerun', 'initial']);
    expect(await fx.storeHas(setup.bigBlob)).toBe(false);
    expect(await fx.storeHas(await fx.upstreamBlob('data/big.bin'))).toBe(false);
  });
});

describe('API writes on a partial store', () => {
  test('a write to another branch fetches no file of the parent and keeps them all', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    const notes = await fx.upstreamBlob('notes.md', 'feature');
    const { commitSha } = await commitMultipleFilesToBranch(fx.project, {
      files: [{ path: 'agents/new.md', content: 'hello\n' }],
      deletes: ['kortix.yaml'],
      message: 'API write',
      branch: 'feature',
    });
    expect(await upstream(fx, 'rev-parse', 'feature')).toBe(commitSha);
    expect(await upstream(fx, 'show', 'feature:agents/new.md')).toBe('hello');
    expect(await upstream(fx, 'rev-parse', 'feature:notes.md')).toBe(notes);
    expect(await upstream(fx, 'rev-parse', 'feature:data/big.bin')).toBe(setup.bigBlob);
    expect(await upstream(fx, 'ls-tree', '--name-only', 'feature', '--', 'kortix.yaml')).toBe('');
    for (const blob of [setup.bigBlob, notes, await fx.upstreamBlob('kortix.yaml')]) {
      expect(await fx.storeHas(blob)).toBe(false);
    }
  });

  test('a guarded edit checks the revision from the tree, not the file', async () => {
    const setup = await repoWithFeature();
    fx = setup.fx;
    const revision = await fx.upstreamBlob('notes.md');
    await commitFileToBranch(fx.project, {
      path: 'notes.md',
      content: 'rewritten\n',
      message: 'edit notes',
      expectedFileRevision: { path: 'notes.md', sha: revision },
    });
    expect(await upstream(fx, 'show', 'main:notes.md')).toBe('rewritten');
    expect(await fx.storeHas(revision)).toBe(false);
    expect(await fx.storeHas(setup.bigBlob)).toBe(false);
  });
});
