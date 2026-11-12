import { describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

mock.module('../../config', () => ({
  config: {
    GOOGLE_ANTIGRAVITY_CLIENT_ID: 'test-client-id',
    GOOGLE_ANTIGRAVITY_CLIENT_SECRET: 'test-client-secret',
    ALLOWED_SANDBOX_PROVIDERS: 'e2b',
  },
  validateEnv: () => ({}),
}));

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ accountId: ACCOUNT_ID }],
        }),
      }),
    }),
  },
}));

let projectSecretValue: string | null = null;
let projectSecretName: string | null = null;
const resolveProjectSecretForConsumer = mock(async (input: { name: string }) => {
  if (projectSecretValue && input.name === projectSecretName) {
    return {
      secretId: 'sec-1',
      value: projectSecretValue,
    };
  }
  return null;
});

const writeSharedProjectSecret = mock(async () => 'sec-1');

mock.module('../../projects/secrets', () => ({
  resolveProjectSecretForConsumer,
  writeSharedProjectSecret,
  encryptProjectSecret: (_p: string, _v: string) => Buffer.from('enc'),
}));

let accountSecretValue: string | null = null;
mock.module('../../secrets/account-resource', () => ({
  encryptAccountSecret: (_acc: string, val: string) => val,
  decryptAccountSecret: (_acc: string, val: string) => val,
  readAccountSecret: (_acc: string, _sec: string, val: string) => val,
  resolveDefaultProviderAccountSecret: async (_acc: string, _proj: string, _usr: string, kind: { name: string }) => {
    if (accountSecretValue && kind.name === 'ANTIGRAVITY_AUTH_JSON') {
      return {
        secretId: 'acct-sec-1',
        label: 'Google Antigravity',
        value: accountSecretValue,
        updatedAt: new Date(),
      };
    }
    return null;
  },
  resolveProjectSharedProviderSecrets: async () => ({
    coolingDown: false,
    secrets: [],
  }),
}));

const { resolveAntigravityCredential } = await import('./antigravity');

describe('resolveAntigravityCredential', () => {
  test('returns null when no secret exists', async () => {
    projectSecretValue = null;
    projectSecretName = null;
    accountSecretValue = null;
    const cred = await resolveAntigravityCredential(PROJECT_ID, USER_ID, ACCOUNT_ID);
    expect(cred).toBeNull();
  });

  test('resolves credential from ANTIGRAVITY_AUTH_JSON project secret', async () => {
    projectSecretName = 'ANTIGRAVITY_AUTH_JSON';
    projectSecretValue = JSON.stringify({
      antigravity: {
        access: 'ya29.test-access-token',
        email: 'user@dosco.live',
        plan: 'pro',
        expires: Date.now() + 3600_000,
      },
    });

    const cred = await resolveAntigravityCredential(PROJECT_ID, USER_ID, ACCOUNT_ID);
    expect(cred).not.toBeNull();
    expect(cred?.access).toBe('ya29.test-access-token');
    expect(cred?.email).toBe('user@dosco.live');
  });

  test('resolves credential from GOOGLE_ANTIGRAVITY_AUTH_JSON candidate name', async () => {
    projectSecretName = 'GOOGLE_ANTIGRAVITY_AUTH_JSON';
    projectSecretValue = JSON.stringify({
      access: 'ya29.fallback-candidate-token',
      expires: Date.now() + 3600_000,
    });

    const cred = await resolveAntigravityCredential(PROJECT_ID, USER_ID);
    expect(cred).not.toBeNull();
    expect(cred?.access).toBe('ya29.fallback-candidate-token');
  });

  test('rejects a raw Gemini API key stored as ANTIGRAVITY_AUTH_JSON', async () => {
    projectSecretName = 'ANTIGRAVITY_AUTH_JSON';
    projectSecretValue = 'AIzaSyTestApiKey123';
    const cred = await resolveAntigravityCredential(PROJECT_ID, USER_ID, ACCOUNT_ID);
    expect(cred).toBeNull();
  });

  test('falls back to account secret resource when project secret is missing', async () => {
    projectSecretValue = null;
    projectSecretName = null;
    accountSecretValue = JSON.stringify({
      access_token: 'ya29.account-resource-token',
      expires_in: 3600,
    });

    const cred = await resolveAntigravityCredential(PROJECT_ID, USER_ID, ACCOUNT_ID);
    expect(cred).not.toBeNull();
    expect(cred?.access).toBe('ya29.account-resource-token');
  });
});
