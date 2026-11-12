/**
 * The MFA level an App viewer token carries into the IAM actor.
 *
 * The Apps gate mints a `kortix_oat_` token for a viewer it admitted under the
 * App account's MFA rule. Built with no level, every call the App made as its
 * viewer got `403 account_mfa_required` in an account that requires MFA
 * (2026-11-11). The token counts as the second factor in the App's own account
 * and in no other account.
 */
import { describe, expect, test } from 'bun:test';
import { Hono, type Context } from 'hono';
import { buildActor } from '../iam/actor';

const VIEWER = 'a7200000-0000-4000-a000-000000000001';
const APP_ACCOUNT = 'a7200000-0000-4000-a000-000000000002';
const OTHER_ACCOUNT = 'a7200000-0000-4000-a000-000000000003';

async function actorFor(vars: Record<string, string>, accountId: string) {
  let out: Awaited<ReturnType<typeof buildActor>> = null;
  const app = new Hono();
  app.get('/', async (c: Context) => {
    for (const [key, value] of Object.entries(vars)) c.set(key as never, value as never);
    out = await buildActor(c, accountId);
    return c.body(null, 204);
  });
  await app.request('/');
  return out!;
}

// What auth-oauth sets for a token whose row records mfa_aal = 'aal2'.
const appViewerToken = { userId: VIEWER, authType: 'oauth', accountId: APP_ACCOUNT, oauthMfaAccountId: APP_ACCOUNT };

describe('an App viewer token in the IAM actor', () => {
  test('counts as aal2 in the App account', async () => {
    expect((await actorFor(appViewerToken, APP_ACCOUNT)).ctx.mfaAal).toBe('aal2');
  });

  test('carries no level into another account', async () => {
    expect((await actorFor(appViewerToken, OTHER_ACCOUNT)).ctx.mfaAal).toBeUndefined();
  });

  test('a token whose row records no level carries none', async () => {
    expect((await actorFor({ userId: VIEWER, authType: 'oauth', accountId: APP_ACCOUNT }, APP_ACCOUNT)).ctx.mfaAal).toBeUndefined();
  });

  test('a browser session keeps its own level', async () => {
    const session = { userId: VIEWER, authType: 'supabase', accountId: APP_ACCOUNT };
    expect((await actorFor({ ...session, mfaAal: 'aal1' }, APP_ACCOUNT)).ctx.mfaAal).toBe('aal1');
    expect((await actorFor({ ...session, mfaAal: 'aal2' }, OTHER_ACCOUNT)).ctx.mfaAal).toBe('aal2');
  });
});
