/**
 * Guided-setup milestones from the CLI. Maps to spec §33 (FB-2). The route
 * checks each event against a closed schema and sends it to product
 * analytics as the person; nothing is stored, so the contract is the status
 * code, the receipt and the refusals. A session's own token counts only when a
 * person started the session (the API reports it as that person).
 */
import { flow } from '../core/flow';
import type { FlowContext } from '../core/types';
import { bindDatabaseSessionCredential, createDatabaseSession } from '../fixtures/database-project';

const SETUP_ID = '4b8f2f8e-6d0c-4d55-9a57-2f1c7d1b9a10';
const COMMON = { setup_id: SETUP_ID, agent: 'claude_code', cli_version: '0.15.12-dev.test' };

const EVENTS = [
  { event: 'setup_started', ...COMMON, properties: { has_workspace: false, has_manifest: false } },
  { event: 'setup_template_added', ...COMMON, properties: { template: 'software-factory' } },
  {
    event: 'setup_onboard_run',
    ...COMMON,
    properties: {
      project_id: null,
      exit_code: 4,
      wait: true,
      waited_s: 95,
      duration_s: 140,
      steps_left: 1,
      connectors: 1,
      secrets: 2,
      sandbox_templates: 1,
      slack: true,
      phases: { validate: 'done', ship: 'done', slack: 'waiting_on_person', sandbox: 'skipped' },
    },
  },
  { event: 'setup_ready', ...COMMON, properties: { project_id: null, via: 'doctor', minutes_since_start: 12.5 } },
];

const CLI_TOKEN = '/v1/workspaces/:projectId/cli-token';

/** A session of a fresh workspace and a CLI token bound to it: what the session's agent holds as KORTIX_TOKEN. */
async function sessionCredential(ctx: FlowContext, initiator: 'member' | 'trigger') {
  const team = await ctx.fixtures.team();
  const project = await team.project();
  const sessionId = await createDatabaseSession(ctx.env, {
    projectId: project.id,
    accountId: team.id,
    userId: ctx.P.OWNER.userId!,
    initiator: { type: initiator, id: initiator === 'member' ? ctx.P.OWNER.userId! : 'nightly-report' },
  });
  ctx.track('session', sessionId, { projectId: project.id });
  const minted = await ctx.client
    .as(ctx.P.OWNER)
    .post(CLI_TOKEN, { name: ctx.fixtures.name('setup-ev') }, { params: { projectId: project.id } });
  minted.status(201);
  const token = minted.json<{ token_id: string; secret_key: string }>();
  await bindDatabaseSessionCredential(ctx.env, {
    tokenId: token.token_id,
    commandId: crypto.randomUUID(),
    sessionId,
    accountId: team.id,
    projectId: project.id,
  });
  return {
    client: ctx.client.withBearer(token.secret_key, `${initiator} session credential`),
    drop: () =>
      ctx.client
        .as(ctx.P.OWNER)
        .del(`${CLI_TOKEN}/:tokenId`, { params: { projectId: project.id, tokenId: token.token_id } })
        .catch(() => {}),
  };
}

flow(
  'FB-2',
  {
    domain: 'feedback',
    requires: ['database'],
    routes: [
      'POST /v1/cli/setup-events',
      'POST /v1/workspaces/:projectId/cli-token',
      'DELETE /v1/workspaces/:projectId/cli-token/:tokenId',
    ],
  },
  async (ctx) => {
    await ctx.step('ANON cannot report a setup milestone → 401', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/cli/setup-events', EVENTS[0]);
      r.status(401);
    });

    await ctx.step('a person reports each of the four milestones → 202 accepted', async () => {
      for (const body of EVENTS) {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/cli/setup-events', body);
        r.status(202).body().has('$.accepted', true);
      }
    });

    await ctx.step('a body outside the closed schema is rejected → 400 for each', async () => {
      const bad = [
        { ...EVENTS[0], event: 'setup_finished' },
        { ...EVENTS[0], setup_id: 'not-a-uuid' },
        { ...EVENTS[0], agent: 'my-own-bot' },
        { ...EVENTS[0], cli_version: 'v 1/2' },
        { ...EVENTS[0], properties: { has_workspace: false, has_manifest: false, repo: 'acme/shop' } },
        { ...EVENTS[1], properties: { template: 'Acme Template' } },
        { ...EVENTS[2], properties: { ...EVENTS[2]!.properties, phases: { deploy: 'done' } } },
        { ...EVENTS[3], properties: { project_id: null, via: 'cron', minutes_since_start: 1 } },
      ];
      for (const body of bad) {
        const r = await ctx.client.as(ctx.P.OWNER).post('/v1/cli/setup-events', body);
        r.status(400);
      }
    });

    await ctx.step("a session a person started reports through the session's own token → 202 accepted, for each milestone", async () => {
      const session = await sessionCredential(ctx, 'member');
      try {
        for (const body of EVENTS) {
          const r = await session.client.post('/v1/cli/setup-events', { ...body, agent: 'kortix' });
          r.status(202).body().has('$.accepted', true);
        }
      } finally {
        await session.drop();
      }
    });

    await ctx.step("a session a trigger started → 202 accepted false: nothing is sent, the CLI is not failed", async () => {
      const session = await sessionCredential(ctx, 'trigger');
      try {
        const r = await session.client.post('/v1/cli/setup-events', { ...EVENTS[0], agent: 'kortix' });
        r.status(202).body().has('$.accepted', false);
      } finally {
        await session.drop();
      }
    });

    await ctx.step('a workspace key bound to no session is refused by the credential fence → 403', async () => {
      const project = await ctx.fixtures.project();
      const minted = await ctx.client
        .as(ctx.P.OWNER)
        .post('/v1/workspaces/:projectId/cli-token', { name: ctx.fixtures.name('setup-ev') }, { params: { projectId: project.id } });
      minted.status(201);
      const secret = minted.json<{ secret_key: string }>().secret_key;
      const r = await ctx.client
        .as({ ...ctx.P.OWNER, label: 'FB2_PROJECT_TOKEN', auth: { mode: 'bearer', token: secret } })
        .post('/v1/cli/setup-events', EVENTS[0]);
      r.status(403);
    });

    await ctx.step('a flood is rate limited per person → 429 with Retry-After; another person still passes', async () => {
      // 20/min per user per API process (replica-local): flood until one process refuses.
      let limited = false;
      for (let i = 0; i < 200 && !limited; i += 1) {
        const r = await ctx.client.as(ctx.P.NONMEMBER).post('/v1/cli/setup-events', EVENTS[3]);
        if (r.statusCode === 429) {
          limited = true;
          r.status(429);
          if (!r.header('retry-after')) throw new Error('429 without Retry-After');
        } else {
          r.status(202);
        }
      }
      if (!limited) throw new Error('no flood ever hit the setup-event rate limit');
      const other = await ctx.client.as(ctx.P.OWNER).post('/v1/cli/setup-events', EVENTS[0]);
      other.status(202).body().has('$.accepted', true);
    });
  },
);
