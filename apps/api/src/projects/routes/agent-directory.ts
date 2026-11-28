// GET /v1/workspaces/:workspaceId/agent-directory — the workspace's agents the
// caller can message (flag `channels`). An entry is an agent from kortix.yaml;
// its chat is the caller's DM space with it, opened through `POST /spaces/dm`
// (lib/agent-directory.ts).
import { createRoute, z } from '@hono/zod-openapi';
import { AgentDirectorySchema, AgentPauseInputSchema, AgentPauseResultSchema } from '@kortix/api-contract';
import { PROJECT_ACTIONS } from '../../iam';
import { requireFeatureFlag } from '../../feature-flags/gate';
import { auth, errors, json } from '../../openapi';
import { workspaceIdParam } from '../../shared/route-params';
import { loadProjectAgents } from '../agents';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { agentDirectoryFromAgents, dmSpacesByAgent, pausedAgents, setAgentPaused, stopAgentRuns } from '../lib/agent-directory';

export function registerAgentDirectoryRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/agent-directory',
      tags: ['agents'],
      summary: 'List the agents the caller can message',
      description:
        'The workspace\'s agents a person can message: every agent in kortix.yaml except `mode: subagent` ones, and My Kortix when ' +
        'the workspace runs it. `chat_space_id` is the caller\'s chat with the agent, null until they open it with `POST /spaces/dm`. Flag `channels`.',
      ...auth,
      request: { params: z.object({ workspaceId: z.string() }) },
      responses: { 200: json(AgentDirectorySchema, 'The agents'), ...errors(403, 404) },
    }),
    async (c) => {
      const loaded = await loadProjectForUser(c, workspaceIdParam(c)!, 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'channels');
      if (gate) return gate;
      const [agents, dms] = await Promise.all([
        loadProjectAgents(loaded.row, { forceRefresh: 'tip-proof' }),
        dmSpacesByAgent(loaded.row.projectId, loaded.userId),
      ]);
      return c.json({ agents: agentDirectoryFromAgents(agents, dms, pausedAgents(loaded.row.metadata)) }, 200);
    },
  );

  projectsApp.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/agent-directory/{name}/pause',
      tags: ['agents'],
      summary: 'Pause or resume an agent',
      description:
        'Body `{ paused }`. A paused agent still gets messages, but no schedule, webhook, event or monitor starts it: an automatic trigger fire of the agent ' +
        'is skipped with reason `agent <name> is paused`. A person firing a trigger by hand still runs it. Pausing also stops every running task of the agent, for every person ' +
        '(`stopped_sessions` counts them). Needs the trigger-update permission. Flag `channels`.',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), name: z.string() }),
        body: { required: true, content: { 'application/json': { schema: AgentPauseInputSchema } } },
      },
      responses: { 200: json(AgentPauseResultSchema, 'The agent after the change'), ...errors(400, 403, 404) },
    }),
    async (c) => {
      const projectId = workspaceIdParam(c)!;
      const loaded = await loadProjectForUser(c, projectId, 'session');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      const gate = requireFeatureFlag(c, loaded.row.metadata, 'channels');
      if (gate) return gate;
      await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE);
      const name = c.req.param('name');
      const agents = await loadProjectAgents(loaded.row, { forceRefresh: 'tip-proof' });
      const known = agentDirectoryFromAgents(agents, new Map()).some((entry) => entry.name === name);
      if (!known) return c.json({ error: `No agent "${name}" in this workspace.`, code: 'agent_not_found' }, 404);
      const { paused } = c.req.valid('json');
      const metadata = await setAgentPaused(projectId, name, paused);
      if (metadata === null) return c.json({ error: 'Not found' }, 404);
      // Written first: a trigger that fires while the tasks stop is already held.
      const stopped = paused ? await stopAgentRuns(projectId, name, loaded.userId) : 0;
      const dms = await dmSpacesByAgent(projectId, loaded.userId);
      const agent = agentDirectoryFromAgents(agents, dms, pausedAgents(metadata)).find((entry) => entry.name === name)!;
      return c.json({ agent, stopped_sessions: stopped }, 200);
    },
  );
}
