// GET/POST /v1/projects/:projectId/workspace-cache — the project's saved
// workspaces on Platinum (flag `platinum_cache`). With the flag on, every new
// session's /workspace starts as a copy of the newest one
// (platform/services/workspace-volume.ts). A save turns one prepared session's
// /workspace into that starting point, so only a person with project settings
// rights may save, never a session token.
import { createRoute, z } from '@hono/zod-openapi';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { auth, errors, json } from '../../openapi';
import { resolveSessionPlacement } from '../../platform/services/sandbox-region';
import {
  listWorkspaceCache,
  saveWorkspaceCache,
  WorkspaceCacheError,
} from '../../platform/services/workspace-volume';
import { workspaceIdParam } from '../../shared/route-params';
import { assertProjectCapability, loadProjectForUser, loadVisibleSession, sessionIsTombstoned } from '../lib/access';
import { projectsApp } from '../lib/app';
import { recordWorkspaceCacheBuilder, startWorkspaceCacheBuildNow } from '../workspace-cache/builder';

const EntrySchema = z.object({
  id: z.string(),
  key: z.string(),
  size_bytes: z.number().nullable(),
  file_count: z.number().nullable(),
  hits: z.number(),
  created_at: z.string().nullable(),
  last_hit_at: z.string().nullable(),
  expires_at: z.string().nullable(),
});
const ListSchema = z.object({
  namespace: z.string(),
  entries: z.array(EntrySchema),
  used_bytes: z.number().nullable(),
  max_bytes: z.number().nullable(),
});
const SaveInputSchema = z.object({
  /** The session whose /workspace becomes the cache. It must have a /workspace volume. */
  session_id: z.string().min(1).max(64),
  /** `ws-` plus what identifies the content, such as the lockfile hash. Keys are immutable. */
  key: z.string().min(4).max(123),
});
const SaveSchema = z.object({ entry: EntrySchema, evicted: z.array(z.string()), commit_id: z.string().nullable() });
const params = z.object({ workspaceId: z.string() });

export function registerWorkspaceCacheRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/workspace-cache',
      tags: ['sessions'],
      summary: 'List the project’s saved workspaces',
      description:
        'The workspaces new sessions start from, newest first, in the project’s session region, with the Platinum budget they share. ' +
        'Any project member may read it. Flag `platinum_cache`.',
      ...auth,
      request: { params },
      responses: { 200: json(ListSchema, 'The saved workspaces'), ...errors(400, 403, 404, 409, 413, 502) },
    }),
    async (c) => {
      const loaded = await loadProjectForUser(c, workspaceIdParam(c)!, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'platinum_cache');
      if (gate) return gate;
      const placement = await resolveSessionPlacement(loaded.row.projectId, loaded.row.metadata);
      try {
        return c.json(await listWorkspaceCache(loaded.row.projectId, placement.location ?? null), 200);
      } catch (err) {
        if (err instanceof WorkspaceCacheError) {
          return c.json({ error: err.message, code: err.code }, err.status);
        }
        throw err;
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/workspace-cache',
      tags: ['sessions'],
      summary: 'Save a session’s /workspace as the project’s workspace cache',
      description:
        'Commits the session’s /workspace volume and saves that commit under `key` (`ws-…`, immutable): every new session of the project then ' +
        'starts with a copy of it, and a daily rebuild runs the project\'s `scripts/workspace-cache-build` in a session of the same agent, as you. ' +
        'Save only a workspace prepared for that: whatever it holds, every later session gets, so never one with ' +
        'secrets in it. Needs project settings rights, and a person: a session token gets 403 `forbidden`. A key already saved is 409 ' +
        '`cache_key_exists`; a workspace over the budget is 413 `cache_too_large`. Flag `platinum_cache`.',
      ...auth,
      request: { params, body: { required: true, content: { 'application/json': { schema: SaveInputSchema } } } },
      responses: { 201: json(SaveSchema, 'The saved entry'), ...errors(400, 403, 404, 409, 413, 502) },
    }),
    async (c) => {
      const loaded = await loadProjectForUser(c, workspaceIdParam(c)!, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, loaded.row.projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);
      assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'platinum_cache');
      if (gate) return gate;
      // A session could otherwise decide what every later session of the project starts with.
      if (callerKortixSessionId(c) !== null) {
        return c.json({ error: 'A person saves the workspace cache, not a session.', code: 'forbidden' }, 403);
      }
      const input = c.req.valid('json');
      const visible = await loadVisibleSession(loaded, input.session_id, null, null);
      if (!visible || sessionIsTombstoned(visible.row)) return c.json({ error: 'Session not found', code: 'session_not_found' }, 404);
      try {
        const saved = await saveWorkspaceCache({
          projectId: loaded.row.projectId,
          sessionId: input.session_id,
          sessionMetadata: visible.row.metadata,
          key: input.key,
        });
        // The daily rebuild (workspace-cache/builder.ts) builds the same way: this session's agent, as this person.
        await recordWorkspaceCacheBuilder(loaded.row.projectId, {
          agent: visible.row.agentName,
          user_id: loaded.userId,
          named_at: new Date().toISOString(),
        });
        return c.json(saved, 201);
      } catch (err) {
        if (err instanceof WorkspaceCacheError) {
          return c.json({ error: err.message, code: err.code }, err.status);
        }
        throw err;
      }
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/workspace-cache/build',
      tags: ['sessions'],
      summary: 'Rebuild the project’s workspace cache now',
      description:
        'Starts the daily rebuild now: a session of the agent recorded by the last save by a person, as that person, that runs the ' +
        'project’s `scripts/workspace-cache-build` and saves the result. 409 `no_builder` until a person has saved once, 409 ' +
        '`build_running` while one runs. Needs project settings rights, and a person. Flag `platinum_cache`.',
      ...auth,
      request: { params },
      responses: { 202: json(z.object({ session_id: z.string() }), 'The build session'), ...errors(403, 404, 409, 502) },
    }),
    async (c) => {
      const loaded = await loadProjectForUser(c, workspaceIdParam(c)!, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, loaded.row.projectId, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);
      assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'platinum_cache');
      if (gate) return gate;
      if (callerKortixSessionId(c) !== null) {
        return c.json({ error: 'A person starts a workspace cache build, not a session.', code: 'forbidden' }, 403);
      }
      const started = await startWorkspaceCacheBuildNow(loaded.row);
      if ('session_id' in started) return c.json(started, 202);
      const messages = {
        no_builder: 'Save a prepared session as the workspace cache once first: the build repeats it.',
        build_running: 'A workspace cache build is already running.',
        not_started: 'The build session could not start. Try again in a minute.',
      } as const;
      return c.json({ error: messages[started.error], code: started.error }, started.error === 'not_started' ? 502 : 409);
    },
  );
}
