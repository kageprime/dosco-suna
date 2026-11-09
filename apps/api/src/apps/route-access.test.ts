/**
 * A deployment's `secrets` map sends plaintext values into code the caller
 * ships (GHSA-vx77-8x4h-qf94). The real guard and the real agent-grant
 * predicate run; only the IAM leaf check (it needs the engine + a database) is
 * stubbed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import * as realSurface from '../projects/surface';

let allowed = new Set<string>();
let checked: string[] = [];
mock.module('../projects/surface', () => ({
  ...realSurface,
  assertProjectCapability: async (_c: unknown, _u: string, _a: string, _p: string, action: string) => {
    checked.push(action);
    if (!allowed.has(action)) throw new HTTPException(403, { message: `Missing ${action}` });
  },
}));

const { secretMappingRefusal } = await import('./route-access');

const PROJECT = '66666666-6666-4666-8666-666666666666';
const loaded = { userId: '33333333-3333-4333-8333-333333333333', row: { accountId: '55555555-5555-4555-8555-555555555555' } };

function ctx(agentGrant: unknown = null) {
  return {
    get: (key: string) => (key === 'agentGrant' ? agentGrant : undefined),
    json: (body: unknown, status: number) => Response.json(body, { status }),
  } as never;
}

beforeEach(() => {
  allowed = new Set(['project.app.deploy']);
  checked = [];
});

describe('naming project secrets in an App deployment', () => {
  test('no secrets: nothing more is checked', async () => {
    expect(await secretMappingRefusal(ctx(), loaded, PROJECT, undefined)).toBeNull();
    expect(await secretMappingRefusal(ctx(), loaded, PROJECT, {})).toBeNull();
    expect(checked).toEqual([]);
  });

  test('a deployer without project.secret.read is refused 403', async () => {
    const refused = secretMappingRefusal(ctx(), loaded, PROJECT, { LEAK: 'DEMO_SECRET' });
    await expect(refused).rejects.toMatchObject({ status: 403 });
    expect(checked).toEqual(['project.secret.read']);
  });

  test('a deployer with project.secret.read may map a secret', async () => {
    allowed.add('project.secret.read');
    expect(await secretMappingRefusal(ctx(), loaded, PROJECT, { DB_URL: 'DATABASE_URL' })).toBeNull();
  });

  test('an agent session maps only the secrets its grant delivers to it', async () => {
    allowed.add('project.secret.read');
    const grant = { agent: 'builder', permissions: 'all', connectors: 'all', env: ['database_url'] };
    expect(await secretMappingRefusal(ctx(grant), loaded, PROJECT, { DB_URL: 'DATABASE_URL' })).toBeNull();

    const refused = await secretMappingRefusal(ctx(grant), loaded, PROJECT, { DB_URL: 'DATABASE_URL', LEAK: 'STRIPE_KEY' });
    expect(refused!.status).toBe(403);
    expect(await refused!.json()).toMatchObject({ code: 'agent_scope_insufficient' });

    const unrestricted = { ...grant, env: 'all' };
    expect(await secretMappingRefusal(ctx(unrestricted), loaded, PROJECT, { LEAK: 'STRIPE_KEY' })).toBeNull();
  });
});
