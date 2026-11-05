import { describe, expect, test } from 'bun:test';
import { agentDisplayLabel } from './agent-selector';
import type { Agent } from '@kortix/sdk/react';

describe('agentDisplayLabel', () => {
  test('maps legacy agent name kortix to Xera', () => {
    const agents = [{ name: 'kortix' }] as Agent[];
    expect(agentDisplayLabel(agents, 'kortix')).toBe('Xera');
    expect(agentDisplayLabel(agents, null)).toBe('Xera');
  });

  test('maps worker to Xera', () => {
    const agents = [{ name: 'worker' }] as Agent[];
    expect(agentDisplayLabel(agents, 'worker')).toBe('Xera');
    expect(agentDisplayLabel(agents, null)).toBe('Xera');
  });

  test('maps mykortix to Orchestrator', () => {
    const agents = [{ name: 'mykortix' }] as Agent[];
    expect(agentDisplayLabel(agents, 'mykortix')).toBe('Orchestrator');
  });

  test('capitalizes custom agent names', () => {
    const agents = [{ name: 'reviewer' }] as Agent[];
    expect(agentDisplayLabel(agents, 'reviewer')).toBe('Reviewer');
  });
});
