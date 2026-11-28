/**
 * Unit test (no database, no box): the pieces of the workspace cache's daily
 * rebuild (projects/workspace-cache/builder.ts) that decide what runs and what
 * is saved.
 *
 * - The box command runs the project's own builder from the served config, as
 *   the runtime user, detached, with the cache's env, and keeps its exit code.
 * - Only a final `workspace-cache-key: ws-…` line of a valid key is saved.
 * - A builder is recorded only with an agent and a person.
 */
import { describe, expect, test } from 'bun:test';

const { builderRunCommand, keyFromBuilderOutput, workspaceCacheBuilderOf, REBUILD_AFTER_MS, BUILD_TIMEOUT_MS } = await import(
  '../projects/workspace-cache/builder'
);
const { existsSync } = await import('node:fs');

const NS = 'proj:05b9519d-ca06-4cdd-9825-3cbc3ac3c389:ws';

describe('builderRunCommand', () => {
  // Run detached by the eval runner's launch (projects/evals/box.ts): a plain `nohup … &` died with the exec
  // call that started it, so the first live build never ran (dev.kortix.com, 2026-11-26).
  const cmd = builderRunCommand(NS);

  test('runs the newest served config builder as the runtime user, with the cache env', () => {
    expect(cmd).toContain('ls -dt /opt/kortix/config/*/');
    expect(cmd).toContain('scripts/workspace-cache-build');
    expect(cmd).toContain('exec runuser -u kortix -- env HOME=/home/kortix ');
    expect(cmd).toContain(`KORTIX_WORKSPACE_CACHE='${NS}'`);
    expect(cmd).toContain('npm_config_store_dir=/workspace/.pnpm-store');
  });

  test('finds runuser whatever PATH the exec channel gives root', () => {
    expect(cmd.split('\n')[0]).toBe('export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  });

  test('a namespace cannot break out of its quotes', () => {
    expect(builderRunCommand("a'; rm -rf / #")).toContain(`KORTIX_WORKSPACE_CACHE='a'\\''; rm -rf / #'`);
  });

  test('parses as bash', async () => {
    expect(await Bun.spawn(['bash', '-n', '-c', cmd]).exited).toBe(0);
  });

  test.skipIf(existsSync('/opt/kortix/config'))('without a served builder it says so and exits 127', async () => {
    const proc = Bun.spawn(['bash', '-c', cmd], { stdout: 'pipe' });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(127);
    expect(out.trim()).toBe('no scripts/workspace-cache-build in the served config');
  });
});

describe('keyFromBuilderOutput', () => {
  test('takes the key from the last line only', () => {
    expect(keyFromBuilderOutput('workspace-cache-build: ready\nworkspace-cache-key: ws-c05e329afa10-a47567a3-202611261206\n')).toBe(
      'ws-c05e329afa10-a47567a3-202611261206',
    );
  });
  test('refuses a missing, malformed or earlier key', () => {
    expect(keyFromBuilderOutput('')).toBeNull();
    expect(keyFromBuilderOutput('workspace-cache-key: k-1')).toBeNull();
    expect(keyFromBuilderOutput('workspace-cache-key: ws-a b')).toBeNull();
    expect(keyFromBuilderOutput('workspace-cache-key: ws-abc\nsomething after')).toBeNull();
  });
});

describe('workspaceCacheBuilderOf', () => {
  test('reads a recorded builder', () => {
    expect(workspaceCacheBuilderOf({ workspace_cache: { agent: 'engineering', user_id: 'u1', named_at: '2026-11-26T12:00:00Z' } })).toEqual({
      agent: 'engineering',
      user_id: 'u1',
      named_at: '2026-11-26T12:00:00Z',
    });
  });
  test('needs both the agent and the person', () => {
    expect(workspaceCacheBuilderOf({})).toBeNull();
    expect(workspaceCacheBuilderOf({ workspace_cache: { agent: 'engineering' } })).toBeNull();
    expect(workspaceCacheBuilderOf({ workspace_cache: { user_id: 'u1' } })).toBeNull();
    expect(workspaceCacheBuilderOf(null)).toBeNull();
  });
});

test('a day between builds, 45 min for one', () => {
  expect(REBUILD_AFTER_MS).toBe(86_400_000);
  expect(BUILD_TIMEOUT_MS).toBe(2_700_000);
});
