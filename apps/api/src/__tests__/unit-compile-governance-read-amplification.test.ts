/**
 * The governance compile behind every session's 60 s config-release tick must
 * not amplify a base move into a per-file git fetch storm (KRTX-4740: a wave
 * of base-branch moves made every tick rebuild its release by faulting ONE
 * blob per prompt file — 40-260 serialized `git fetch` processes per request,
 * p95 7884 ms on POST …/config-release).
 *
 * Pinned behaviors:
 *   1. On a partial (blobless) store, one compile faults every prompt blob in
 *      ONE batched object fetch (`prefetchRepoFiles`, the same fix
 *      `loadProjectConfig` got for skills, 2026-11-03) and every prompt file's
 *      bytes read back into the compiled config. The fixture establishes the
 *      blobless mirror itself (`git clone --filter=blob:none --no-local`), so
 *      the fetch count is real on any git >= 2.19 — not gated on the 2.45
 *      store-creation support the sandbox image's git (2.39.5) lacks.
 *   2. The compiled-config cache holds the fleet's working set (~30 active
 *      projects x variants), byte-bounded like the read cache, so a
 *      steady-state tick does not re-read and recompile every prompt file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realFiles = await import('../projects/git/files');
const realObjectStore = await import('../projects/git/object-store');
const { partialStoresEnabled } = realObjectStore;

// Capture BEFORE mock.module: the module namespace is live, so a wrapper that
// reads `realX.foo` at call time would recurse into itself.
const realReadRepoFile = realFiles.readRepoFile;
const realPrefetchRepoFiles = realFiles.prefetchRepoFiles;
const realFetchObjects = realObjectStore.fetchObjects;

const prefetchCalls: Array<{ projectId: string; paths: string[] }> = [];
const readFileCalls: string[] = [];
const objectFetches: string[][] = [];

mock.module('../projects/git/files', () => ({
  ...realFiles,
  prefetchRepoFiles: async (
    project: Parameters<typeof realPrefetchRepoFiles>[0],
    paths: readonly string[],
    ref?: string,
  ) => {
    prefetchCalls.push({ projectId: project.projectId, paths: [...paths] });
    return realPrefetchRepoFiles(project, paths, ref);
  },
  readRepoFile: async (
    project: Parameters<typeof realReadRepoFile>[0],
    path: string,
    ref?: string,
  ) => {
    readFileCalls.push(`${project.projectId}:${path}`);
    return realReadRepoFile(project, path, ref);
  },
}));

mock.module('../projects/git/object-store', () => ({
  ...realObjectStore,
  fetchObjects: async (
    repoPath: string,
    oids: readonly string[],
    options: Parameters<typeof realFetchObjects>[2],
  ) => {
    objectFetches.push([...oids]);
    return realFetchObjects(repoPath, oids, options);
  },
}));

const { resolveCompiledAgentConfigForSession, __resetCompiledAtCommitForTests, __setCompiledAtCommitBudgetForTests } = await import(
  '../projects/lib/compile-agent-config'
);
type GitBackedProject = Parameters<typeof resolveCompiledAgentConfigForSession>[0];

let root = '';
let work = '';
let remote = '';
const previousCache = process.env.KORTIX_GIT_CACHE_DIR;

const partialStoresHere = await partialStoresEnabled();

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (...args: string[]) => run('git', args, work);

const AGENTS = ['scout', 'reviewer', 'writer', 'tester'];
const PROMPT_PATHS = AGENTS.map((name) => `agents/${name}.md`);
const PROMPT_BODIES = Object.fromEntries(AGENTS.map((name) => [`agents/${name}.md`, `You are ${name}.\n`]));

function project(id: string): GitBackedProject {
  return {
    projectId: id,
    repoUrl: remote,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
}

/** The mirror dir the API computes for a project (mirror.ts `repoCachePath`). */
function mirrorPathFor(projectId: string): string {
  return join(process.env.KORTIX_GIT_CACHE_DIR ?? '', `${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}.git`);
}

/** Pre-create the project's mirror as a blobless clone, the shape prod's
 *  partial stores have: every blob faults from the remote on first read. A
 *  file:// URL + --no-local forces the pack transport (a bare-path local
 *  clone ignores the filter), so the blobless state is real on any git
 *  >= 2.19 — this sandbox image's 2.39.5 included. */
function seedBloblessMirror(projectId: string): void {
  const mirror = mirrorPathFor(projectId);
  run('git', ['clone', '-q', '--bare', '--no-local', '--filter=blob:none', `file://${remote}`, mirror], root);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-compile-prefetch-'));
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'git-cache');
  work = join(root, 'work');
  remote = join(root, 'remote.git');
  run('git', ['init', '-q', '--bare', '--initial-branch=main', remote], root);
  // The partial-store machinery fetches raw object ids (missing blobs, lazy
  // fetches); GitHub permits it, a plain local bare remote does not.
  run('git', ['-C', remote, 'config', 'uploadpack.allowFilter', 'true'], root);
  run('git', ['-C', remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true'], root);
  run('git', ['init', '-q', '--initial-branch=main', work], root);
  git('config', 'user.email', 't@kortix.invalid');
  git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', remote);
  const manifest = [
    'project:',
    '  name: prefetch-test',
    'default_agent: scout',
    'agents:',
    ...AGENTS.flatMap((name) => [`  ${name}:`, `    prompt_file: agents/${name}.md`]),
    '',
  ].join('\n');
  const files: Record<string, string> = { 'kortix.yaml': manifest, ...PROMPT_BODIES };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(work, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(work, rel), body);
  }
  git('add', '-A');
  git('commit', '-qm', 'seed');
  git('push', '-q', 'origin', 'main');
});

afterAll(() => {
  if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  __resetCompiledAtCommitForTests();
  __setCompiledAtCommitBudgetForTests(64 * 1024 * 1024);
  prefetchCalls.length = 0;
  readFileCalls.length = 0;
  objectFetches.length = 0;
});

describe('the governance compile of a prompt-heavy manifest', () => {
  test('batch-prefetches every prompt file in one object fetch, not one per file', async () => {
    const compiled = await resolveCompiledAgentConfigForSession(project('prefetch-one'), 'main');
    expect(compiled).not.toBeNull();
    for (const name of AGENTS) expect(compiled).toContain(name);

    expect(prefetchCalls).toHaveLength(1);
    expect(prefetchCalls[0]?.projectId).toBe('prefetch-one');
    expect(prefetchCalls[0]?.paths.sort()).toEqual(PROMPT_PATHS.slice().sort());
    // The per-file reads still happen (through the cache), once per file.
    expect(readFileCalls).toHaveLength(AGENTS.length);
  });

  // Needs a git that supports partial stores (>= 2.45): the object-store
  // check pack (`missingObjects`) of an older git lazily fetches inside
  // `cat-file --batch-check` and dies, so a partial store cannot even exist
  // there — every store stays whole-history and nothing faults. Where the
  // support exists (CI, dev Macs at git >= 2.45), the fixture proves the
  // fetch COUNT: one batched fetch for every prompt blob; replacing the
  // prefetch with a no-op turns it into git's own per-file lazy fetches
  // (zero through `fetchObjects`) and fails this assertion.
  test.skipIf(!partialStoresHere)('on a partial store, every prompt blob faults in one fetch and every prompt byte reads back', async () => {
    const id = 'prefetch-partial';
    seedBloblessMirror(id);
    const promptBlobs = new Set(PROMPT_PATHS.map((path) => git('rev-parse', `HEAD:${path}`)));

    const compiled = await resolveCompiledAgentConfigForSession(project(id), 'main');
    expect(compiled).not.toBeNull();
    // Every prompt file's bytes reached the compiled config.
    for (const body of Object.values(PROMPT_BODIES)) expect(compiled).toContain(body.trim());

    // The prompt blobs arrived in ONE batched fetch — not one fetch per file.
    // Disabling the prefetch turns this into one fetch per file and fails here.
    const blobFetches = objectFetches.filter((oids) => oids.length > 0 && oids.every((oid) => promptBlobs.has(oid)));
    expect(blobFetches).toHaveLength(1);
    expect(new Set(blobFetches[0]).size).toBe(AGENTS.length);
  });

  test('a compile whose cache entry survives does not re-read the prompt files', async () => {
    // 34 distinct projects: just over the old 32-entry bound, the size of a
    // busy fleet's active (project x variant) working set.
    const projects = Array.from({ length: 34 }, (_, i) => project(`prefetch-lru-${i}`));
    for (const p of projects) await resolveCompiledAgentConfigForSession(p, 'main');
    expect(readFileCalls.length).toBeGreaterThan(0);
    readFileCalls.length = 0;

    for (const p of projects) await resolveCompiledAgentConfigForSession(p, 'main');
    expect(readFileCalls).toHaveLength(0);
  });

  test('the byte budget evicts the oldest entries: a tenant cannot grow the cache past its budget', async () => {
    // A small budget and a project whose compiled config is large: three
    // entries over a 1-entry budget must evict, not accumulate.
    __setCompiledAtCommitBudgetForTests(4_000);
    const big = Array.from({ length: 34 }, (_, i) => project(`prefetch-bytes-${i}`));
    for (const p of big) await resolveCompiledAgentConfigForSession(p, 'main');
    const afterRoundOne = readFileCalls.length;
    expect(afterRoundOne).toBeGreaterThan(0);
    readFileCalls.length = 0;

    // Only the LAST entry's bytes fit the 4,000-byte budget; everything else
    // was evicted, so every compile re-reads.
    for (const p of big) await resolveCompiledAgentConfigForSession(p, 'main');
    expect(readFileCalls.length).toBeGreaterThan(afterRoundOne / 2);
  });
});
