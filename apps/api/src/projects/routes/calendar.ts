/**
 * Calendar: `/v1/workspaces/:workspaceId/calendar/*`, legacy
 * `/v1/projects/:workspaceId/calendar/*` (project flag `calendar`).
 *
 * The routes derive the caller from the credential and hand plain values to
 * `projects/calendar/service.ts`, which owns every rule. A session credential
 * is its agent; a browser login or a PAT not bound to a session is a person.
 * No body field names the author. Anyone who can open the workspace
 * (`project.read`) reads and writes its calendar.
 *
 * Wire contract: @kortix/api-contract calendar.ts. Errors: `404
 * calendar_not_found`, `422 calendar_invalid` (with `violations`). Flag off:
 * `403 feature_disabled`.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  CalendarCommentResponseSchema,
  CalendarErrorSchema,
  CalendarItemDetailResponseSchema,
  CalendarItemResponseSchema,
  CalendarListResponseSchema,
  CalendarPeopleResponseSchema,
  CreateCalendarCommentRequestSchema,
  CreateCalendarItemRequestSchema,
  UpdateCalendarItemRequestSchema,
} from '@kortix/api-contract';
import type { Context } from 'hono';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { getRequestOnBehalfOf } from '../../middleware/on-behalf-of';
import { auth, errors, json, lenientBody, queryText } from '../../openapi';
import { workspaceIdParam } from '../../shared/route-params';
import { isUuid } from '../../shared/validate';
import type { AppEnv } from '../../types';
import * as calendar from '../calendar/service';
import { sessionAgentName } from '../calendar/store';
import { projectsApp } from '../lib/app';
import { loadProjectForUser } from '../lib/http-project-access';

type C = Context<AppEnv>;
const projectParams = z.object({ workspaceId: z.string() });
const itemParams = projectParams.extend({ itemId: z.string() });
const CALENDAR_ERRORS = {
  403: json(CalendarErrorSchema, 'feature_disabled'),
  404: json(CalendarErrorSchema, 'calendar_not_found'),
  422: json(CalendarErrorSchema, 'calendar_invalid, with violations'),
};

/** The project, the flag gate and who calls. A Response when the request ends here. */
async function scopeOf(c: C): Promise<calendar.CalendarContext | Response> {
  const projectId = workspaceIdParam(c) ?? '';
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'calendar_not_found' as const, message: 'Not found.' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'calendar');
  if (gate) return gate;
  const bound = callerKortixSessionId(c);
  const sessionId = isProjectSessionPrincipal(c) && bound ? bound : null;
  const agent = sessionId ? await sessionAgentName(loaded.row.projectId, sessionId) : null;
  const actor: calendar.CalendarActor = sessionId && agent
    ? { kind: 'agent', agent, sessionId, userId: getRequestOnBehalfOf(c) ?? null }
    : { kind: 'person', userId: loaded.userId };
  return { project: loaded.row, actor };
}

async function parseBody<T>(c: C, schema: z.ZodType<T>): Promise<T | Response> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return c.json(
    {
      error: 'calendar_invalid' as const,
      message: 'The request body is invalid.',
      violations: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    },
    422,
  );
}

function itemIdOf(c: C): string | null {
  const itemId = c.req.param('itemId') ?? '';
  return isUuid(itemId) ? itemId : null;
}

const missing = (c: C) => c.json({ error: 'calendar_not_found' as const, message: 'Calendar item not found.' }, 404);

function failure(c: C, error: unknown): Response {
  if (error instanceof calendar.CalendarError) {
    return c.json({ error: error.code, message: error.message, ...(error.violations ? { violations: error.violations } : {}) }, error.status);
  }
  throw error;
}

/** The typed-response check cannot follow a shared helper's Response, so it is skipped here. */
function handler(fn: (c: C) => Promise<Response>): never {
  return fn as never;
}

export function registerCalendarRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/calendar',
      tags: ['calendar'],
      summary: 'List calendar items',
      description:
        'Items dated in `[from, to)` in time order (at most 500, a window of at most 93 days), then open items with no date ' +
        '(newest first, at most 200) unless `undated=false`. `assignee`: `me`, `user:<id>` or `agent:<name>`. Flag `calendar`.',
      ...auth,
      request: {
        params: projectParams,
        query: z.object({
          from: queryText('ISO time: the first instant of the window.'),
          to: queryText('ISO time: the end of the window (exclusive).'),
          undated: queryText('`false` leaves out the items with no date.'),
          status: queryText('`open` or `done`.'),
          assignee: queryText('`me`, `user:<id>` or `agent:<name>`.'),
        }),
      },
      responses: { 200: json(CalendarListResponseSchema, 'The items'), ...errors(401), ...CALENDAR_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const status = c.req.query('status');
      if (status && status !== 'open' && status !== 'done') return failure(c, new calendar.CalendarError('calendar_invalid', 'status: open or done.', 422, ['status: open or done.']));
      try {
        const items = await calendar.listItems(scope, {
          from: c.req.query('from') || undefined,
          to: c.req.query('to') || undefined,
          undated: c.req.query('undated') !== 'false',
          status: (status as 'open' | 'done' | undefined) || undefined,
          assignee: c.req.query('assignee') || undefined,
        });
        return c.json({ items }, 200);
      } catch (error) {
        return failure(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/calendar',
      tags: ['calendar'],
      summary: 'Create a calendar item',
      description:
        'The caller is the author. `assignee`: `{ user_id }`, `{ email }`, `{ agent }`, `{ me: true }` or null. ' +
        'A person assigned or @mentioned in the notes by someone else gets a `mention` notification. Flag `calendar`.',
      ...auth,
      request: { params: projectParams, body: { content: { 'application/json': { schema: lenientBody(CreateCalendarItemRequestSchema.shape) } } } },
      responses: { 201: json(CalendarItemResponseSchema, 'The item'), ...errors(401), ...CALENDAR_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const body = await parseBody(c, CreateCalendarItemRequestSchema);
      if (body instanceof Response) return body;
      try {
        return c.json({ item: await calendar.createItem(scope, body) }, 201);
      } catch (error) {
        return failure(c, error);
      }
    }),
  );

  // Before `/{itemId}`: `people` is not an item id.
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/calendar/people',
      tags: ['calendar'],
      summary: 'List who can be assigned or mentioned',
      description: 'The people of the workspace with the `@handle` that names each one, and the agents by kortix.yaml name. Flag `calendar`.',
      ...auth,
      request: { params: projectParams },
      responses: { 200: json(CalendarPeopleResponseSchema, 'People and agents'), ...errors(401), ...CALENDAR_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      return c.json(await calendar.listPeople(scope.project), 200);
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/calendar/{itemId}',
      tags: ['calendar'],
      summary: 'Read a calendar item and its comments',
      description: 'The item and its comments, oldest first (at most 500). Flag `calendar`.',
      ...auth,
      request: { params: itemParams },
      responses: { 200: json(CalendarItemDetailResponseSchema, 'The item and its comments'), ...errors(401), ...CALENDAR_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const itemId = itemIdOf(c);
      if (!itemId) return missing(c);
      try {
        return c.json(await calendar.getItem(scope, itemId), 200);
      } catch (error) {
        return failure(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path: '/{workspaceId}/calendar/{itemId}',
      tags: ['calendar'],
      summary: 'Change a calendar item',
      description:
        'Only the fields sent change. `starts_at: null` removes the date; `assignee: null` the owner. ' +
        'A newly assigned person and people newly @mentioned in the notes get a `mention` notification. ' +
        'A person who marks an item an agent session created done or open again wakes that session. Flag `calendar`.',
      ...auth,
      request: { params: itemParams, body: { content: { 'application/json': { schema: lenientBody(UpdateCalendarItemRequestSchema.shape) } } } },
      responses: { 200: json(CalendarItemResponseSchema, 'The item'), ...errors(401), ...CALENDAR_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const itemId = itemIdOf(c);
      if (!itemId) return missing(c);
      const body = await parseBody(c, UpdateCalendarItemRequestSchema);
      if (body instanceof Response) return body;
      try {
        return c.json({ item: await calendar.updateItem(scope, itemId, body) }, 200);
      } catch (error) {
        return failure(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'delete',
      path: '/{workspaceId}/calendar/{itemId}',
      tags: ['calendar'],
      summary: 'Delete a calendar item',
      description: 'Deletes the item and its comments. Flag `calendar`.',
      ...auth,
      request: { params: itemParams },
      responses: { 200: json(z.object({ deleted: z.literal(true) }), 'Deleted'), ...errors(401), ...CALENDAR_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const itemId = itemIdOf(c);
      if (!itemId) return missing(c);
      try {
        await calendar.deleteItem(scope, itemId);
        return c.json({ deleted: true as const }, 200);
      } catch (error) {
        return failure(c, error);
      }
    }),
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/calendar/{itemId}/comments',
      tags: ['calendar'],
      summary: 'Comment on a calendar item',
      description:
        'The caller is the author. People @mentioned by someone else get a `mention` notification. ' +
        'A person\'s comment on an item an agent session created is delivered into that session when the person may prompt it. Flag `calendar`.',
      ...auth,
      request: { params: itemParams, body: { content: { 'application/json': { schema: lenientBody(CreateCalendarCommentRequestSchema.shape) } } } },
      responses: { 201: json(CalendarCommentResponseSchema, 'The comment'), ...errors(401), ...CALENDAR_ERRORS },
    }),
    handler(async (c) => {
      const scope = await scopeOf(c);
      if (scope instanceof Response) return scope;
      const itemId = itemIdOf(c);
      if (!itemId) return missing(c);
      const body = await parseBody(c, CreateCalendarCommentRequestSchema);
      if (body instanceof Response) return body;
      try {
        return c.json({ comment: await calendar.addComment(scope, itemId, body.body) }, 201);
      } catch (error) {
        return failure(c, error);
      }
    }),
  );
}
