import { describe, expect, test } from 'bun:test';
import { runCanStartAgents } from './workflow-run-controls';

type Run = Parameters<typeof runCanStartAgents>[0];
const agent = (status: Run['agents'][number]['status'], sessionId?: string) =>
  ({ id: `a-${status}-${sessionId ?? 'none'}`, label: 'x', status, ...(sessionId ? { sessionId } : {}) }) as Run['agents'][number];

describe('runCanStartAgents (the Hold new agents control)', () => {
  test('an agent queued for a slot keeps Hold available even when every approved call is registered', () => {
    const run = { phases: [], maxAgents: 2, agents: [agent('running', 'child-1'), agent('starting')] } as Run;
    expect(runCanStartAgents(run)).toBe(true);
  });

  test('every approved agent started and none is queued: nothing is left to hold', () => {
    const run = { phases: [], maxAgents: 2, agents: [agent('running', 'child-1'), agent('running', 'child-2')] } as Run;
    expect(runCanStartAgents(run)).toBe(false);
  });

  test('a pending phase or room under the cap still allows a hold', () => {
    expect(runCanStartAgents({ phases: [{ title: 'Later', status: 'pending' }], maxAgents: 1, agents: [agent('running', 'c')] } as Run)).toBe(true);
    expect(runCanStartAgents({ phases: [], maxAgents: 3, agents: [agent('running', 'c')] } as Run)).toBe(true);
  });
});
