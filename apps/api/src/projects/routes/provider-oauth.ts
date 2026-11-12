/** LLM provider OAuth device flow (ChatGPT via Codex, Google Antigravity via Google's device grant, OpenCode Zen and Go via the OpenCode Console): start, poll, status, disconnect. */
import { parseSharingIntent } from '../../connectors/share';
import { createHash, randomUUID } from 'node:crypto';
import { PROJECT_ACTIONS } from '../../iam';
import { auth, errors, json, lenientBody } from '../../openapi';
import { config } from '../../config';
import { recordAuditEvent, runAuditedTransaction } from '../../shared/audit';
import { db } from '../../shared/db';
import { accountMemberRow } from '../../iam/membership-read';
import { pollCodexDeviceAuth, startCodexDeviceAuth } from '../codex-device-auth';
import {
  pollAntigravityDeviceAuth,
  startAntigravityDeviceAuth,
  buildAntigravityAuthorizeUrl,
  exchangeAntigravityCode,
  antigravityAuthJsonFromTokens,
  createPkcePair,
} from '../antigravity-auth';
import { parseAntigravityAuth } from '../../llm-gateway/credentials/antigravity';
import {
  OPENCODE_CONSOLE_PROVIDERS,
  parseOpencodeLogin,
  pollOpencodeDeviceAuth,
  startOpencodeDeviceAuth,
} from '../../llm-gateway/credentials/opencode-console';
import { resolveCatalogUpstream } from '../../llm-gateway/models/provider-registry';
import { requestPersonalOwner } from '../lib/personal-resources';
import {
  decryptProjectSecret,
  encryptProjectSecret,
  resolveProjectSecretForConsumer,
} from '../secrets';
import { propagateProjectSecretsToActiveSandboxes } from '../lib/sandbox-env-sync';
import { isGatewayManagedEnv } from '../../llm-gateway/sandbox-credentials';
import { createRoute, z } from '@hono/zod-openapi';
import { accountSecretGrants } from '@kortix/db';
import { reconnectProviderAccount, writeProviderAccount } from '../../secrets/provider-accounts';
import { deleteNamedCopiesOfLegacySecrets } from '../../secrets/llm-credential-ledger';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { projectSecrets } from '@kortix/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  loadProjectForUser,
  assertProjectCapability,
  projectCapabilityAllowed,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { parseOAuthStartRequest } from '../lib/provider-oauth-request';
import {
  ANTIGRAVITY_AUTH_JSON_SECRET_NAME,
  CODEX_AUTH_JSON_SECRET_NAME,
  loadSecretViewsForUser,
  normalizeString,
} from '../lib/serializers';
import { readJsonObject } from '../../shared/http-body';
import { rethrowDatabaseError } from '../../shared/database-errors';
import { capturePersonEvent } from './product-events';
import { workspaceIdParam } from '../../shared/route-params';

// ─── Provider OAuth device flow (poll-based) ───────────────────────────────
//
// Connect a subscription-backed LLM provider (a ChatGPT Plus/Pro account via
// the OpenAI Codex device grant, or an OpenCode Console account for OpenCode
// Zen and Go) and save the resulting login as the provider's project secret. Only the LLM gateway can decrypt this
// value. The sandbox receives neither the token nor an opaque handle.
//
// Two quick, NON-streaming calls so they survive any edge (a long-lived
// streaming response gets reset by Cloudflare) and any replica:
//   POST …/oauth/:provider/start → kicks the device flow in a DETACHED
//        background task on this replica, returns the device challenge.
//   POST …/oauth/:provider/poll  → ANY replica reads the shared DB flow row;
//        once the user finishes authorizing, writes the secret and returns it.
// The in-flight flow lives in `kortix.oauth_provider_flows` (not replica
// memory), so start and poll need not hit the same pod. The detached task
// isn't tied to a client connection, so nothing the edge does can kill it.

// Kortix provider id → how its device flow runs and where the login is saved.
// `resourceProviderId` tags a named (pooled)
// connection. `secretName` is read lazily: the OpenCode names come from the
// runtime catalog (a Console login is stored as the provider's own key secret,
// see llm-gateway/credentials/opencode-console.ts).
interface OAuthProvider {
  label: string;
  secretName: string;
  resourceProviderId: string;
  start: () => Promise<{ verificationUrl: string; userCode: string; handle: string; intervalMs: number }>;
  poll: (handle: string, userCode: string) => Promise<
    { status: 'pending' } | { status: 'failed'; error: string } | { status: 'authorized'; authJson: string }>;
  /** Whether a stored value is this login (an OpenCode key secret may hold a plain API key). */
  isLogin: (value: string) => boolean;
}

function oauthProvider(provider: string): OAuthProvider | null {
  if (provider === 'openai') {
    return {
      label: 'ChatGPT', secretName: CODEX_AUTH_JSON_SECRET_NAME, resourceProviderId: 'codex',
      start: async () => {
        const c = await startCodexDeviceAuth();
        return { verificationUrl: c.verificationUrl, userCode: c.userCode, handle: c.deviceAuthId, intervalMs: c.intervalMs };
      },
      poll: (handle, userCode) => pollCodexDeviceAuth({ deviceAuthId: handle, userCode }),
      isLogin: () => true,
    };
  }
  if (provider === 'google') {
    return {
      label: 'Google Antigravity', secretName: ANTIGRAVITY_AUTH_JSON_SECRET_NAME, resourceProviderId: 'antigravity',
      start: async () => {
        const c = await startAntigravityDeviceAuth();
        return { verificationUrl: c.verificationUrl, userCode: c.userCode, handle: c.deviceAuthId, intervalMs: c.intervalMs };
      },
      poll: (handle, userCode) => pollAntigravityDeviceAuth({ deviceAuthId: handle, userCode }),
      isLogin: (value) => parseAntigravityAuth(value) !== null,
    };
  }
  const secretName = OPENCODE_CONSOLE_PROVIDERS[provider] ? resolveCatalogUpstream(provider)?.envVar : null;
  if (!secretName) return null;
  return {
    label: 'OpenCode', secretName, resourceProviderId: provider,
    start: async () => {
      const c = await startOpencodeDeviceAuth();
      return { verificationUrl: c.verificationUrl, userCode: c.userCode, handle: c.deviceCode, intervalMs: c.intervalMs };
    },
    poll: (handle) => pollOpencodeDeviceAuth(handle),
    isLogin: (value) => parseOpencodeLogin(value) !== null,
  };
}

// How long the encrypted flow handle stays valid (OpenAI expires the device
// code on its side too; this just bounds the opaque handle clients hold).
const DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;
// Floor for the client poll cadence (OpenAI returns its own suggested interval).
const OAUTH_POLL_INTERVAL_MS = 3000;

/** A stable named-account id for one device flow (its device code), as a UUID. */
function flowSecretId(deviceCode: string): string {
  const hex = createHash('sha256').update(`provider-oauth-flow:${deviceCode}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A named connection only its owner can use: private, or restricted to the owner
 * alone. Anything wider shares a credential, which is a project secret write. */
function sharingIsOwnerOnly(sharing: ReturnType<typeof parseSharingIntent> | undefined, ownerId: string): boolean {
  if (sharing?.mode === 'private') return true;
  return sharing?.mode === 'members' && !sharing.groupIds?.length &&
    (sharing.memberIds ?? []).every((memberId) => memberId === ownerId);
}

const accountKind = (cfg: OAuthProvider) => ({ providerId: cfg.resourceProviderId, name: cfg.secretName, label: cfg.label });

// Best-effort token expiry (ms remaining) from a stored auth.json, for display.
function authExpiresInMs(authJson: string): number | null {
  try {
    const parsed = JSON.parse(authJson);
    // An OpenCode Console login is flat: { type, access, expires, ... }.
    if (typeof parsed?.expires === 'number') return Math.max(0, parsed.expires - Date.now());
    // opencode auth.json is keyed by provider: { openai: { expires, ... } }.
    for (const entry of Object.values(parsed ?? {})) {
      const expires = (entry as { expires?: unknown })?.expires;
      if (typeof expires === 'number' && Number.isFinite(expires)) {
        return Math.max(0, expires - Date.now());
      }
    }
  } catch {
    // not parseable / no expiry — treat as unknown
  }
  return null;
}

export function registerProviderOauthRoutes(): void {
  // ─── POST /v1/projects/:projectId/oauth/:provider/start ────────────────────
  // Kick the device flow in a detached background task; return the challenge.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/oauth/{provider}/start',
      tags: ['secrets'],
      summary: 'Start an LLM provider OAuth login',
      ...auth,
        request: {
          params: z.object({ workspaceId: z.string(), provider: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              resource_label: z.string().optional().openapi({ description: 'Label of the connection.' }),
              resource_id: z.string().optional().openapi({ description: 'Existing connection to re-authorize.' }),
              sharing: z.record(z.string(), z.any()).optional().openapi({ description: 'Who can use the connection.' }),
            }) } } },
        },
      responses: {
          200: json(z.any(), 'Device challenge'),
          ...errors(400, 401, 403, 404, 502),
      },
    }),
    async (c: any) => {
    const projectId = workspaceIdParam(c);
    const provider = c.req.param('provider');
    const body = await readJsonObject(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const cfg = oauthProvider(provider);
    if (!cfg) {
      return c.json({ error: `OAuth device flow is not available for "${provider}"` }, 400);
    }

    const parsed = await parseOAuthStartRequest(c, body, cfg, loaded, projectId);
    if ('response' in parsed) return parsed.response;
    const { resourceLabel, resourceId, sharing } = parsed.request;
    // A shared credential is a project SECRET WRITE (the device flow persists it
    // via writeOAuthLoginSecret on poll). Gate on the leaf so a custom role can
    // withhold it and the agent-grant fold applies — closing the gap where the
    // flow wrote a shared credential behind only loadProjectForUser('read'). A
    // private (owner-only) credential is the member's own, so read still suffices.
    // A named account restricted to its owner alone is owner-only too, however
    // the client spells it; so is reconnecting your own account. The legacy
    // unnamed login treats `members` as shared, so this applies to named ones only.
    // The poll step is reachable only with the project-key-encrypted flow handle
    // minted here, so gating start transitively protects the write on poll.
    const ownerOnly = resourceId !== null ||
      (resourceLabel !== null && sharingIsOwnerOnly(sharing, loaded.userId));
    if (sharing?.mode !== 'private' && !ownerOnly) {
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
    }

    // Request a device code straight from the provider — a couple HTTPS calls, no
    // subprocess, no server-side flow record. Everything `poll` needs is sealed
    // into the opaque `flow_id` (encrypted with the project key), so any replica
    // can serve any poll and there's nothing to leak or OOM.
    let challenge;
    let redirectMode = false;
    let redirectMeta: any = null;
    try {
      if (provider === 'google') {
        redirectMode = true;
        const { codeVerifier, codeChallenge } = createPkcePair();
        const state = randomUUID();
        const redirectUri = config.GOOGLE_ANTIGRAVITY_REDIRECT_URI || 'http://localhost:51121/oauth-callback';
        const authorizeUrl = buildAntigravityAuthorizeUrl({ state, codeChallenge, redirectUri });
        redirectMeta = { codeVerifier, state, redirectUri, authorizeUrl };
        challenge = { verificationUrl: authorizeUrl, userCode: '', handle: 'redirect', intervalMs: 1000 };
      } else {
        challenge = await cfg.start();
      }
    } catch (err) {
      rethrowDatabaseError(err);
      return c.json({
        error: err instanceof Error ? err.message : `Failed to start ${cfg.label} authorization`,
      }, 502);
    }

    const expiresAt = Date.now() + DEVICE_AUTH_TTL_MS;
    const flowId = encryptProjectSecret(
      projectId,
      JSON.stringify({
        p: provider,
        d: challenge.handle,
        u: challenge.userCode,
        s: sharing ?? null,
        uid: loaded.userId,
        ...(resourceLabel === null ? {} : { l: resourceLabel, rid: randomUUID() }),
        ...(resourceId === null ? {} : { rid: resourceId, rc: 1 }),
        // A redirect flow has no device code to derive a stable resource id
        // from, so seal one now: two members must not overwrite one secret.
        ...(redirectMode ? { rid: resourceId ?? randomUUID() } : {}),
        e: expiresAt,
        i: Math.max(challenge.intervalMs, OAUTH_POLL_INTERVAL_MS),
        ...(redirectMode && redirectMeta ? { m: 'r', st: redirectMeta.state, cv: redirectMeta.codeVerifier, ru: redirectMeta.redirectUri } : {}),
      }),
    );

    const resp: any = {
      flow_id: flowId,
      verification_url: challenge.verificationUrl,
      user_code: challenge.userCode,
      expires_at: expiresAt,
      interval_ms: Math.max(challenge.intervalMs, OAUTH_POLL_INTERVAL_MS),
    };
    if (redirectMode && redirectMeta) {
      resp.mode = 'redirect';
      resp.authorize_url = redirectMeta.authorizeUrl;
      resp.redirect_uri = redirectMeta.redirectUri;
    }
    return c.json(resp);
  },
  );

  // ─── POST /v1/projects/:projectId/oauth/:provider/poll ─────────────────────
  // Any replica: read the shared flow row; on success persist the secret.
  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/oauth/{provider}/poll',
      tags: ['secrets'],
      summary: 'Poll an LLM provider OAuth login',
      ...auth,
        request: {
          params: z.object({ workspaceId: z.string(), provider: z.string() }),
          body: { content: { 'application/json': { schema: lenientBody({
              flow_id: z.string().openapi({ description: 'Flow id returned by start.' }),
              redirect_url: z.string().optional().openapi({ description: 'Redirect URL pasted from the OAuth callback page.' }),
            }) } } },
        },
      responses: {
          200: json(z.any(), 'Poll result'),
          ...errors(400, 401, 404),
      },
    }),
    async (c: any) => {
    const projectId = workspaceIdParam(c);
    const provider = c.req.param('provider');
    const body = await readJsonObject(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);

    const flowId = normalizeString(body.flow_id);
    if (!flowId) return c.json({ error: 'flow_id is required' }, 400);
    const cfg = oauthProvider(provider);
    if (!cfg) return c.json({ error: `OAuth device flow is not available for "${provider}"` }, 400);

    // Decrypt the opaque flow handle. The key is project-scoped, so a handle from
    // another project — or a tampered one — simply won't decrypt → expired.
    let state: { p?: string; d?: string; u?: string; s?: unknown; uid?: string; e?: number; i?: number; l?: string; rid?: string; rc?: number; m?: string; st?: string; cv?: string; ru?: string };
    try {
      state = JSON.parse(decryptProjectSecret(projectId, flowId));
    } catch {
      return c.json({ status: 'expired' });
    }
    // Only the member who started it may poll it, only for the provider it was
    // started for (handles sealed before `p` existed are ChatGPT), and only
    // before it expires.
    const isRedirect = state.m === 'r' && provider === 'google';
    const deviceHandle = state.d;
    const deviceCode = state.u;
    if (
      (isRedirect ? deviceHandle !== 'redirect' : !deviceHandle || !deviceCode) ||
      (state.p ?? 'openai') !== provider ||
      state.uid !== loaded.userId ||
      typeof state.e !== 'number' || Date.now() > state.e
    ) {
      return c.json({ status: 'expired' });
    }
    if ((state.l || state.rc) && state.rid) {
      const [member] = await accountMemberRow(loaded.row.accountId, loaded.userId);
      if (!member) return c.json({ status: 'failed', error: 'Account membership is required' });
    }

    let result: { status: 'pending' } | { status: 'failed'; error: string } | { status: 'authorized'; authJson: string };
    if (state.m === 'r' && provider === 'google') {
      const redirectUrl = normalizeString((body as any).redirect_url);
      if (!redirectUrl) {
        return c.json({ status: 'pending', next_poll_ms: Math.max(state.i ?? 0, OAUTH_POLL_INTERVAL_MS) });
      }
      try {
        const url = new URL(redirectUrl);
        const error = url.searchParams.get('error');
        if (error) {
          return c.json({ status: 'failed', error: url.searchParams.get('error_description') || error });
        }
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        if (!code) {
          return c.json({ status: 'failed', error: 'Missing authorization code in redirect URL' });
        }
        if (returnedState && state.st && returnedState !== state.st) {
          return c.json({ status: 'failed', error: 'OAuth state mismatch' });
        }
        const tokens = await exchangeAntigravityCode({ code, codeVerifier: state.cv || '', redirectUri: state.ru });
        const authJson = await antigravityAuthJsonFromTokens(tokens as any);
        result = { status: 'authorized', authJson };
      } catch (err) {
        return c.json({ status: 'failed', error: err instanceof Error ? err.message : 'Failed to complete Google sign-in' });
      }
    } else {
      if (!deviceHandle || !deviceCode) return c.json({ status: 'expired' });
      result = await cfg.poll(deviceHandle, deviceCode);
      if (result.status === 'pending') {
        // Never ask a client to poll faster than the provider's own interval: the
        // CLI adopts next_poll_ms, and 3 s against OpenCode's 5 s broke dev sign-in.
        return c.json({ status: 'pending', next_poll_ms: Math.max(state.i ?? 0, OAUTH_POLL_INTERVAL_MS) });
      }
    }
    if (result.status === 'failed') {
      return c.json({ status: 'failed', error: result.error });
    }

    if (state.rc && state.rid) {
      if (!resolveFeatureFlag(loaded.row.metadata, 'pooled_provider_secrets')) {
        return c.json({ status: 'failed', error: 'Pooled OAuth connections are disabled for this workspace' });
      }
      const reconnected = await reconnectProviderAccount({
        secretId: state.rid, accountId: loaded.row.accountId, userId: loaded.userId,
        projectId, value: result.authJson, kind: accountKind(cfg),
      });
      if (!reconnected) {
        return c.json({ status: 'failed', error: `This ${cfg.label} account is no longer available. Add it again.` });
      }
      capturePersonEvent(c, loaded, projectId, 'provider_configured', { provider: String(provider), method: 'oauth' });
      return c.json({ status: 'success', credential: {
        provider_id: cfg.resourceProviderId, secret_id: reconnected.secretId, label: reconnected.label,
        expires_in_ms: authExpiresInMs(result.authJson), updated_at: new Date().toISOString(),
      } });
    }

    // The sealed resource id makes a completed device flow idempotent. A new
    // device flow gets a new resource; it never overwrites another user's login.
    if (state.l && state.rid) {
      if (!resolveFeatureFlag(loaded.row.metadata, 'pooled_provider_secrets')) {
        return c.json({ status: 'failed', error: 'Pooled OAuth connections are disabled for this workspace' });
      }
      const secretId = await writeProviderAccount({
        secretId: state.rid, accountId: loaded.row.accountId, userId: loaded.userId,
        label: state.l, value: result.authJson, projectId, kind: accountKind(cfg),
        sharing: state.s ? (parseSharingIntent(state.s, loaded.userId) ?? undefined) : undefined,
      });
      capturePersonEvent(c, loaded, projectId, 'provider_configured', { provider: String(provider), method: 'oauth' });
      return c.json({ status: 'success', credential: {
        provider_id: cfg.resourceProviderId, secret_id: secretId, label: state.l,
        expires_in_ms: authExpiresInMs(result.authJson), updated_at: new Date().toISOString(),
      } });
    }

    // No label sent (an older client): the login is still a named account,
    // the one store of provider credentials (secrets/llm-credential-move.ts),
    // with the product's name as its label. `sharing` keeps its old meaning:
    // none or `project` is the whole workspace, `private` only the caller.
    const sharing = state.s ? (parseSharingIntent(state.s, loaded.userId) ?? undefined) : undefined;
    await writeProviderAccount({
      // One id per flow, so a repeated completion writes one row.
      secretId: state.rid ?? (state.d ? flowSecretId(state.d) : randomUUID()), accountId: loaded.row.accountId, userId: loaded.userId,
      label: cfg.label, value: result.authJson, projectId, kind: accountKind(cfg), sharing,
    });

    capturePersonEvent(c, loaded, projectId, 'provider_configured', { provider: String(provider), method: 'oauth' });
    return c.json({
      status: 'success',
      credential: {
        provider_id: provider,
        expires_in_ms: authExpiresInMs(result.authJson),
        updated_at: new Date().toISOString(),
      },
    });
  },
  );

  // ─── GET /v1/projects/:projectId/oauth ─────────────────────────────────────
  // List configured OAuth credentials (derived from the saved project secrets).
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/oauth',
      tags: ['secrets'],
      summary: 'List connected LLM provider logins',
      ...auth,
        request: { params: z.object({ workspaceId: z.string() }) },
      responses: {
          200: json(z.any(), 'Configured OAuth credentials'),
          ...errors(401, 404),
      },
    }),
    async (c: any) => {
    const projectId = workspaceIdParam(c);
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_READ);

    const items: Array<{ provider_id: string; expires_in_ms: number | null; updated_at: string }> = [];
    for (const providerId of ['openai', 'google', ...Object.keys(OPENCODE_CONSOLE_PROVIDERS)]) {
      const cfg = oauthProvider(providerId);
      if (!cfg) continue;
      const credential = await resolveProjectSecretForConsumer({
        projectId,
        accountId: loaded.row.accountId,
        actorUserId: loaded.userId,
        principalUserId: await requestPersonalOwner(c, loaded),
        name: cfg.secretName,
        consumer: 'llm_gateway',
      });
      // An OpenCode key secret holding a plain API key is not a login.
      if (!credential || !cfg.isLogin(credential.value)) continue;
      items.push({
        provider_id: providerId,
        expires_in_ms: authExpiresInMs(credential.value),
        updated_at: credential.updatedAt.toISOString(),
      });
    }

    return c.json({ items });
  },
  );

  // ─── DELETE /v1/projects/:projectId/oauth/:provider ────────────────────────
  // Remove an OAuth credential (deletes the backing secret).
  // The login can be a per-user PRIVATE row (`owner_user_id` set) or the shared
  // project row. The delete covers exactly the rows `loadSecretViewsForUser`
  // shows the caller: the caller's own private rows, plus the shared row when
  // the caller may manage shared secrets. Another member's private login is
  // never touched.
  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{workspaceId}/oauth/{provider}',
      tags: ['secrets'],
      summary: 'Disconnect an LLM provider login',
      ...auth,
        request: { params: z.object({ workspaceId: z.string(), provider: z.string() }) },
      responses: {
          200: json(z.any(), 'OK'),
          ...errors(401, 403, 404),
      },
    }),
    async (c: any) => {
    const projectId = workspaceIdParam(c);
    const provider = c.req.param('provider');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE);

    const cfg = oauthProvider(provider);
    if (!cfg) return c.json({ error: 'Not found' }, 404);

    // Same test the GET secrets route uses for `can_manage_shared`.
    const canManageShared = await projectCapabilityAllowed(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SECRET_WRITE);
    const ownPrivate = eq(projectSecrets.ownerUserId, loaded.userId);

    await runAuditedTransaction(
      async (tx) => {
        const removed = await tx
          .delete(projectSecrets)
          .where(
            and(
              eq(projectSecrets.projectId, projectId),
              eq(projectSecrets.name, cfg.secretName),
              canManageShared ? or(ownPrivate, isNull(projectSecrets.ownerUserId)) : ownPrivate,
            ),
          )
          .returning({ secretId: projectSecrets.secretId });
        // A login the backfill moved lives on as a named account: disconnect
        // that copy too, or the old client's disconnect changes nothing.
        await deleteNamedCopiesOfLegacySecrets(tx, loaded.row.accountId, removed.map((row) => row.secretId));
      },
      () => ({
        accountId: loaded.row.accountId,
        projectId,
        actorUserId: loaded.userId,
        actorType: 'human',
        source: 'api',
        action: 'secret.oauth.disconnected',
        resourceType: 'project_secret',
        metadata: {
          identifier: cfg.secretName,
          consumer: 'llm_gateway',
          scope: canManageShared ? 'own_private_and_shared' : 'own_private',
        },
      }),
    );
    void propagateProjectSecretsToActiveSandboxes(projectId, { refreshModels: isGatewayManagedEnv(cfg.secretName) });

    return c.json({ ok: true });
  },
  );
}
