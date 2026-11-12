import { describe, expect, test } from 'bun:test';

import { ApiError } from '../api/client.ts';
import { doctorRetryAgent } from '../commands/doctor.ts';
import { agentChoiceFromError, agentChoiceHint } from '../commands/session-agent-choice.ts';

// From a My Kortix session, a create that names no agent (AGENT_REQUIRED) or
// names My Kortix (META_AGENT_RECURSION) is refused with the agents to name.
// `sessions new` must say which flag fixes it; `doctor` must pick one.

const required = new ApiError(400, 'A session My Kortix starts names its agent.', {
  error: 'A session My Kortix starts names its agent.',
  code: 'AGENT_REQUIRED',
  agents: ['worker', 'reviewer'],
});
const recursion = new ApiError(400, 'My Kortix cannot start another My Kortix session.', {
  error: 'My Kortix cannot start another My Kortix session.',
  code: 'META_AGENT_RECURSION',
  agents: ['worker'],
});

describe('My Kortix agent refusal', () => {
  test('AGENT_REQUIRED: the hint names --agent and every agent listed', () => {
    const choice = agentChoiceFromError(required);
    expect(choice).toEqual({ code: 'AGENT_REQUIRED', message: 'A session My Kortix starts names its agent.', agents: ['worker', 'reviewer'] });
    expect(agentChoiceHint(choice!)).toBe('Pass --agent <one of: worker, reviewer>, e.g. kortix sessions new --agent worker --prompt "…"');
  });

  test('META_AGENT_RECURSION: the hint names the alternative agent', () => {
    expect(agentChoiceHint(agentChoiceFromError(recursion)!)).toContain('--agent <one of: worker>');
  });

  test('no second hint when the API message already names --agent', () => {
    const current = new ApiError(400, 'm', {
      error: 'A session My Kortix starts names its agent. Set `agent_name` (CLI: `--agent <name>`) to one of: worker.',
      code: 'AGENT_REQUIRED',
      agents: ['worker'],
    });
    expect(agentChoiceHint(agentChoiceFromError(current)!)).toBeNull();
    expect(doctorRetryAgent(current)).toBe('worker');
  });

  test('an older API without the agents list still gets the --agent fix', () => {
    const old = new ApiError(400, 'x', { error: 'x', code: 'META_AGENT_RECURSION' });
    expect(agentChoiceHint(agentChoiceFromError(old)!)).toBe(
      'Pass --agent <name> with a project agent from kortix.yaml (kortix agents ls lists them).',
    );
    expect(doctorRetryAgent(old)).toBeNull();
  });

  test('an SDK error carries the body in details', () => {
    const sdkLike = Object.assign(new Error('m'), { details: { code: 'AGENT_REQUIRED', agents: ['worker'] } });
    expect(agentChoiceFromError(sdkLike)?.agents).toEqual(['worker']);
  });

  test('any other failure is not an agent refusal', () => {
    expect(agentChoiceFromError(new ApiError(400, 'bad', { code: 'INVALID_MODEL' }))).toBeNull();
    expect(agentChoiceFromError(new Error('network'))).toBeNull();
    expect(doctorRetryAgent(new ApiError(500, 'boom'))).toBeNull();
  });

  test('doctor retries with the first agent the refusal lists', () => {
    expect(doctorRetryAgent(required)).toBe('worker');
    expect(doctorRetryAgent(recursion)).toBe('worker');
  });
});
