/**
 * Disconnecting one Kortix Google connector keeps the account's other Google
 * connections working.
 *
 * Google keeps ONE grant per account for an OAuth client: revoking any token
 * of it revokes every token. On 2026-11-20, disconnecting Drive on staging
 * made Calendar fail with `credential_rejected` (HTTP 401). Disconnect now
 * revokes upstream only for the account's last live connection; the others
 * only lose their local credential.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import { connectionCredentials, connectorConnections, connectors, projects } from '@kortix/db';
import { config } from '../config';
import { ensureDefaultConnection, upsertConnectionCredential } from '../connectors/credentials';
import { createStoredDelegatedCredential } from '../connectors/oauth2-delegated';
import { revokeConnectionOAuth2, saveOAuth2Application } from '../connectors/oauth2-store';
import { db } from '../shared/db';
import { seedAccount } from './helpers/integration-fixtures';

const SUFFIX = crypto.randomUUID().slice(0, 8).toLowerCase();
const USER = crypto.randomUUID();
const CLIENT_ID = `shared-grant-${SUFFIX}.apps.googleusercontent.example`;
const ORIGINAL_CLIENTS = config.KORTIX_OAUTH_CLIENTS;
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const GOOGLE_APPLICATION = {
  issuer: 'https://accounts.google.com',
  authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_url: 'https://oauth2.googleapis.com/token',
  revocation_url: REVOKE_URL,
  client_id: CLIENT_ID,
  client_secret: 'synthetic-secret',
  token_endpoint_auth_method: 'client_secret_post',
} as OAuth2ApplicationInput;

let accountId: string;
let projectId: string;
const connectorIds: string[] = [];

async function googleConnection(slug: string, connectedAs: string): Promise<string> {
  const [connector] = await db
    .insert(connectors)
    .values({
      accountId,
      projectId,
      slug: `${slug}-${SUFFIX}`,
      name: `Shared grant ${slug}`,
      providerType: 'http',
      config: { baseUrl: 'https://connector.example.test', auth: { type: 'oauth2' } },
    })
    .returning({ connectorId: connectors.connectorId });
  const connectorId = connector!.connectorId;
  connectorIds.push(connectorId);
  const connectionId = await ensureDefaultConnection({ projectId, connectorId, createdBy: USER });
  await saveOAuth2Application({ accountId, projectId, connectorId, connectionId }, GOOGLE_APPLICATION, USER);
  await upsertConnectionCredential({
    projectId,
    connectorId,
    connectionId,
    value: createStoredDelegatedCredential(GOOGLE_APPLICATION, {
      access_token: `access-${slug}`,
      refresh_token: `refresh-${slug}`,
      token_type: 'Bearer',
      expires_at: Date.now() + 3_600_000,
      scopes: [],
    }),
    kind: 'oauth2_delegated',
    createdBy: USER,
  });
  await db
    .update(connectorConnections)
    .set({ metadata: { connected_as: connectedAs } })
    .where(eq(connectorConnections.connectionId, connectionId));
  return connectionId;
}

async function state(connectionId: string) {
  const [connection] = await db
    .select({ status: connectorConnections.status })
    .from(connectorConnections)
    .where(eq(connectorConnections.connectionId, connectionId));
  const credentials = await db
    .select({ id: connectionCredentials.credentialId })
    .from(connectionCredentials)
    .where(eq(connectionCredentials.connectionId, connectionId));
  return { status: connection?.status, credentials: credentials.length };
}

function recordingFetch() {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${String(url)} ${String(new URLSearchParams(String(init?.body ?? '')).get('token_type_hint'))}`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, runtime: { fetchImpl: fetchImpl as typeof fetch } };
}

let calendar: string;
let drive: string;
let otherAccount: string;

beforeAll(async () => {
  config.KORTIX_OAUTH_CLIENTS = JSON.stringify({ google: { client_id: CLIENT_ID, client_secret: 'synthetic-secret' } });
  accountId = await seedAccount('google-shared-grant');
  projectId = crypto.randomUUID();
  await db.insert(projects).values({
    projectId,
    accountId,
    name: `Google shared grant ${SUFFIX}`,
    repoUrl: resolve(import.meta.dir, '../../../..'),
    defaultBranch: '',
    manifestPath: '',
  });
  calendar = await googleConnection('google-calendar', `Demo.${SUFFIX}@example.test`);
  drive = await googleConnection('google-drive', `demo.${SUFFIX}@example.test`);
  otherAccount = await googleConnection('gmail', `other.${SUFFIX}@example.test`);
});

afterAll(async () => {
  config.KORTIX_OAUTH_CLIENTS = ORIGINAL_CLIENTS;
  await db.delete(connectionCredentials).where(inArray(connectionCredentials.connectorId, connectorIds));
  await db.delete(connectorConnections).where(inArray(connectorConnections.connectorId, connectorIds));
  await db.delete(connectors).where(eq(connectors.projectId, projectId));
  await db.delete(projects).where(eq(projects.projectId, projectId));
});

describe('disconnecting a Kortix Google connector (one grant per Google account)', () => {
  test('while another live connection of the same account exists, Google is not called and only the local credential goes', async () => {
    const { calls, runtime } = recordingFetch();
    await revokeConnectionOAuth2(drive, runtime);
    expect(calls).toEqual([]);
    expect(await state(drive)).toEqual({ status: 'revoked', credentials: 0 });
    expect(await state(calendar)).toEqual({ status: 'active', credentials: 1 });
  });

  test("the account's last connection revokes at Google; another account's connection does not hold it back", async () => {
    const { calls, runtime } = recordingFetch();
    await revokeConnectionOAuth2(calendar, runtime);
    expect(calls).toEqual([`${REVOKE_URL} refresh_token`, `${REVOKE_URL} access_token`]);
    expect(await state(calendar)).toEqual({ status: 'revoked', credentials: 0 });
    expect(await state(otherAccount)).toEqual({ status: 'active', credentials: 1 });
  });
});
