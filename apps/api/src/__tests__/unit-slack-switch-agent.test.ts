import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * "Switch agent" under an agent's answer opens the channel's agent picker in a
 * modal: the modal opens first, from the click's single-use trigger_id, and
 * then shows the agents or why it cannot. A click always shows something.
 * The picker's buttons answer inside the modal. Slack is faked at the API
 * module; the channel's selection and agents are faked at their modules.
 */

const calls: Array<{ fn: string; args: unknown[] }> = [];
let openResult: { viewId: string | null } | null = { viewId: 'V1' };
const realSlackApi = await import('../channels/slack-api');
mock.module('../channels/slack-api', () => ({
  ...realSlackApi,
  openModal: async (...args: unknown[]) => {
    calls.push({ fn: 'openModal', args });
    return openResult;
  },
  updateModal: async (...args: unknown[]) => {
    calls.push({ fn: 'updateModal', args });
    return true;
  },
}));
const realInstallStore = await import('../channels/install-store');
mock.module('../channels/install-store', () => ({
  ...realInstallStore,
  loadSlackTokenForProject: async () => 'xoxb-test',
}));
const realLink = await import('../channels/slack/link');
mock.module('../channels/slack/link', () => ({ ...realLink, linkedSlackProject: async () => 'proj-1' }));
let selection: Record<string, unknown> | null = { projectId: 'proj-1', agentName: null, sessionModel: null, conversationPolicy: null };
const realSelection = await import('../channels/slack/selection');
mock.module('../channels/slack/selection', () => ({ ...realSelection, currentChannelSelection: async () => selection }));
let agents: Array<{ name: string; description: string | null }> | Error = [{ name: 'session-reviewer', description: 'Reviews sessions' }];
const realPicker = await import('../channels/slack/agent-picker');
mock.module('../channels/slack/agent-picker', () => ({
  ...realPicker,
  loadScopedChannelAgents: async () => {
    if (agents instanceof Error) throw agents;
    return agents;
  },
}));
const changes: Array<string | null> = [];
const realSettings = await import('../channels/core/settings');
mock.module('../channels/core/settings', () => ({
  ...realSettings,
  changeChannelAgent: async (_user: unknown, _channel: unknown, requested: string | null) => {
    changes.push(requested);
    return { ok: true, agent: requested };
  },
}));

const { handleBlockAction } = await import('../channels/slack/interactivity');
afterAll(() => mock.restore());

beforeEach(() => {
  calls.length = 0;
  changes.length = 0;
  openResult = { viewId: 'V1' };
  selection = { projectId: 'proj-1', agentName: null, sessionModel: null, conversationPolicy: null };
  agents = [{ name: 'session-reviewer', description: 'Reviews sessions' }];
});

const click = (overrides: Record<string, unknown> = {}) =>
  handleBlockAction({
    type: 'block_actions',
    trigger_id: 'trigger-1',
    team: { id: 'T1' },
    user: { id: 'U1' },
    channel: { id: 'D0DM1' },
    response_url: 'https://hooks.slack.com/actions/T1/1/x',
    actions: [{ action_id: 'answer_switch_agent', value: 'D0DM1' }],
    ...overrides,
  } as any);

const texts = (view: any) => JSON.stringify(view.blocks);

describe('Switch agent', () => {
  test('opens a modal at once, then fills it with the channel picker', async () => {
    await click();
    expect(calls.map((c) => c.fn)).toEqual(['openModal', 'updateModal']);
    const [token, trigger, loading] = calls[0]!.args as [string, string, any];
    expect([token, trigger]).toEqual(['xoxb-test', 'trigger-1']);
    expect(texts(loading)).toContain('Loading agents');
    const [, viewId, picker] = calls[1]!.args as [string, string, any];
    expect(viewId).toBe('V1');
    expect(picker.title.text).toBe('Switch agent');
    expect(texts(picker)).toContain('New threads in this DM start with the agent you pick');
    const buttons = picker.blocks.filter((b: any) => b.accessory).map((b: any) => b.accessory.action_id);
    expect(buttons).toEqual(['set_agent_default', 'set_agent_session-reviewer']);
  });

  test('when the agents do not load, the modal says so instead of staying empty', async () => {
    agents = new Error('git unreachable');
    await click();
    expect(calls.map((c) => c.fn)).toEqual(['openModal', 'updateModal']);
    expect(texts(calls[1]!.args[2])).toContain('did not load');
  });

  test('when no Kortix workspace holds the Slack workspace, the modal says how to connect one', async () => {
    selection = null;
    await click();
    expect(texts(calls[1]!.args[2])).toContain('No Kortix workspace is connected to this Slack workspace');
  });

  test("a pick inside the modal changes the channel's agent and answers in the modal", async () => {
    await handleBlockAction({
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U1' },
      view: { id: 'V1', callback_id: 'switch_agent', private_metadata: 'D0DM1' },
      actions: [{ action_id: 'set_agent_session-reviewer', value: JSON.stringify({ c: 'D0DM1', a: 'session-reviewer' }) }],
    } as any);
    expect(changes).toEqual(['session-reviewer']);
    expect(calls.map((c) => c.fn)).toEqual(['updateModal']);
    expect(calls[0]!.args[1]).toBe('V1');
    expect(texts(calls[0]!.args[2])).toContain('✓');
  });

  test('a button that names another conversation than the one Slack signed changes nothing', async () => {
    // Clicked in C0HERE, but the button (posted by anyone) names a DM.
    await handleBlockAction({
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U1' },
      channel: { id: 'C0HERE0001' },
      response_url: 'https://hooks.slack.com/actions/T1/1/x',
      actions: [{ action_id: 'set_agent_session-reviewer', value: JSON.stringify({ c: 'D0SOMEONE', a: 'session-reviewer' }) }],
    } as any);
    // A modal whose metadata names one conversation and whose button names another.
    await handleBlockAction({
      type: 'block_actions',
      team: { id: 'T1' },
      user: { id: 'U1' },
      view: { id: 'V1', callback_id: 'switch_agent', private_metadata: 'D0DM1' },
      actions: [{ action_id: 'set_agent_session-reviewer', value: JSON.stringify({ c: 'D0SOMEONE', a: 'session-reviewer' }) }],
    } as any);
    expect(changes).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('the modal names the conversation it configures, for the clicks inside it', async () => {
    await click();
    for (const call of calls) expect((call.args[2] as any).private_metadata).toBe('D0DM1');
  });
});
