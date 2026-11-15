import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectSession } from '@kortix/sdk';
import { IntlTestProvider } from '../../../test-utils/intl';

// The sidebar primitives are layout slots: plain elements.
function slot(tag: string, marker: string) {
  function Slot({ className, children }: { className?: string; children?: ReactNode }) {
    return createElement(tag, { className, 'data-slot': marker }, children);
  }
  return Slot;
}
mock.module('../../../primitives/sidebar', () => ({
  SidebarMenuItem: slot('li', 'item'),
  SidebarMenuButton: slot('button', 'button'),
  useSidebar: () => ({ setOpenMobile: () => {} }),
}));

const NOW = Date.parse('2026-11-15T12:00:00Z');
let running: ProjectSession[] = [];
const runningOptions: unknown[] = [];
const real = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...real,
  useRunningSessions: (_projectId: string, options: unknown) => {
    runningOptions.push(options);
    return { data: running };
  },
  useWorkspaceSession: (_projectId: string, sessionId: string | undefined) => ({
    data: sessionId === 'parent' ? session('parent', { name: 'Plan the launch' }) : undefined,
  }),
  useNow: () => NOW,
}));

const { TooltipProvider } = await import('../../../primitives/tooltip');
const { ProjectRunningNavItem, RunningPanel, runningPanelState } = await import('./project-running-nav');

function session(id: string, input: { name: string; parent?: string; since?: string; board?: 'working' | 'needs_input' }): ProjectSession {
  return {
    session_id: id,
    project_id: 'p1',
    status: 'active',
    name: input.name,
    metadata: {},
    parent_session_id: input.parent ?? null,
    board_state: input.board ?? 'working',
    working: { state: 'working', since: input.since ?? null, turn_token: null, pending_delivery: false },
    created_at: '2026-11-15T11:00:00Z',
    updated_at: '2026-11-15T11:00:00Z',
  } as unknown as ProjectSession;
}

const wrap = (node: ReactNode) => (
  <IntlTestProvider locale="en">
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  </IntlTestProvider>
);

describe('the sidebar Running row', () => {
  test('stays in the nav while nothing runs, with no count, so the list below never jumps', () => {
    running = [];
    const html = renderToStaticMarkup(wrap(<ProjectRunningNavItem projectId="p1" />));
    expect(html).toContain('>Running</span>');
    expect(html).not.toContain('sessions running');
  });

  test('shows "Running" with the count of sessions at work, and polls as closed', () => {
    running = [session('a', { name: 'Market size' }), session('b', { name: 'Competitors' })];
    const html = renderToStaticMarkup(wrap(<ProjectRunningNavItem projectId="p1" />));
    expect(html).toContain('Running');
    expect(html).toContain('aria-label="2 sessions running"');
    expect(runningOptions.at(-1)).toEqual({ open: false });
  });

  test('the panel lists each session oldest first: title, where it runs, state and elapsed, Open and Stop', () => {
    const rows = [
      session('runner', { name: 'Launch research (workflow)', parent: 'parent', since: '2026-11-15T11:55:00Z' }),
      session('colleague', { name: 'Weekly digest', since: '2026-11-15T11:30:00Z', board: 'needs_input' }),
    ];
    const html = renderToStaticMarkup(wrap(<RunningPanel projectId="p1" sessions={rows} onNavigate={() => {}} />));
    expect(html).toContain('Running now');
    expect(html.indexOf('Weekly digest')).toBeLessThan(html.indexOf('Launch research (workflow)'));
    expect(html).toContain('in Plan the launch');
    expect(html).toContain('working · 5m 00s');
    expect(html).toContain('needs you');
    expect(html).toContain('aria-label="Stop Launch research (workflow)"');
    expect(html).toContain('aria-label="Open Weekly digest"');
  });

  test('a failed refresh after an empty answer is an error, not "nothing runs"', () => {
    expect(runningPanelState({ data: [], isError: true })).toBe('error');
    expect(runningPanelState({ data: undefined, isError: true })).toBe('error');
    expect(runningPanelState({ data: [], isError: false })).toBe('ready');
    expect(runningPanelState({ data: undefined, isError: false })).toBe('loading');
    // "Try again" in flight: the spinner, not the stale error.
    expect(runningPanelState({ data: [], isError: true, isFetching: true })).toBe('loading');
  });

  test('an empty list says "Nothing is running" only after a read answered', () => {
    const loading = renderToStaticMarkup(wrap(<RunningPanel projectId="p1" sessions={[]} state="loading" onNavigate={() => {}} />));
    expect(loading).not.toContain('Nothing is running');
    const failed = renderToStaticMarkup(wrap(<RunningPanel projectId="p1" sessions={[]} state="error" onRetry={() => {}} onNavigate={() => {}} />));
    expect(failed).not.toContain('Nothing is running');
    expect(failed).toContain('Couldn');
    expect(failed).toContain('Try again');
  });

  test('an empty panel says so', () => {
    const html = renderToStaticMarkup(wrap(<RunningPanel projectId="p1" sessions={[]} onNavigate={() => {}} />));
    expect(html).toContain('Nothing is running.');
  });
});
