import { describe, expect, test } from 'bun:test';
import { agentDisplayLabel } from './agent-selector';
import type { Agent } from '@kortix/sdk/react';

describe('agentDisplayLabel', () => {
  test('maps legacy agent name kortix to Dot', () => {
    const agents = [{ name: 'kortix' }] as Agent[];
    expect(agentDisplayLabel(agents, 'kortix')).toBe('Dot');
    expect(agentDisplayLabel(agents, null)).toBe('Dot');
  });

  test('maps worker to Dot', () => {
    const agents = [{ name: 'worker' }] as Agent[];
    expect(agentDisplayLabel(agents, 'worker')).toBe('Dot');
    expect(agentDisplayLabel(agents, null)).toBe('Dot');
  });

  test('maps xera to Dot', () => {
    const agents = [{ name: 'xera' }] as Agent[];
    expect(agentDisplayLabel(agents, 'xera')).toBe('Dot');
    expect(agentDisplayLabel(agents, null)).toBe('Dot');
  });

  test('maps mykortix to Dot', () => {
    const agents = [{ name: 'mykortix' }] as Agent[];
    expect(agentDisplayLabel(agents, 'mykortix')).toBe('Dot');
  });

  test('maps dot to Dot', () => {
    const agents = [{ name: 'dot' }] as Agent[];
    expect(agentDisplayLabel(agents, 'dot')).toBe('Dot');
  });

  test('capitalizes custom agent names', () => {
    const agents = [{ name: 'reviewer' }] as Agent[];
    expect(agentDisplayLabel(agents, 'reviewer')).toBe('Reviewer');
  });
});
