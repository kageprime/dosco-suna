import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Auto-seed on a provider key save. It seeds only a workspace that has NO
// usable default at all: no configured default, no managed models, and no
// model of its own already serving. A key only one person can use never
// seeds the workspace's default. The pure effective.ts (toWireModel) is used
// for real.

let flagshipRef: string | null = 'anthropic/claude-opus-4.8';
mock.module('./picker-catalog', () => ({ flagshipRefForEnvVar: () => flagshipRef }));

let defaults: any = { account: null, agents: {}, projects: {} };
const upsert = mock(async (_input: unknown) => {});
mock.module('../../repositories/model-preferences', () => ({
  getAccountModelDefaults: async () => defaults,
  upsertAccountModelPreference: upsert,
}));

let managed = false;
mock.module('../../billing/services/entitlements', () => ({
  accountMayUseManagedModels: async () => managed,
}));

mock.module('./served-managed-models', () => ({ platformDefaultModelId: () => 'kimi-k3' }));

let servable = true;
let platformServable = true;
let probes: any[] = [];
let effective: { model: string | null; source: string } = { model: null, source: 'platform' };
const invalidate = mock((_accountId: string) => {});
mock.module('../resolution/default-model', () => ({
  isModelServableForAccount: async (input: any) => {
    if (input.model === 'kimi-k3') return platformServable;
    probes.push(input);
    return servable;
  },
  resolveEffectiveModel: async () => effective,
  invalidateAccountModelDefaults: invalidate,
}));

const { seedProjectDefaultModelOnConnect } = await import('./seed-default');

const params = { projectId: 'p1', accountId: 'a1', userId: 'u1', secretName: 'ANTHROPIC_API_KEY' };

beforeEach(() => {
  flagshipRef = 'anthropic/claude-opus-4.8';
  defaults = { account: null, agents: {}, projects: {} };
  managed = false;
  servable = true;
  platformServable = true;
  probes = [];
  effective = { model: null, source: 'platform' };
  upsert.mockClear();
  invalidate.mockClear();
});

describe('seedProjectDefaultModelOnConnect', () => {
  test('seeds the provider flagship as the project default when the workspace has no usable model', async () => {
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'a1',
        scope: 'project',
        scopeKey: 'p1',
        model: 'anthropic/claude-opus-4.8',
        onlyIfAbsent: true,
      }),
    );
    expect(invalidate).toHaveBeenCalledWith('a1');
  });

  test('a workspace with managed models keeps the platform default (a paid Credits workspace)', async () => {
    managed = true;
    await seedProjectDefaultModelOnConnect({ ...params, secretName: 'OPENROUTER_API_KEY' });
    expect(upsert).not.toHaveBeenCalled();
  });

  test('managed models that this deployment cannot serve (a self-host without a managed provider) still seed', async () => {
    managed = true;
    platformServable = false;
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  test('a workspace whose own models already serve a default keeps it', async () => {
    effective = { model: 'codex/gpt-6.1-sol', source: 'platform' };
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).not.toHaveBeenCalled();
  });

  test('the flagship must serve every session, not only the person who saved a private key', async () => {
    await seedProjectDefaultModelOnConnect(params);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ personalUserId: null, freeModelsOnly: true, model: 'anthropic/claude-opus-4.8' });
  });

  test('skips a non-provider credential (flagship ref null)', async () => {
    flagshipRef = null;
    await seedProjectDefaultModelOnConnect({ ...params, secretName: 'CODEX_AUTH_JSON' });
    expect(upsert).not.toHaveBeenCalled();
  });

  test('never clobbers an existing account default', async () => {
    defaults = { account: 'glm-5.3-flash', agents: {}, projects: {} };
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).not.toHaveBeenCalled();
  });

  test('never clobbers an existing project default', async () => {
    defaults = { account: null, agents: {}, projects: { p1: 'glm-5.3-flash' } };
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).not.toHaveBeenCalled();
  });

  test('a key its provider refused, or that could not be checked, never becomes the default', async () => {
    for (const keyCheck of ['invalid', 'unknown'] as const) {
      await seedProjectDefaultModelOnConnect({ ...params, keyCheck });
    }
    expect(upsert).not.toHaveBeenCalled();
    await seedProjectDefaultModelOnConnect({ ...params, keyCheck: 'verified' });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  test('skips when the flagship is not servable', async () => {
    servable = false;
    await seedProjectDefaultModelOnConnect(params);
    expect(upsert).not.toHaveBeenCalled();
  });
});
