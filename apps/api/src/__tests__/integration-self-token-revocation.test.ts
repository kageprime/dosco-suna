/**
 * Integration test (real local DB + the real Hono app) for `DELETE
 * /v1/me/tokens/self`: revoke the personal key this request authenticated
 * with.
 *
 * KRTX-4493: `kortix logout` only blanked the token in the local config — the
 * personal key `kortix login` minted stayed active and kept working, so every
 * login/logout cycle left one more live 'CLI · device login' key under
 * Settings → Personal keys. The CLI stores only the secret PAT and the token
 * lists expose `public_key` (an unrelated random string), so the CLI cannot
 * map its bearer to a token_id: the API must revoke the presented credential.
 *
 * The fence mirrors `DELETE /me/tokens/{tokenId}`: a person's browser session
 * or personal key only; a workspace key (project-scoped), a session connector
 * token, a service account, or an OAuth token is refused, so a credential can
 * never widen itself.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountTokens, accounts, projects } from '@kortix/db';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';

const ACCOUNT = crypto.randomUUID();
const USER = crypto.randomUUID();
const minted: string[] = [];

beforeAll(async () => {
  await db.execute(
    sql`insert into kortix.accounts (account_id, name) values (${ACCOUNT}, 'self-token-revoke-test')`,
  );
  await db.execute(
    sql`insert into kortix.account_members (user_id, account_id, account_role)
        values (${USER}, ${ACCOUNT}, 'owner')`,
  );
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  // Cascades account_members and any remaining tokens.
  await db.execute(sql`delete from kortix.accounts where account_id = ${ACCOUNT}`);
});

async function mintToken(name: string, opts: { projectId?: string } = {}) {
  const token = await createAccountToken({ accountId: ACCOUNT, userId: USER, name, ...opts });
  minted.push(token.tokenId);
  return token;
}

const authedRequest = (secretKey: string, path = '/v1/accounts', method = 'GET') =>
  app.request(path, { method, headers: { Authorization: `Bearer ${secretKey}` } });

const statusOf = async (tokenId: string) =>
  (await db.select({ status: accountTokens.status, revokedAt: accountTokens.revokedAt })
    .from(accountTokens).where(eq(accountTokens.tokenId, tokenId)))[0];

const deleteSelf = (secretKey: string) =>
  app.request('/v1/me/tokens/self', { method: 'DELETE', headers: { Authorization: `Bearer ${secretKey}` } });

describe('DELETE /v1/me/tokens/self', () => {
  test('revokes the bearer, which then stops authenticating (KRTX-4493)', async () => {
    const { secretKey, tokenId } = await mintToken('logout-self-revoke');

    // Alive before logout — the credential the journey saved from the config.
    expect((await authedRequest(secretKey)).status).toBe(200);

    // The logout revoke call.
    const res = await deleteSelf(secretKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The reported failure mode: a request with the logged-out credential
    // must no longer succeed.
    expect((await authedRequest(secretKey)).status).toBe(401);

    const row = await statusOf(tokenId);
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).toBeTruthy();
  });

  test('a second call with the same credential answers 401 (it is dead)', async () => {
    const { secretKey } = await mintToken('logout-self-revoke-twice');
    expect((await deleteSelf(secretKey)).status).toBe(200);
    expect((await deleteSelf(secretKey)).status).toBe(401);
  });

  test('a project-scoped key cannot revoke itself here (person fence)', async () => {
    const projectId = crypto.randomUUID();
    await db.insert(projects).values({
      projectId,
      accountId: ACCOUNT,
      name: 'self-revoke-scope',
      repoUrl: 'https://example.com/self-revoke-scope.git',
    });
    const { secretKey, tokenId } = await mintToken('logout-self-revoke-scoped', { projectId });
    const res = await deleteSelf(secretKey);
    expect(res.status).toBe(403);
    expect((await statusOf(tokenId))?.status).toBe('active');
  });
});
