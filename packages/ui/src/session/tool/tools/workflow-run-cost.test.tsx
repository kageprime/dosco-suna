import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionUsage } from '@kortix/sdk';
import { IntlTestProvider } from '../../../test-utils/intl';

// The usage read per root session id: what `GET …/sessions/:id/usage` answered.
let usageBySession: Record<string, SessionUsage | undefined> = {};
const real = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...real,
  useSessionUsage: (_projectId: string | undefined, sessionId: string | undefined) => ({
    data: sessionId ? usageBySession[sessionId] : undefined,
    refetch: async () => undefined,
  }),
}));

const { TooltipProvider } = await import('../../../primitives/tooltip');
const { WorkflowRunCost, runSpentUsd } = await import('./workflow-run-cost');

const totals = (kortix: number, compute?: number) => ({
  cost: kortix, kortix_cost: kortix, provider_cost: 0, request_count: 1, error_count: 0,
  input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0,
  ...(compute === undefined ? {} : { compute_cost: compute, billed_cost: kortix + compute }),
});
const entry = (id: string, parent: string | null, depth: number, kortix: number, compute?: number) => ({
  ...totals(kortix, compute), session_id: id, parent_session_id: parent, depth,
  title: null, agent_name: null, status: 'active', created_at: '2026-11-15T00:00:00Z',
});

// A runner (0.01 + 0.03 compute) with two agents; agent-1 started one helper.
const RUNNER_TREE: SessionUsage = {
  session_id: 'runner', currency: 'USD', hidden_sessions: 0, truncated: false,
  total: totals(0.06, 0.1),
  sessions: [
    entry('runner', null, 0, 0.01, 0.03),
    entry('agent-1', 'runner', 1, 0.02, 0.04),
    entry('helper', 'agent-1', 2, 0.01, 0.01),
    entry('agent-2', 'runner', 1, 0.02, 0.02),
  ],
};

const wrap = (node: ReactNode) => (
  <IntlTestProvider locale="en">
    <TooltipProvider>{node}</TooltipProvider>
  </IntlTestProvider>
);

describe('workflow run cost', () => {
  test('a background run costs its whole runner tree: model calls plus compute', () => {
    expect(runSpentUsd(RUNNER_TREE)).toBeCloseTo(0.16, 10);
  });

  test('a run in the calling session costs only its agents and what they started, not the caller', () => {
    expect(runSpentUsd(RUNNER_TREE, ['agent-1'])).toBeCloseTo(0.08, 10);
    expect(runSpentUsd(RUNNER_TREE, [])).toBe(0);
  });

  test('a server without compute falls back to the model calls Kortix billed', () => {
    const old = { ...RUNNER_TREE, total: totals(0.06), sessions: RUNNER_TREE.sessions.map((s) => ({ ...s, compute_cost: undefined, billed_cost: undefined })) };
    expect(runSpentUsd(old)).toBe(0.06);
  });

  test('the card line reads "Spent N credits" from the usage read', () => {
    usageBySession = { runner: RUNNER_TREE };
    const html = renderToStaticMarkup(wrap(<WorkflowRunCost projectId="p1" rootSessionId="runner" live={false} />));
    expect(html).toContain('data-testid="workflow-run-cost"');
    expect(html).toContain('Spent 16 credits');
  });

  test('nothing renders before the read answers or while the run has cost nothing', () => {
    usageBySession = { idle: { ...RUNNER_TREE, total: totals(0, 0), sessions: [entry('idle', null, 0, 0, 0)] } };
    expect(renderToStaticMarkup(wrap(<WorkflowRunCost projectId="p1" rootSessionId="missing" live />))).toBe('');
    expect(renderToStaticMarkup(wrap(<WorkflowRunCost projectId="p1" rootSessionId="idle" live={false} />))).toBe('');
  });
});
