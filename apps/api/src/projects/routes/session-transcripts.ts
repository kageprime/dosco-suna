/**
 * A session's message authors, model usage and usage tree. The v1 transcript
 * route (`GET …/transcript`) was removed by session-log plan P8.3: the session
 * log (`GET …/log`, `session-log.ts`) is the stored conversation.
 */

import { PROJECT_ACTIONS } from '../../iam';
import { resolveSessionBinding } from './lib/route-bindings';
import { auth, errors, json } from '../../openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { loadVisibleSession, loadVisibleSessionsForList, assertProjectCapability, sessionIsTombstoned } from '../lib/access';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { AnyObject, projectsApp } from '../lib/app';
import { isUuid } from '../../shared/validate';
import { sessionMessageAuthors } from '../lib/session-message-authors';
import { sessionModelUsage } from '../lib/session-model-usage';
import { sessionUsageTree } from '../lib/session-usage';
import { workspaceIdParam } from '../../shared/route-params';

const SessionUsageTotalsSchema = z.object({
  cost: z.number(),
  kortix_cost: z.number(),
  provider_cost: z.number(),
  request_count: z.number().int(),
  error_count: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cached_tokens: z.number().int(),
  cache_write_tokens: z.number().int(),
  compute_cost: z.number(),
  billed_cost: z.number(),
});

const SessionUsageTreeSchema = z
  .object({
    session_id: z.string(),
    currency: z.literal('USD'),
    total: SessionUsageTotalsSchema,
    sessions: z.array(
      SessionUsageTotalsSchema.extend({
        session_id: z.string(),
        parent_session_id: z.string().nullable(),
        depth: z.number().int(),
        title: z.string().nullable(),
        agent_name: z.string().nullable(),
        status: z.string(),
        created_at: z.string(),
      }),
    ),
    hidden_sessions: z.number().int(),
    truncated: z.boolean(),
  })
  .openapi('SessionUsageTree');

export function registerSessionTranscriptsRoutes(): void {
  // GET /v1/projects/:projectId/sessions/:sessionId/message-authors
  // Who wrote each message, from the authenticated prompt ledger: a member, or
  // another session's agent. The live runtime carries no author.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/sessions/{sessionId}/message-authors',
      tags: ['sessions'],
      summary: 'Read who wrote each message of a session',
      description:
        'Returns `authors`, keyed by runtime message id: `{kind:"member", user_id, name, email}` or `{kind:"session", session_id, name, agent?}` (`agent` is the agent the sending session runs). `initial_author` is the parent session for a spawned session\'s first message, else null. `stops` is keyed by the runtime message id that started a turn a member stopped: the `{kind:"member", …}` who stopped it. Always present, `{}` when none.',
      ...auth,
      request: { params: z.object({ workspaceId: z.string(), sessionId: z.string() }) },
      responses: { 200: json(AnyObject, 'Message authors'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      const binding = await resolveSessionBinding(c, projectId, sessionId, 'read');
      if (binding.kind === 'error') return binding.response as never;
      const { loaded } = binding;
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
      const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
      if (!visible || sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);
      return c.json(await sessionMessageAuthors(visible.row));
    },
  );

  // GET /v1/projects/:projectId/sessions/:sessionId/model-usage
  // Which model answered each turn, and what Kortix billed for it, from the
  // gateway's request ledger. The runtime records only the model it asked for.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/sessions/{sessionId}/model-usage',
      tags: ['sessions'],
      summary: 'Read which model a session\'s requests were served by and what they cost',
      description:
        'Returns `latest`, the newest model request of any outcome: `{served_model, fallback_from, at, outcome}`. `outcome` is `answered`, `client_aborted` (the caller canceled it) or `error`; a cancel is not a model failure. `served_model` is the route id recorded for the request — the model that answered it, or on an unanswered request the model it was being served by. `fallback_from` is the routed model when the gateway rerouted after a failed attempt, whether or not the fallback answered, else null. `billed_cost` is what Kortix debited for the session\'s model calls, in USD. `turns` is keyed by the runtime message id of the prompt that started each turn: `{served_models, fallback_from, billed_cost}`.',
      ...auth,
      request: { params: z.object({ workspaceId: z.string(), sessionId: z.string() }) },
      responses: { 200: json(AnyObject, 'Session model usage'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      const binding = await resolveSessionBinding(c, projectId, sessionId, 'read');
      if (binding.kind === 'error') return binding.response as never;
      const { loaded } = binding;
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
      const visible = await loadVisibleSession(loaded, sessionId, c.get('sessionId') ?? null, callerKortixSessionId(c));
      if (!visible || sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);
      return c.json(await sessionModelUsage(visible.row));
    },
  );

  // GET /v1/projects/:projectId/sessions/:sessionId/usage
  // What the session and every session it started cost, in USD, from the
  // gateway's request ledger and the compute ledger. A sub-agent in the session's sandbox bills under
  // the session's id; a session it started has its own row and its own id.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/sessions/{sessionId}/usage',
      tags: ['sessions'],
      summary: 'Read what a session and the sessions it started cost',
      description:
        'Returns the model usage of the session and of every descendant session (`parent_session_id`, up to 10 levels and 500 sessions) the caller may open, from the gateway request ledger. Each entry of `sessions` carries `cost` in USD (`kortix_cost`, debited from the Kortix wallet, plus `provider_cost`, paid to the account\'s own provider key), request and token counts. `compute_cost` is what the session\'s boxes cost while they were up (`sandbox_compute_sessions`), and `billed_cost` is everything Kortix debited for the session: `kortix_cost + compute_cost`. `sessions` lists the session first, then its descendants depth-first, oldest child first. `total` is the sum over `sessions`. `hidden_sessions` counts descendants the caller may not open; a hidden session hides its subtree, and none of it is in `total`. `truncated` is true when the walk stopped at a limit. A sub-agent inside the session\'s sandbox bills under the session\'s own id, so its cost is in the session\'s entry.',
      ...auth,
      request: { params: z.object({ workspaceId: z.string(), sessionId: z.string() }) },
      responses: { 200: json(SessionUsageTreeSchema, 'Session usage'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);
      const binding = await resolveSessionBinding(c, projectId, sessionId, 'read');
      if (binding.kind === 'error') return binding.response as never;
      const { loaded } = binding;
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);
      const callerSessionId = c.get('sessionId') ?? null;
      const boundSessionId = callerKortixSessionId(c);
      const visible = await loadVisibleSession(loaded, sessionId, callerSessionId, boundSessionId);
      if (!visible || sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);
      const usage = await sessionUsageTree(visible.row, async (ids) => {
        const access = await loadVisibleSessionsForList(loaded, ids, callerSessionId, boundSessionId);
        return new Map([...access].filter(([, a]) => !sessionIsTombstoned(a.row)).map(([id, a]) => [id, a.row]));
      });
      return c.json(usage, 200);
    },
  );
}
