/**
 * Website logins for the sandbox browser (projects/lib/browser-logins.ts).
 *
 *   GET  /v1/projects/:id/browser-logins          names and sites, never values
 *   POST /v1/projects/:id/browser-logins/resolve  one login for one URL
 *
 * Resolve answers only a session token: the sandbox's agent-browser credential
 * plugin (`kortix secrets browser-plugin`) calls it, and the value goes from
 * the response straight into the page. A person's own token gets 403.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, lenientBody } from '../../openapi';
import { TokenBucketRateLimiter } from '../../shared/rate-limit';
import { enforceRateLimit } from '../../middleware/rate-limit';
import { RATE_LIMIT_EXCEEDED_ACTION } from '../../shared/rate-limit-audit';
import { readJsonObject } from '../../shared/http-body';
import { workspaceIdParam } from '../../shared/route-params';
import { isProjectSessionPrincipal } from '../../middleware/agent-scope';
import { loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { listBrowserLogins, resolveBrowserLogin } from '../lib/browser-logins';
import { normalizeString } from '../lib/serializers';

// replica-local: limit × API replicas (shared/rate-limit.ts). Stops a looping
// agent from spending one login hundreds of times a minute.
const browserLoginResolveLimiter = new TokenBucketRateLimiter('browser_login_resolve');

const LoginListingSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      sites: z.array(z.string()),
      available: z.boolean(),
      fix: z.string().optional(),
    }),
  ),
});

/**
 * The Kortix session a request acts for, or null. A person's Supabase JWT also
 * sets `sessionId`, to its AUTH session id: only a project session principal
 * (a session-bound token) names a Kortix session.
 */
function kortixSessionOf(c: Parameters<typeof isProjectSessionPrincipal>[0]): string | null {
  if (!isProjectSessionPrincipal(c)) return null;
  return (c.get('sessionId') as string | undefined) ?? null;
}

const ResolvedLoginSchema = z.object({
  name: z.string(),
  username: z.string(),
  password: z.string(),
  url: z.string(),
});

export function registerBrowserLoginsRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/browser-logins',
      tags: ['secrets'],
      summary: 'List website logins',
      description:
        'List the website logins the caller can use: names and sites, never usernames or passwords. In a session, `available` says whether its agent may use each one.',
      ...auth,
      request: { params: z.object({ workspaceId: z.string() }) },
      responses: { 200: json(LoginListingSchema, 'Website logins'), ...errors(404) },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const items = await listBrowserLogins({
        projectId,
        accountId: loaded.row.accountId,
        sessionId: kortixSessionOf(c),
        actorUserId: loaded.userId ?? null,
      });
      return c.json({ items });
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/browser-logins/resolve',
      tags: ['secrets'],
      summary: 'Hand a website login to the sandbox browser',
      description:
        'Return one website login for one URL to the sandbox browser of the calling session. Session tokens only. The URL host must be one of the login\'s sites, the session agent\'s secrets grant must include the login, and the login must be shared with the session\'s person. Every use is audited.',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string() }),
        body: {
          content: {
            'application/json': {
              schema: lenientBody({
                name: z.string().openapi({ description: 'The login name, e.g. CRM_LOGIN.' }),
                url: z.string().optional().openapi({ description: 'The sign-in page the browser will type into.' }),
              }),
            },
          },
        },
      },
      responses: {
        200: json(ResolvedLoginSchema, 'The login'),
        ...errors(400, 403, 404, 409, 429, 503),
      },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c);
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const sessionId = kortixSessionOf(c);
      if (!sessionId) {
        return c.json(
          {
            error: 'Only an agent session can use a website login. It is typed by that session\'s browser.',
            code: 'login_session_only',
          },
          403,
        );
      }
      const denied = await enforceRateLimit(c, browserLoginResolveLimiter, sessionId, { limit: 20, windowMs: 60_000 }, {
        action: RATE_LIMIT_EXCEEDED_ACTION,
        resourceType: 'browser_login',
        resourceId: sessionId,
        metadata: { limiter: 'browser_login_resolve' },
      });
      // A plain 429 Response, outside the typed route contract.
      if (denied) return denied as never;

      const body = await readJsonObject(c);
      const name = normalizeString(body.name);
      if (!name) return c.json({ error: 'name is required', code: 'login_name_invalid' }, 400);
      const result = await resolveBrowserLogin({
        projectId,
        accountId: loaded.row.accountId,
        sessionId,
        actorUserId: loaded.userId ?? null,
        name,
        url: normalizeString(body.url) ?? null,
      });
      c.header('Cache-Control', 'no-store');
      if (!result.ok) return c.json({ error: result.error, code: result.code }, result.status);
      return c.json({ name: result.name, username: result.username, password: result.password, url: result.url });
    },
  );
}
