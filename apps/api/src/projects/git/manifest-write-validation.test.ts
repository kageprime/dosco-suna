import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { manifestRetry, mutateManifestWithRetry } from '../../connectors/manifest-mutation';
import { installHttpErrors } from '../../http-errors';
import { commitManifest } from '../lib/triggers';
import { readManifest } from '../triggers';

// Every Kortix config write (connectors, triggers, agent scope, agent config,
// skills) serializes through `manifestWrites` before it commits to the
// default branch. These tests drive that boundary against a real git remote.

let root: string;
let previousCache: string | undefined;
/** The project row the config routes pass in; only the git fields are read here. */
type ManifestProject = Parameters<typeof mutateManifestWithRetry>[0];
let project: ManifestProject;
const sleep = manifestRetry.sleep;

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
const remoteHead = () => git('--git-dir', join(root, 'remote.git'), 'rev-parse', 'main').trim();
const remoteFile = (path: string) => git('--git-dir', join(root, 'remote.git'), 'show', `main:${path}`);

/** Push `files` to the remote's `main` as one commit, the way a person's push lands. */
async function push(files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, 'work', path)), { recursive: true });
    await writeFile(join(root, 'work', path), content);
  }
  git('-C', 'work', 'add', ...Object.keys(files));
  git('-C', 'work', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-q', '-m', message);
  git('-C', 'work', 'push', '-q', 'origin', 'main');
}

const SEED = [
  'agents:',
  '  helper:',
  '    tools: "*"',
  'triggers:',
  '  - slug: nightly',
  '    type: cron',
  '    cron: "0 3 * * *"',
  '    agent: helper',
  '    prompt: Run the nightly check.',
  '',
].join('\n');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manifest-write-validation-'));
  previousCache = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');
  git('init', '-q', '--bare', '--initial-branch=main', 'remote.git');
  git('init', '-q', '--initial-branch=main', 'work');
  git('-C', 'work', 'remote', 'add', 'origin', join(root, 'remote.git'));
  project = {
    projectId: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    name: 'synthetic',
    metadata: {},
    repoUrl: join(root, 'remote.git'),
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'synthetic',
  } as ManifestProject;
  manifestRetry.sleep = async () => {};
});

afterEach(async () => {
  manifestRetry.sleep = sleep;
  if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
  await rm(root, { recursive: true, force: true });
});

async function read() {
  const manifest = await readManifest(project, { forceRefresh: true });
  if (!manifest) throw new Error('Expected the seeded manifest');
  return manifest;
}

type Entry = Record<string, unknown>;
const isEntry = (value: unknown): value is Entry => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The entries of the manifest list `key` (the same objects, so an edit lands in `raw`); empty when absent. */
function entries(raw: Entry, key: string): Entry[] {
  const list = raw[key];
  return Array.isArray(list) ? list.filter(isEntry) : [];
}
function firstTrigger(raw: Entry): Entry {
  const [first] = entries(raw, 'triggers');
  if (!first) throw new Error('Expected a trigger');
  return first;
}

describe('a config write is validated before it commits', () => {
  test('a write that adds a validation error is refused with the diagnostic; the branch does not move', async () => {
    await push({ 'kortix.yaml': SEED }, 'seed');
    const head = remoteHead();
    const manifest = await read();
    firstTrigger(manifest.raw).cron = 'every night';

    await expect(commitManifest(project, manifest, 'chore: update trigger nightly')).rejects.toMatchObject({
      code: 'manifest_invalid',
      message: expect.stringContaining('triggers[0].cron: invalid cron expression'),
      issues: [expect.objectContaining({ path: 'triggers[0].cron', severity: 'error' })],
    });
    expect(remoteHead()).toBe(head);
    expect(remoteFile('kortix.yaml')).toBe(SEED);
    expect(firstTrigger((await read()).raw).cron).toBe('0 3 * * *');
  });

  test('a valid write commits and reads back', async () => {
    await push({ 'kortix.yaml': SEED }, 'seed');
    const manifest = await read();
    firstTrigger(manifest.raw).cron = '0 4 * * *';

    expect(await commitManifest(project, manifest, 'chore: update trigger nightly')).toEqual({ ok: true });
    expect(firstTrigger((await read()).raw).cron).toBe('0 4 * * *');
  });

  test('a file that already carries an error stays editable, even when the edit moves that error to another index', async () => {
    const broken = [SEED, 'connectors:', '  - slug: first', '    provider: http', '    base_url: https://first.example.test', '  - slug: second', '    provider: http', ''].join('\n');
    await push({ 'kortix.yaml': broken }, 'seed with an error');
    const manifest = await read();
    // `second` has no `base_url`: its error moves from connectors[1] to connectors[0].
    manifest.raw.connectors = entries(manifest.raw, 'connectors').filter((entry) => entry.slug !== 'first');

    expect(await commitManifest(project, manifest, 'chore: remove connector first')).toEqual({ ok: true });
    expect((await read()).raw.connectors).toEqual([{ slug: 'second', provider: 'http' }]);
  });

  test('imported manifests take part: an invalid edit of an imported entry is refused, a root entry that needs one is accepted', async () => {
    const root = ['imports:', '  - team.yaml', ''].join('\n');
    const team = ['agents:', '  helper:', '    tools: "*"', 'triggers:', '  - slug: nightly', '    type: cron', '    cron: "0 3 * * *"', '    agent: helper', '    prompt: Run the nightly check.', ''].join('\n');
    await push({ 'kortix.yaml': root, 'team.yaml': team }, 'seed with an import');

    const invalid = await read();
    firstTrigger(invalid.raw).agent = 'ghost';
    await expect(commitManifest(project, invalid, 'chore: update trigger nightly')).rejects.toMatchObject({
      code: 'manifest_invalid',
      message: expect.stringContaining('agent "ghost" does not match any declared agent'),
    });
    expect(remoteFile('team.yaml')).toBe(team);

    // `helper` is declared only in team.yaml: the root file alone would not validate this trigger.
    const valid = await read();
    valid.raw.triggers = [...entries(valid.raw, 'triggers'), { slug: 'weekly', type: 'cron', cron: '0 5 * * 1', agent: 'helper', prompt: 'Run the weekly check.' }];
    expect(await commitManifest(project, valid, 'chore: add trigger weekly')).toEqual({ ok: true });
    // A new entry goes to the root file; the imported file is untouched.
    expect(remoteFile('kortix.yaml')).toContain('slug: weekly');
    expect(remoteFile('team.yaml')).toBe(team);
    expect(entries((await read()).raw, 'triggers').map((entry) => entry.slug).sort()).toEqual(['nightly', 'weekly']);
  });

  test('a retry after a concurrent write validates the new candidate, not the stale one', async () => {
    await push({ 'kortix.yaml': SEED }, 'seed');
    let calls = 0;

    const result = mutateManifestWithRetry(project, 'the trigger weekly was being added', async (manifest) => {
      calls += 1;
      // While the first attempt is in flight, a push removes the agent the new trigger names.
      if (calls === 1) await push({ 'kortix.yaml': 'agents:\n  other:\n    tools: "*"\n' }, 'concurrent: replace helper');
      manifest.raw.triggers = [...entries(manifest.raw, 'triggers'), { slug: 'weekly', type: 'cron', cron: '0 5 * * 1', agent: 'helper', prompt: 'Run the weekly check.' }];
      return { ok: true, commitMessage: 'chore: add trigger weekly' };
    });

    await expect(result).rejects.toMatchObject({
      code: 'manifest_invalid',
      issues: [expect.objectContaining({ message: expect.stringContaining('agent "helper" does not match any declared agent') })],
    });
    expect(calls).toBe(2);
    expect(remoteFile('kortix.yaml')).toBe('agents:\n  other:\n    tools: "*"\n');
  });

  test('a route that commits through the retry answers 409 manifest_invalid with the issues', async () => {
    await push({ 'kortix.yaml': SEED }, 'seed');
    const head = remoteHead();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    // Renders a failed result the way the trigger, connector and App routes do: `{ error }` only.
    app.post('/agent', async (c) => {
      const result = await mutateManifestWithRetry(project, 'the agent helper was being updated', (manifest) => {
        manifest.raw.agents = { helper: { tools: '*', model: 42 } };
        return { ok: true, commitMessage: 'chore: update agent helper' };
      });
      return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
    });

    const response = await app.request('/agent', { method: 'POST' });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'manifest_invalid',
      issue_count: 1,
      issues: [{ path: 'agents.helper.model', message: 'must be a string.', severity: 'error' }],
    });
    expect(remoteHead()).toBe(head);
  });
});
