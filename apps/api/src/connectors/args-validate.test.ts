/**
 * A connector call is checked against its action's `inputSchema` before
 * dispatch. Pure unit test: every gateway dep is faked, no PostgreSQL, and the
 * fake upstream counts the requests it receives.
 */
import { describe, expect, test } from 'bun:test';
import { invalidArgsReason } from './args-validate';
import { type GatewayDeps, INVALID_ARGS, handleCall } from './gateway';

const SCHEMA = {
  type: 'object',
  properties: {
    profileId: { type: 'integer' },
    types: { type: 'string' },
    limit: { type: 'number' },
    expand: { type: 'boolean' },
    filter: { type: 'object' },
    ids: { type: 'array' },
    region: { type: 'string', default: 'eu' },
  },
  required: ['profileId', 'region'],
};
const TOOL = 'bank.balances_list';

describe('invalidArgsReason', () => {
  test('a missing required argument is named', () => {
    expect(invalidArgsReason(SCHEMA, {}, TOOL)).toContain('The required argument profileId is missing');
    expect(invalidArgsReason(SCHEMA, { profileId: null }, TOOL)).toContain('profileId is missing');
  });

  test('a wrong JSON type is named with the type it must be', () => {
    expect(invalidArgsReason(SCHEMA, { profileId: 'abc' }, TOOL)).toBe(
      'The argument profileId must be integer, not string. Call bank.balances_list again with profileId as integer.',
    );
    expect(invalidArgsReason(SCHEMA, { profileId: 1, types: { a: 1 } }, TOOL)).toContain('types must be string, not object');
    expect(invalidArgsReason(SCHEMA, { profileId: 1, filter: 'x' }, TOOL)).toContain('filter must be object, not string');
    expect(invalidArgsReason(SCHEMA, { profileId: 1, ids: 'a,b' }, TOOL)).toContain('ids must be array, not string');
    expect(invalidArgsReason(SCHEMA, { profileId: 1, expand: 'yes' }, TOOL)).toContain('expand must be boolean');
  });

  test('a valid call passes, including values the upstream reads the same way', () => {
    expect(invalidArgsReason(SCHEMA, { profileId: 101 }, TOOL)).toBeNull();
    expect(invalidArgsReason(SCHEMA, { profileId: '101', types: 7, limit: '2.5', expand: 'true', filter: {}, ids: [] }, TOOL)).toBeNull();
    // `region` is required but has a default; an optional null means "not set".
    expect(invalidArgsReason(SCHEMA, { profileId: 1, types: null }, TOOL)).toBeNull();
    // A JSON-string body is sent upstream as the object it encodes.
    expect(invalidArgsReason(SCHEMA, { profileId: 1, filter: '{"a":1}', ids: '[1,2]' }, TOOL)).toBeNull();
    expect(invalidArgsReason(SCHEMA, { profileId: 1, filter: '[1]' }, TOOL)).toContain('filter must be object, not string');
    // An undeclared argument and an unchecked schema are left to the upstream.
    expect(invalidArgsReason(SCHEMA, { profileId: 1, extra: { a: 1 } }, TOOL)).toBeNull();
    expect(invalidArgsReason(null, {}, TOOL)).toBeNull();
    expect(invalidArgsReason({ type: 'object', properties: { a: { anyOf: [{ type: 'string' }] } } }, { a: 1 }, TOOL)).toBeNull();
  });

  test('values the gateway rewrites before dispatch pass', () => {
    const schema = {
      type: 'object',
      properties: { content: { type: 'string' }, file: { type: 'object', file_uploadable: true } },
      required: ['content'],
    };
    expect(
      invalidArgsReason(schema, { content: { $kortix_attachment: 'att-synthetic' }, file: 'https://files.example/a.pdf' }, TOOL),
    ).toBeNull();
  });
});

describe('the gateway answers invalid_args before any upstream call', () => {
  let upstreamCalls = 0;
  const deps: GatewayDeps = {
    loadConnectorBySlug: async () => ({
      connectorId: 'conn-bank',
      slug: 'bank',
      provider: 'http',
      baseUrl: 'https://bank.example',
      auth: { type: 'bearer', in: 'header', name: null, prefix: null },
      hasAuth: true,
      credentialMode: 'shared',
      enabled: true,
    }),
    loadAction: async () => ({
      path: TOOL,
      relPath: 'balances_list',
      inputSchema: SCHEMA,
      risk: 'read',
      binding: { kind: 'http', method: 'GET', path: '/balances' },
    }),
    resolveCredential: async () => 'synthetic-credential',
    loadPolicies: async () => [],
    recordExecution: async () => 'exec-1',
    fetchImpl: async () => {
      upstreamCalls++;
      return { status: 200, ok: true, text: async () => '[]' };
    },
  };
  const call = (args: Record<string, unknown>) =>
    handleCall(deps, {
      projectId: 'project-fake',
      accountId: 'account-fake',
      subject: { userId: 'user-fake', groupIds: [] },
      connectorSlug: 'bank',
      actionPath: 'balances_list',
      args,
    });

  test('a missing required argument: invalid_args naming it, no upstream call', async () => {
    const result = await call({});
    expect(result).toMatchObject({ status: 'denied', reason: INVALID_ARGS });
    expect((result as { message?: string }).message).toContain('profileId');
    expect(upstreamCalls).toBe(0);
  });

  test('a wrong type: invalid_args naming it, no upstream call', async () => {
    const result = await call({ profileId: [1] });
    expect(result).toMatchObject({ status: 'denied', reason: INVALID_ARGS });
    expect((result as { message?: string }).message).toContain('profileId must be integer, not array');
    expect(upstreamCalls).toBe(0);
  });

  test('a valid call reaches the upstream unchanged', async () => {
    expect(await call({ profileId: 101 })).toMatchObject({ status: 'ok' });
    expect(upstreamCalls).toBe(1);
  });
});
