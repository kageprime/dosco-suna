/** Easy-connect routes: start and finalize an authorization, session connect requests, the Pipedream webhook. */
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { auth, errors, json, lenientBody } from '../../openapi';
import { type ConnectorConnectOwner, parseConnectorConnectOwner } from '../../projects/lib/connection-access';
import { reconcileEventSubscriptionsFromCatalog } from '../../projects/surface';
import type { ConnectorRouterDeps } from '../router';
import { OkSchema, OpaqueSchema, ProjectSlugParam, featureNotSupportedResponse } from './shared';
import { analyticsSource, isPersonSource } from '../../middleware/analytics-source';
import { captureProductEvent } from '../../shared/product-analytics';
import { workspaceIdParam } from '../../shared/route-params';

export function registerConnectRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  // ── Pipedream 1-click connect (admin) ────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{workspaceId}/connectors/{slug}/connect',
      tags: ['connector'],
      summary: 'Start an easy-connect authorization',
      ...auth,
      request: { params: ProjectSlugParam, body: { required: false, content: { 'application/json': { schema: lenientBody({
          owner: z.enum(['me', 'project']).optional().openapi({ description: 'Whose account is connected: me or project.' }),
          success_redirect_uri: z.string().optional().openapi({ description: 'Where to send the browser after success.' }),
          error_redirect_uri: z.string().optional().openapi({ description: 'Where to send the browser after failure.' }),
        }) } } } },
      responses: {
        200: json(OpaqueSchema, 'Connect token / overlay info'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const slug = c.req.param('slug');
      // Native clients pass app deep-link redirect URIs so the in-app browser
      // auto-dismisses back to the app instead of landing on a web page.
      let redirects: { success?: string; error?: string } | undefined;
      let rawOwner: unknown;
      try {
        const body = await c.req.json();
        if (body?.success_redirect_uri || body?.error_redirect_uri) {
          redirects = { success: body.success_redirect_uri, error: body.error_redirect_uri };
        }
        rawOwner = body?.owner;
      } catch {
        /* no body */
      }
      const owner = parseConnectorConnectOwner(rawOwner);
      if (!owner) return c.json({ error: 'owner must be "me" or "project"' }, 400);
      const caller = await authorizeConnectOwner(c, deps, projectId, owner);
      if (!caller) return c.json({ error: 'forbidden' }, 403);
      const connect = deps.connectorConnect ?? (deps.pipedreamConnect
        ? async (pid: string, s: string, uid: string, r?: { success?: string; error?: string }) => {
            const result = await deps.pipedreamConnect!(pid, s, uid, r);
            return result ? { provider: 'pipedream', ...result } : null;
          }
        : undefined);
      if (!connect) return featureNotSupportedResponse(c, 'connector_connect');
      // Set by the auth middleware from a scoped session token, so this is
      // populated exactly when the agent in a sandbox made the call — and null
      // when a human clicked Connect in project settings, which has no session
      // waiting on the answer.
      const requestingSessionId = (c.get('sessionId') as string | undefined) ?? null;
      const result = await connect(
        projectId,
        slug,
        caller.userId,
        redirects,
        requestingSessionId,
        owner,
      );
      if (!result) return c.json({ error: 'not a supported connect connector' }, 404);
      return c.json(result);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/projects/{workspaceId}/connectors/{slug}/connect/finalize',
      tags: ['connector'],
      summary: 'Finalize an easy-connect authorization',
      ...auth,
      request: {
        params: ProjectSlugParam,
        body: { required: false, content: { 'application/json': { schema: z.object({ connection_id: z.string().uuid().optional(), request_id: z.string().min(1).optional() }) } } },
      },
      responses: {
        200: json(OpaqueSchema, 'Connection finalized'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const slug = c.req.param('slug');
      let selector: { connectionId?: string; requestId?: string } | undefined;
      let rawOwner: unknown;
      try {
        const body = await c.req.json();
        if (body?.connection_id || body?.request_id) selector = { connectionId: body.connection_id, requestId: body.request_id };
        rawOwner = body?.owner;
      } catch { /* no body */ }
      const owner = parseConnectorConnectOwner(rawOwner);
      if (!owner) return c.json({ error: 'owner must be "me" or "project"' }, 400);
      // The START route's gate, per owner: finalize is what persists
      // `connected_account_id`, so sibling routes on one resource must agree
      // about who may act (CWE-862). A `me` finalize only ever selects the
      // caller's own member row (`connectorFinalize`).
      const admin = await authorizeConnectOwner(c, deps, projectId, owner);
      if (!admin) return c.json({ error: 'forbidden' }, 403);
      const finalize = deps.connectorFinalize ?? (deps.pipedreamFinalize
        ? async (pid: string, s: string, uid: string) => {
            const result = await deps.pipedreamFinalize!(pid, s, uid);
            return result ? { provider: 'pipedream', ...result } : null;
          }
        : undefined);
      if (!finalize) return featureNotSupportedResponse(c, 'connector_finalize');
      const result = await finalize(projectId, slug, admin.userId, selector, owner);
      if (!result) return c.json({ error: 'not a supported connect connector' }, 404);
      const source = analyticsSource(c);
      if ((result as { connected?: boolean }).connected && isPersonSource(source)) {
        captureProductEvent({
          userId: admin.userId,
          accountId: admin.accountId,
          event: 'connector_connected',
          properties: {
            project_id: projectId,
            provider: (result as { provider?: string }).provider ?? null,
            method: 'oauth',
            owner,
            source,
          },
        });
      }
      // A new shared account may activate pending event triggers.
      await reconcileEventSubscriptionsFromCatalog(projectId, admin.accountId);
      return c.json(result);
    },
  );

  // ── Connect requests this session is waiting on ──────────────────────────
  //
  // The agent mints a connect link mid-turn and stops. The web session reads
  // this to swap that raw URL for a real Connect button, which runs the same
  // popup + finalize flow project settings already uses. Provider-neutral: the
  // rows are keyed on the requesting session, not on who issued the link.
  app.openapi(
    createRoute({
      method: 'get',
      path: '/projects/{workspaceId}/sessions/{sessionId}/connect-requests',
      tags: ['connector'],
      summary: 'Connectors this session asked a human to authorize',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string().min(1) }),
      },
      responses: {
        200: json(OpaqueSchema, 'Pending connect requests'),
        ...errors(403, 404, 501),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const sessionId = c.req.param('sessionId');
      // The person in the session reads what it waits on: their own private
      // sign-ins and the shared ones. A plain member needs nothing more than
      // the session itself; connector administration never gated this.
      const reader = deps.resolveAccountHolder
        ? await deps.resolveAccountHolder(c, projectId)
        : await deps.resolveAdmin(c, projectId);
      if (!reader) return c.json({ error: 'forbidden' }, 403);
      if (!deps.listSessionConnectRequests) {
        return featureNotSupportedResponse(c, 'session_connect_requests');
      }
      if (deps.sessionVisibleTo && !(await deps.sessionVisibleTo(c, projectId, sessionId))) {
        return c.json({ connectors: [] });
      }
      return c.json({ connectors: await deps.listSessionConnectRequests(projectId, sessionId, reader.userId) });
    },
  );
}

/**
 * Who may start or finish an authorization for `owner`:
 *
 *   `me`      the caller's own private account: any person who may use the
 *             workspace (`resolveAccountHolder`). The start creates or reuses
 *             a member row owned by the caller; the finalize selects only that.
 *   `project` the account shared with the whole workspace: connector
 *             administration (`project.connector.write`) AND
 *             `project.connector.connections.manage`, for a person and for an
 *             agent session acting for one alike (the role ∩ the agent grant).
 *
 * Starting returns a sign-in URL; the person still signs in. Null → 403.
 */
async function authorizeConnectOwner(
  c: Context,
  deps: ConnectorRouterDeps,
  projectId: string,
  owner: ConnectorConnectOwner,
): Promise<{ accountId: string; userId: string } | null> {
  if (owner === 'me') {
    return deps.resolveAccountHolder
      ? deps.resolveAccountHolder(c, projectId)
      : deps.resolveAdmin(c, projectId);
  }
  const admin = await deps.resolveAdmin(c, projectId);
  if (!admin) return null;
  if (deps.resolveConnectionsManager && !(await deps.resolveConnectionsManager(c, projectId))) return null;
  return admin;
}

export function registerPipedreamWebhookRoutes(app: OpenAPIHono, deps: ConnectorRouterDeps): void {
  // ── Pipedream webhook (no user auth — HMAC-signed) ────────────────────────
  //
  // AUXILIARY redundancy, not the authoritative path. Every surface that starts
  // a Pipedream connect also calls an explicit finalize afterwards (the web
  // overlay hits POST .../connect/finalize; the hosted setup-link page hits
  // POST /v1/setup-links/connectors/:token/finalize). This webhook exists so a
  // connect that completes while nobody is polling still lands. It performs NO
  // session notification — the finalize route owns that, because only it knows
  // which session asked for the connector.
  app.openapi(
    createRoute({
      method: 'post',
      path: '/webhook/pipedream',
      tags: ['connector'],
      summary: 'Pipedream webhook (HMAC-signed, no user auth)',
      request: {
        query: z.object({ sig: z.string().optional() }),
        body: { content: { 'application/json': { schema: OpaqueSchema } } },
      },
      responses: {
        200: json(OkSchema, 'Accepted'),
        ...errors(400, 401, 501, 503),
      },
    }),
    // Manual parse kept: webhook tolerates an unparseable body (defaults to {})
    // and authenticates via HMAC signature, not a user token.
    async (c: any) => {
      if (!deps.pipedreamWebhook) return featureNotSupportedResponse(c, 'pipedream_webhook');
      const sig = c.req.query('sig') ?? null;
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      // A real Pipedream CONNECTION_ERROR payload carries no `account`, so
      // there is no external user id to finalize and nothing to retry. Ack it
      // (a non-2xx would only look like an outage on their side) and log the
      // reason so a failing connect is still visible in our logs.
      if (body?.event === 'CONNECTION_ERROR') {
        console.warn('[pipedream] connect failed', {
          error: body?.error ?? null,
          connectSessionId: body?.connect_session_id ?? null,
          environment: body?.environment ?? null,
        });
        return c.json({ ok: true, ignored: true });
      }
      // Pipedream's real CONNECTION_SUCCESS nests the id at `account.external_id`.
      // `external_user_id` at the top level is the legacy/back-compat shape we
      // shipped against first — keep accepting it, prefer it when both exist.
      const extUserId =
        (typeof body?.external_user_id === 'string' && body.external_user_id) ||
        (typeof body?.account?.external_id === 'string' && body.account.external_id) ||
        '';
      if (!extUserId) return c.json({ error: 'missing external_user_id' }, 400);
      const result = await deps.pipedreamWebhook(extUserId, sig);
      if (!result.ok) return c.json({ error: 'invalid signature' }, 401);
      // Signature checked out but Pipedream still reports no account for that
      // external user id (eventual consistency outlived the bounded retry).
      // Say so instead of acking a connect that was never persisted.
      if (!result.connected) return c.json({ error: 'account not yet visible' }, 503);
      return c.json({ ok: true });
    },
  );
}
