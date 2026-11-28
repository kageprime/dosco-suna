// agentArtifactCurrent: when `pnpm worktree start` may skip rebuilding the sandbox agent binary.
// startDocsBuild: the /docs build starts at the top of `worktree start`, detached.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentArtifactCurrent, startDocsBuild } from '../lib/services';

const T0 = new Date('2026-11-26T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

function put(root: string, rel: string, when: Date): string {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, rel);
  utimesSync(p, when, when);
  return p;
}

const AGENT = 'apps/kortix-sandbox-agent-server';
// The modules the fixture's last build bundled, as bun's metafile names them: relative to the package.
const MODULES = ['lib/main.ts', 'lib/worker.ts', '../../packages/api-contract/lib/layout.ts', '../../node_modules/.pnpm/dep/index.js', 'bun:ffi'];

/** A worktree whose inputs are all at T0, built at T0+60 s with a metafile listing MODULES. */
function worktree(): string {
  const wt = mkdtempSync(join(tmpdir(), 'wt-artifacts-'));
  for (const m of MODULES.filter((m) => !m.includes(':'))) put(join(wt, AGENT), m, T0);
  put(wt, `${AGENT}/package.json`, T0);
  put(wt, `${AGENT}/tsconfig.json`, T0);
  for (const f of ['pnpm-lock.yaml', 'package.json', 'tsconfig.base.json']) put(wt, f, T0);
  put(wt, 'packages/starter/lib/embedded.generated.json', T0);
  const meta = put(wt, `${AGENT}/dist/kortix-agent.meta.json`, at(59));
  writeFileSync(meta, JSON.stringify({ inputs: Object.fromEntries(MODULES.map((m) => [m, { bytes: 1 }])), outputs: {} }));
  utimesSync(meta, at(59), at(59));
  put(wt, `${AGENT}/dist/kortix-agent`, at(60));
  put(wt, `${AGENT}/dist/kortixd`, at(61));
  return wt;
}

describe('agentArtifactCurrent', () => {
  test('a binary newer than every module it bundled is current', () => {
    expect(agentArtifactCurrent(worktree())).toBe(true);
  });

  test('a worktree that never built the binary is not current', () => {
    const wt = worktree();
    rmSync(join(wt, AGENT, 'dist/kortixd'));
    expect(agentArtifactCurrent(wt)).toBe(false);
  });

  test('a build without a metafile (an older Bun) always rebuilds', () => {
    const wt = worktree();
    rmSync(join(wt, AGENT, 'dist/kortix-agent.meta.json'));
    expect(agentArtifactCurrent(wt)).toBe(false);
  });

  test('an edited module of the package rebuilds', () => {
    const wt = worktree();
    put(join(wt, AGENT), 'lib/worker.ts', at(120));
    expect(agentArtifactCurrent(wt)).toBe(false);
  });

  test('an edited module of another workspace package it bundled rebuilds', () => {
    const wt = worktree();
    put(wt, 'packages/api-contract/lib/layout.ts', at(120));
    expect(agentArtifactCurrent(wt)).toBe(false);
  });

  test('a module that is gone rebuilds', () => {
    const wt = worktree();
    rmSync(join(wt, AGENT, 'lib/worker.ts'));
    expect(agentArtifactCurrent(wt)).toBe(false);
  });

  test('a dependency bump (lockfile) or a tsconfig edit rebuilds', () => {
    const lock = worktree();
    put(lock, 'pnpm-lock.yaml', at(120));
    expect(agentArtifactCurrent(lock)).toBe(false);
    const ts = worktree();
    put(ts, `${AGENT}/tsconfig.json`, at(120));
    expect(agentArtifactCurrent(ts)).toBe(false);
  });

  test('files the bundle never read do not count: the CLI build regenerating packages/starter, test caches', () => {
    const wt = worktree();
    put(wt, 'packages/starter/lib/embedded.generated.json', at(300));
    put(wt, `${AGENT}/node_modules/.cache/tsgo.tsbuildinfo`, at(300));
    put(wt, `${AGENT}/notes.md`, at(300));
    expect(agentArtifactCurrent(wt)).toBe(true);
  });
});

describe('startDocsBuild', () => {
  function web(): { wt: string; log: string } {
    const wt = mkdtempSync(join(tmpdir(), 'wt-docs-'));
    // A stand-in for apps/web/scripts/blume-docs.mjs: buildBlumeDocs() leaves a marker in the cwd it runs in.
    put(wt, 'apps/web/scripts/blume-docs.mjs', T0);
    writeFileSync(join(wt, 'apps/web/scripts/blume-docs.mjs'),
      "import fs from 'node:fs';\nexport function buildBlumeDocs() { fs.writeFileSync('built-by-child', process.cwd()); }\n");
    return { wt, log: join(wt, 'logs', 'docs-build.log') };
  }

  test('runs buildBlumeDocs in apps/web, detached, when public/docs/ is missing', async () => {
    const { wt, log } = web();
    expect(startDocsBuild(wt, log)).toBe(true);
    const marker = join(wt, 'apps/web/built-by-child');
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
    expect(readFileSync(marker, 'utf8')).toEndWith(join('apps', 'web'));
    expect(existsSync(log)).toBe(true);
  });

  test('starts nothing when public/docs/ is already built', () => {
    const { wt, log } = web();
    put(wt, 'apps/web/public/docs/index.html', T0);
    expect(startDocsBuild(wt, log)).toBe(false);
  });

  test('starts nothing in a checkout without the docs build', () => {
    expect(startDocsBuild(mkdtempSync(join(tmpdir(), 'wt-docs-none-')), join(tmpdir(), 'unused.log'))).toBe(false);
  });
});

// The primary Supabase prewarm `worktree create` starts, and the wait in ensurePrimarySupabase that keeps
// `worktree start` from stopping a start in flight.
describe('primary Supabase prewarm pid', () => {
  const pidFile = () => join(mkdtempSync(join(tmpdir(), 'wt-prewarm-')), 'prewarm.pid');

  test('a live pid is running; a dead one is not, and its file goes', async () => {
    const { prewarmRunning } = await import('../lib/supabase');
    const live = pidFile();
    writeFileSync(live, String(process.pid));
    expect(prewarmRunning(live)).toBe(process.pid);
    const dead = pidFile();
    const gone = Bun.spawn(['true']);
    await gone.exited;
    writeFileSync(dead, String(gone.pid));
    expect(prewarmRunning(dead)).toBeNull();
    expect(existsSync(dead)).toBe(false);
    expect(prewarmRunning(pidFile())).toBeNull();
  });

  test('start waits for a prewarm still running, and only then', async () => {
    const { waitForPrimaryPrewarm } = await import('../lib/supabase');
    const file = pidFile();
    expect(await waitForPrimaryPrewarm(5_000, file)).toBe(false);
    const child = Bun.spawn(['sleep', '0.6']);
    writeFileSync(file, String(child.pid));
    const t0 = Date.now();
    // Reap the child as it exits, so its pid stops answering kill(pid, 0).
    void child.exited;
    expect(await waitForPrimaryPrewarm(5_000, file)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });
});
