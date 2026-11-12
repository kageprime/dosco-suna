import { beforeEach, describe, expect, mock, test } from 'bun:test';

// What each scope reaches: `shared` with no person (the fire's scope), `own`
// with the actor's private keys and accounts too.
let sharedModels: Record<string, { enabled: boolean }> = {};
let ownModels: Record<string, { enabled: boolean }> = {};
let sharedClaude = false;
let ownClaudeAccounts = 0;
const catalogCalls: Array<Record<string, unknown>> = [];
const claudeCalls: Array<Record<string, unknown>> = [];

mock.module('../../llm-gateway/models/servable-catalog', () => ({
  servableProjectCatalog: async (input: Record<string, unknown>) => {
    catalogCalls.push(input);
    return { models: input.personalUserId === null ? sharedModels : ownModels };
  },
}));
mock.module('../../claude-subscription/accounts', () => ({
  hasClaudeCredential: async (input: Record<string, unknown>) => {
    claudeCalls.push(input);
    return sharedClaude;
  },
  countUsableClaudeAccounts: async () => ownClaudeAccounts,
}));

const { triggerModelRefusal, NO_USABLE_MODEL, ONLY_PRIVATE_MODELS } = await import('./trigger-model-gate');
const fire = { accountId: 'a1', projectId: 'p1', actor: 'u1' };

beforeEach(() => {
  sharedModels = {};
  ownModels = {};
  sharedClaude = false;
  ownClaudeAccounts = 0;
  catalogCalls.length = 0;
  claudeCalls.length = 0;
});

describe('triggerModelRefusal — a fire runs with no person', () => {
  test('a model a workspace-wide key reaches: the fire runs', async () => {
    sharedModels = { 'anthropic/claude-sonnet-4.6': { enabled: true } };
    expect(await triggerModelRefusal(fire)).toBeNull();
    expect(catalogCalls[0]).toMatchObject({ projectId: 'p1', accountId: 'a1', principalUserId: 'u1', personalUserId: null });
  });

  test('a Claude account shared with the workspace: the fire runs (it is not in the gateway catalog)', async () => {
    sharedClaude = true;
    expect(await triggerModelRefusal(fire)).toBeNull();
    expect(claudeCalls[0]).toMatchObject({ accountId: 'a1', projectId: 'p1', userId: 'u1', sessionId: null, personalUserId: null });
  });

  test('only private keys or accounts: refused, and the refusal says to share one', async () => {
    ownModels = { 'anthropic/claude-sonnet-4.6': { enabled: true } };
    expect(await triggerModelRefusal(fire)).toBe(ONLY_PRIVATE_MODELS);
    ownModels = {};
    ownClaudeAccounts = 1;
    expect(await triggerModelRefusal(fire)).toBe(ONLY_PRIVATE_MODELS);
  });

  test('a disabled model counts as none; nothing at all: the plain refusal', async () => {
    sharedModels = { 'anthropic/claude-sonnet-4.6': { enabled: false } };
    expect(await triggerModelRefusal(fire)).toBe(NO_USABLE_MODEL);
  });
});
