/**
 * Unit test (Platinum stubbed at `fetch`, no database): the workspace cache of
 * flag `platinum_cache` (platform/services/workspace-volume.ts).
 *
 * - A cached session's volume is restored from the project's namespace, newest
 *   `ws-` key, in `git` sync mode, instead of opened empty.
 * - Any failed restore (a 5xx, an org without caches) opens the volume the
 *   ordinary way: the cache never fails a session.
 * - The record keeps the namespace, and only a valid one; the box gets the
 *   namespace and the pnpm store inside /workspace.
 * - A save commits the volume first and pins the entry to that commit; keys
 *   are `ws-…`; Platinum's refusals keep their status and code.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

const { config } = await import('../config');
const { __resetPlatinumSandboxOriginsForTests } = await import('../shared/platinum');
const {
  applyWorkspaceVolume,
  isWorkspaceCacheKey,
  listWorkspaceCache,
  recordedWorkspaceVolume,
  saveWorkspaceCache,
  startWorkspaceVolume,
  workspaceCacheNamespace,
  WorkspaceCacheError,
  WORKSPACE_CACHE_ENV,
  WORKSPACE_CACHE_PNPM_STORE,
} = await import('../platform/services/workspace-volume');

type CreateSandboxOpts = import('../platform/providers/contract').CreateSandboxOpts;

const PT = 'https://api.platinum.test';
const PROJECT = '05b9519d-ca06-4cdd-9825-3cbc3ac3c389';
const NS = `proj:${PROJECT}:ws`;

const original = {
  PLATINUM_API_URL: config.PLATINUM_API_URL,
  PLATINUM_API_KEY: config.PLATINUM_API_KEY,
  KORTIX_WORKSPACE_VOLUMES: config.KORTIX_WORKSPACE_VOLUMES,
};
const realFetch = globalThis.fetch;
let calls: Array<{ method: string; path: string; body: string }> = [];
let answer: (path: string, method: string) => Response = () => Response.json({});

const lines = () => calls.map((c) => `${c.method} ${c.path}`);
const bodyOf = (method: string, path: string) =>
  JSON.parse(calls.find((c) => c.method === method && c.path === path)?.body ?? 'null') as Record<string, unknown> | null;

async function settled(count: number): Promise<void> {
  for (let i = 0; i < 200 && calls.length < count; i++) await Bun.sleep(5);
  await Bun.sleep(20);
}

beforeEach(() => {
  Object.assign(config, { PLATINUM_API_URL: PT, PLATINUM_API_KEY: 'pt_test_key', KORTIX_WORKSPACE_VOLUMES: undefined });
  __resetPlatinumSandboxOriginsForTests?.();
  calls = [];
  answer = () => Response.json({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: `${url.pathname}${url.search}`, body: typeof init?.body === 'string' ? init.body : '' });
    return answer(url.pathname, method);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  Object.assign(config, original);
});

describe('restore at session create', () => {
  test('a cached session restores its volume from the project namespace instead of opening it empty', async () => {
    answer = (path) =>
      path === '/v1/caches/restore'
        ? Response.json({ hit: 'prefix', entry: { key: 'ws-abc123' }, volume: { name: 'x' } }, { status: 201 })
        : Response.json({});
    const sessionId = crypto.randomUUID();
    const volume = startWorkspaceVolume({ sessionId, location: undefined, cacheNamespace: NS });
    expect(volume).toEqual({ name: `kws-${sessionId}`, location: null, cache: { namespace: NS } });
    await settled(1);
    expect(lines()).toEqual(['POST /v1/caches/restore']);
    expect(bodyOf('POST', '/v1/caches/restore')).toEqual({
      namespace: NS,
      restore_keys: ['ws-'],
      name: `kws-${sessionId}`,
      sync_mode: 'git',
    });
  });

  test('a failed restore opens the volume the ordinary way', async () => {
    for (const refusal of [
      () => new Response('{"code":"internal"}', { status: 500 }),
      // An org Platinum has not granted caches: every /v1/caches route is 404.
      () => new Response('{"code":"not_found","message":"no such route"}', { status: 404 }),
    ]) {
      calls = [];
      answer = (path) => (path === '/v1/caches/restore' ? refusal() : Response.json({ name: 'x' }));
      const sessionId = crypto.randomUUID();
      startWorkspaceVolume({ sessionId, location: undefined, cacheNamespace: NS });
      await settled(2);
      expect(lines().filter((l) => l !== 'POST /v1/caches/restore')).toEqual([`PUT /v1/volumes/kws-${sessionId}`]);
      expect(bodyOf('PUT', `/v1/volumes/kws-${sessionId}`)).toEqual({ sync_mode: 'git' });
    }
  });

  test('a session without the flag never asks the cache', async () => {
    const sessionId = crypto.randomUUID();
    const volume = startWorkspaceVolume({ sessionId, location: undefined });
    expect(volume?.cache).toBeUndefined();
    await settled(1);
    expect(lines()).toEqual([`PUT /v1/volumes/kws-${sessionId}`]);
  });
});

describe('record and box', () => {
  test('the record keeps a valid namespace and drops anything else', () => {
    const id = crypto.randomUUID();
    const name = `kws-${id}`;
    expect(recordedWorkspaceVolume(id, { workspace_volume: { name, location: null, cache: { namespace: NS } } })).toEqual({
      name,
      location: null,
      cache: { namespace: NS },
    });
    for (const cache of [{ namespace: '' }, { namespace: '-x' }, { namespace: 5 }, 'proj:x', null]) {
      expect(recordedWorkspaceVolume(id, { workspace_volume: { name, location: null, cache } })).toEqual({ name, location: null });
    }
  });

  test('a cached box gets the namespace and the pnpm store inside /workspace; an uncached one does not', () => {
    const cached = { envVars: { A: '1' } } as unknown as CreateSandboxOpts;
    applyWorkspaceVolume(cached, { name: 'kws-a', location: null, cache: { namespace: NS } });
    expect(cached.envVars).toMatchObject({ A: '1', KORTIX_WORKSPACE_VOLUME: '1', [WORKSPACE_CACHE_ENV]: NS, npm_config_store_dir: WORKSPACE_CACHE_PNPM_STORE });
    expect(WORKSPACE_CACHE_PNPM_STORE.startsWith('/workspace/')).toBe(true);
    const plain = { envVars: {} } as unknown as CreateSandboxOpts;
    applyWorkspaceVolume(plain, { name: 'kws-b', location: null });
    expect(plain.envVars?.[WORKSPACE_CACHE_ENV]).toBeUndefined();
    expect(plain.envVars?.npm_config_store_dir).toBeUndefined();
  });

  test('the namespace is per project and inside Platinum’s rule', () => {
    expect(workspaceCacheNamespace(PROJECT)).toBe(NS);
    expect(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(NS)).toBe(true);
    expect(isWorkspaceCacheKey('ws-3f9c0a1b2c3d')).toBe(true);
    for (const bad of ['3f9c', 'ws-', 'ws-a b', 'docker-1', 'ws-/x', `ws-${'a'.repeat(121)}`]) expect(isWorkspaceCacheKey(bad)).toBe(false);
  });
});

describe('save', () => {
  const sessionId = crypto.randomUUID();
  const metadata = { workspace_volume: { name: `kws-${sessionId}`, location: null } };

  test('commits the volume, then saves that commit under the key', async () => {
    answer = (path) => {
      if (path === `/v1/volumes/kws-${sessionId}/commit`) return Response.json({ commit_id: 'vc_1', head_commit_id: 'vc_1', commits: [] });
      if (path === '/v1/caches') {
        return Response.json(
          { id: 'vce_1', key: 'ws-k1', size_bytes: 7_790_000_000, file_count: 576_000, hits: 0, created_at: '2026-11-26T12:00:00Z', last_hit_at: null, expires_at: '2026-12-03T12:00:00Z', evicted: ['vce_0'] },
          { status: 201 },
        );
      }
      return Response.json({});
    };
    const saved = await saveWorkspaceCache({ projectId: PROJECT, sessionId, sessionMetadata: metadata, key: 'ws-k1' });
    expect(lines()).toEqual([`POST /v1/volumes/kws-${sessionId}/commit`, 'POST /v1/caches']);
    expect(bodyOf('POST', '/v1/caches')).toEqual({
      namespace: NS,
      key: 'ws-k1',
      volume: `kws-${sessionId}`,
      max_entries: 2,
      ttl_seconds: 604_800,
      ref: 'vc_1',
    });
    expect(saved).toEqual({
      entry: { id: 'vce_1', key: 'ws-k1', size_bytes: 7_790_000_000, file_count: 576_000, hits: 0, created_at: '2026-11-26T12:00:00Z', last_hit_at: null, expires_at: '2026-12-03T12:00:00Z' },
      evicted: ['vce_0'],
      commit_id: 'vc_1',
    });
  });

  test('refuses a bad key and a session without a volume before calling Platinum', async () => {
    await expect(saveWorkspaceCache({ projectId: PROJECT, sessionId, sessionMetadata: metadata, key: 'k1' })).rejects.toMatchObject({ status: 400, code: 'invalid_key' });
    await expect(saveWorkspaceCache({ projectId: PROJECT, sessionId, sessionMetadata: {}, key: 'ws-k1' })).rejects.toMatchObject({ status: 409, code: 'no_workspace_volume' });
    expect(calls).toEqual([]);
  });

  test('keeps Platinum’s refusal: a taken key, a too large workspace, an org without caches', async () => {
    const cases: Array<[number, string, number, string]> = [
      [409, 'cache_key_exists', 409, 'cache_key_exists'],
      [413, 'cache_too_large', 413, 'cache_too_large'],
      [404, 'not_found', 409, 'cache_unavailable'],
      [503, 'unavailable', 502, 'cache_upstream'],
    ];
    for (const [status, code, wantStatus, wantCode] of cases) {
      calls = [];
      answer = (path) => (path === '/v1/caches' ? new Response(JSON.stringify({ code, message: code }), { status }) : Response.json({ commit_id: 'vc_2' }));
      const err = await saveWorkspaceCache({ projectId: PROJECT, sessionId, sessionMetadata: metadata, key: 'ws-k2' }).catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceCacheError);
      expect(err).toMatchObject({ status: wantStatus, code: wantCode });
    }
  });
});

describe('list', () => {
  test('list refusals retain their typed status and safe code', async () => {
    answer = () => Response.json({ code: 'unavailable', message: 'upstream refused' }, { status: 503 });
    await expect(listWorkspaceCache(PROJECT, null)).rejects.toMatchObject({
      name: 'WorkspaceCacheError', status: 502, code: 'cache_upstream',
    });
  });

  test('reads the project namespace and the shared budget', async () => {
    answer = () =>
      Response.json({ entries: [{ id: 'vce_1', key: 'ws-k1', size_bytes: 10, file_count: 2, hits: 3, created_at: null, last_hit_at: null, expires_at: null }], used_bytes: 10, max_bytes: 21_474_836_480 });
    const listed = await listWorkspaceCache(PROJECT, null);
    expect(lines()).toEqual([`GET /v1/caches?namespace=${encodeURIComponent(NS)}`]);
    expect(listed).toEqual({
      namespace: NS,
      entries: [{ id: 'vce_1', key: 'ws-k1', size_bytes: 10, file_count: 2, hits: 3, created_at: null, last_hit_at: null, expires_at: null }],
      used_bytes: 10,
      max_bytes: 21_474_836_480,
    });
  });
});
