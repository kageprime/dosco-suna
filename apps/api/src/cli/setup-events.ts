// POST /v1/cli/setup-events: the milestones of a guided setup (/setup.md), as
// the CLI reaches them. The API checks each one against a closed list and
// sends it to PostHog as the person behind the credential
// (shared/product-analytics.ts). Nothing is stored here.
//
// - A person only. A browser sign-in or a personal CLI token reports as its
//   person. A session's own token (the agent runs `kortix plan` in its
//   sandbox) reports as the person who started the session, with agent
//   `kortix`; a session that no person started (a trigger, a channel, the
//   API, the system) gets `202 {accepted: false}`, as do an API key, a
//   service account and an OAuth app: automation is not a setup.
// - Telemetry never fails the CLI: a refused event is still `202`, only a
//   malformed body is `400`. The CLI sends with a short timeout and ignores
//   the answer.
// - Rate limited per user (createSetupEventRateLimitMiddleware): a setup run
//   sends about ten events, and every one counts against the PostHog plan.
import { createRoute, z } from '@hono/zod-openapi';
import { projectSessions } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { supabaseAuth } from '../middleware/auth';
import { analyticsSource } from '../middleware/analytics-source';
import { callerKortixSessionId } from '../middleware/caller-session';
import { createSetupEventRateLimitMiddleware } from '../middleware/rate-limit';
import { db } from '../shared/db';
import {
  captureProductEvent,
  type ProductEvent,
  type ProductEventProperties,
} from '../shared/product-analytics';

/** The coding agents the CLI recognizes from their environment variables. */
export const SETUP_AGENTS = [
  'claude_code',
  'codex',
  'cursor',
  'gemini',
  'opencode',
  'copilot',
  'kortix',
  'other',
  'none',
] as const;

/** How each phase of `kortix onboard` (apps/cli/src/onboarding/phases.ts) ended. */
const PHASE_STATUSES = ['done', 'skipped', 'waiting_on_person', 'failed'] as const;

const count = z.number().int().min(0).max(10_000);

/** Each phase the run reached, with its status. A run that stopped early names fewer phases. */
const phase = z.enum(PHASE_STATUSES).optional();
const PhasesSchema = z
  .object({ validate: phase, ship: phase, secrets: phase, webhooks: phase, slack: phase, connectors: phase, sandbox: phase, doctor: phase })
  .strict();

const Common = {
  /** One guided setup: the CLI keeps it for 24 hours after the last event. */
  setup_id: z.string().uuid(),
  agent: z.enum(SETUP_AGENTS),
  cli_version: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/),
};

const SetupEventBodySchema = z
  .discriminatedUnion('event', [
    z
      .object({
        event: z.literal('setup_started'),
        ...Common,
        properties: z.object({ has_workspace: z.boolean(), has_manifest: z.boolean() }).strict(),
      })
      .strict(),
    z
      .object({
        event: z.literal('setup_template_added'),
        ...Common,
        properties: z.object({ template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/) }).strict(),
      })
      .strict(),
    z
      .object({
        event: z.literal('setup_onboard_run'),
        ...Common,
        properties: z
          .object({
            project_id: z.string().uuid().nullable(),
            exit_code: z.number().int().min(0).max(255),
            wait: z.boolean(),
            waited_s: count,
            duration_s: count,
            steps_left: count,
            connectors: count,
            secrets: count,
            sandbox_templates: count,
            slack: z.boolean(),
            phases: PhasesSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        event: z.literal('setup_ready'),
        ...Common,
        properties: z
          .object({
            project_id: z.string().uuid().nullable(),
            via: z.enum(['onboard', 'doctor']),
            minutes_since_start: z.number().min(0).max(100_000),
          })
          .strict(),
      })
      .strict(),
  ])
  .openapi('SetupEventBody');

export type SetupEventBody = z.infer<typeof SetupEventBodySchema>;

const SetupEventReceiptSchema = z
  .object({ accepted: z.boolean().openapi({ description: 'False when the caller is not a person: nothing was sent.' }) })
  .openapi('SetupEventReceipt');

/**
 * The person who started a session of this workspace, or null when no person
 * did (`initiator_type` trigger, channel, api or system).
 */
async function sessionStarterOf(sessionId: string, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: projectSessions.createdBy, initiatorType: projectSessions.initiatorType })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, workspaceId)))
    .limit(1);
  return row?.initiatorType === 'member' ? (row.createdBy ?? null) : null;
}

/** The person a setup event counts for. `agent` overrides the CLI's guess when the API knows better. */
interface SetupPerson {
  userId: string;
  agent?: (typeof SETUP_AGENTS)[number];
}

/** The person behind the request, or null for automation. */
async function setupPersonOf(c: Context): Promise<SetupPerson | null> {
  const authType = c.get('authType') as string | undefined;
  if (authType !== 'supabase' && authType !== 'pat') return null;
  const sessionId = callerKortixSessionId(c);
  if (!sessionId) {
    const userId = c.get('userId') as string | undefined;
    return userId ? { userId } : null;
  }
  // A session's own token: the workspace fence let it through only because it
  // is session-bound (middleware/workspace-binding.ts).
  const workspaceId = c.get('tokenProjectId') as string | undefined;
  if (!workspaceId) return null;
  try {
    const starter = await sessionStarterOf(sessionId, workspaceId);
    return starter ? { userId: starter, agent: 'kortix' } : null;
  } catch {
    return null; // Telemetry never fails the CLI.
  }
}

/** One PostHog event per setup run for a milestone that a retry may repeat. */
function dedupeKeyOf(body: SetupEventBody): string | undefined {
  if (body.event === 'setup_started' || body.event === 'setup_ready') return body.setup_id;
  if (body.event === 'setup_template_added') return `${body.setup_id}:${body.properties.template}`;
  return undefined;
}

/** The flat PostHog properties: an onboard run's phases become `phase_<name>`. */
export function setupEventProperties(body: SetupEventBody): ProductEventProperties {
  const common = { setup_id: body.setup_id, agent: body.agent, cli_version: body.cli_version };
  if (body.event !== 'setup_onboard_run') return { ...common, ...body.properties };
  const { phases, ...rest } = body.properties;
  const flat: ProductEventProperties = { ...common, ...rest };
  for (const [name, status] of Object.entries(phases)) if (status) flat[`phase_${name}`] = status;
  return flat;
}

export interface CliSetupEventsDeps {
  authMiddleware?: MiddlewareHandler;
  rateLimitMiddleware?: MiddlewareHandler;
  capture?: typeof captureProductEvent;
}

export function createCliSetupEventsApp(deps: CliSetupEventsDeps = {}) {
  const capture = deps.capture ?? captureProductEvent;
  const app = makeOpenApiApp<AppEnv>();
  app.use('*', deps.authMiddleware ?? supabaseAuth);
  app.use('*', deps.rateLimitMiddleware ?? createSetupEventRateLimitMiddleware());

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['cli'],
      summary: 'Report a guided-setup milestone from the CLI',
      description:
        'One milestone of a /setup.md run (setup_started, setup_template_added, setup_onboard_run, setup_ready), ' +
        'sent to product analytics as the person behind the credential. Nothing is stored. ' +
        "A session's own token reports as the person who started the session, with agent `kortix`. " +
        'Automation (a session no person started, an API key, a service account, an OAuth app) is answered `accepted: false`.',
      ...auth,
      request: {
        body: { required: true, content: { 'application/json': { schema: SetupEventBodySchema } } },
      },
      responses: {
        202: json(SetupEventReceiptSchema, 'Accepted'),
        ...errors(400, 401, 429),
      },
    }),
    async (c) => {
      const body = c.req.valid('json') as SetupEventBody;
      const person = await setupPersonOf(c);
      if (!person) return c.json({ accepted: false }, 202);
      const properties = setupEventProperties(body);
      if (person.agent) properties.agent = person.agent;
      capture({
        userId: person.userId,
        accountId: (c.get('accountId') as string | undefined) ?? undefined,
        event: body.event satisfies ProductEvent,
        dedupeKey: dedupeKeyOf(body),
        properties: { ...properties, source: analyticsSource(c) },
      });
      return c.json({ accepted: true }, 202);
    },
  );

  return app;
}
