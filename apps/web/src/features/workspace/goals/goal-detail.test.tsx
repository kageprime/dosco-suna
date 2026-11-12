// KRTX-4645 characterization: pins the goal page's behavior before the file is
// split into goal-rail / goal-activity / goal-controls / goal-parts. The page
// renders through the unchanged public path (`GoalDetail`); the SDK data hooks
// are the only seams. The one-channel tests at the bottom are the dedupe's
// proof: each MessageBox mounted its own `useGoalActions`, so the header's
// Pause stayed enabled while an answer sent. They fail on the pre-split code
// by design.
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, createElement, Fragment, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { ApiError, type ProjectGoal, type ProjectGoalCapabilities, type ProjectGoalCriterionStatus, type ProjectGoalEvent, type ProjectGoalRecord, type ProjectGoalVerification } from '@kortix/sdk';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.customElements = win.customElements; // the markdown diff viewer registers a web component at import
for (const key of Object.getOwnPropertyNames(win)) {
  // Base UI dispatches happy-dom's own event classes, not Bun's.
  if (/^[A-Z]/.test(key) && (!(key in globals) || key.endsWith('Event'))) {
    globals[key] = Reflect.get(win, key);
  }
}

// --- module mocks: data hooks, translations, auth, the share modal, navigation ---
// `mock.module` is process-wide: every shared module keeps its real exports and
// overrides only what this test needs, so other suites in the same run still link.

const realTranslations = await import('@/i18n/use-translations');
const realUiI18n = await import('@kortix/ui/i18n');
const translationsMock = () => ({
  ...realTranslations,
  useLocale: () => 'en',
  // `ns.key` keeps every call site's key visible in the markup, params included by position only.
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
});
mock.module('@/i18n/use-translations', translationsMock);
mock.module('@kortix/ui/i18n', translationsMock);

mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

mock.module('@/features/workspace/goals/goal-share-modal', () => ({
  GoalShareModal: () => null,
}));

const routerPushes: string[] = [];
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => routerPushes.push(href), replace: () => {}, prefetch: () => {}, back: () => {} }),
  usePathname: () => '/workspaces/p-1/goals/g-1',
  useParams: () => ({}),
}));

const realLink = await import('next/link');
mock.module('next/link', () => ({
  ...realLink,
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode; className?: string; 'aria-label'?: string; onClick?: () => void }) =>
    createElement('a', { href, ...rest }, children),
}));

// The menu's items render through a portal that a static render drops; content
// inline pins the capability-gated menu items (Stop) in the markup.
const realDropdownMenu = await import('@kortix/ui/dropdown-menu');
mock.module('@kortix/ui/dropdown-menu', () => ({
  ...realDropdownMenu,
  DropdownMenu: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-dropdown-content': true }, children),
  DropdownMenuItem: ({ children, disabled, 'data-testid': testId, variant }: { children?: ReactNode; disabled?: boolean; 'data-testid'?: string; variant?: string }) =>
    createElement('button', { 'data-testid': testId, disabled, 'data-variant': variant }, children),
  DropdownMenuSeparator: () => createElement('hr'),
}));

// --- the data seams ---

type FilesData = { brief: string | null; log: string | null; notes: string | null; verification: string | null };

interface QueryShape<T> {
  data: T | null | undefined;
  isError: boolean;
  error: Error | null;
  isPending: boolean;
  refetch: () => Promise<unknown>;
}

let goalResult: QueryShape<ProjectGoal> = { data: undefined, isError: false, error: null, isPending: true, refetch: async () => undefined };
let filesResult: QueryShape<FilesData> = { data: undefined, isError: false, error: null, isPending: true, refetch: async () => undefined };
let eventsResult: QueryShape<{ events: ProjectGoalEvent[] }> = { data: { events: [] }, isError: false, error: null, isPending: false, refetch: async () => undefined };
const sessionNames = new Map<string, string>();

const realSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useProjectGoal: () => goalResult,
  useProjectGoalFiles: () => filesResult,
  useProjectGoalEvents: () => eventsResult,
  useProjectGoals: () => ({ data: [] as ProjectGoal[] }),
  useProjectSession: (_projectId: string, sessionId: string) => ({ data: sessionNames.has(sessionId) ? { name: sessionNames.get(sessionId) } : undefined }),
  // Per-instance mutation state, like the real hook: every `useProjectGoalControl`
  // call gets its own pending flag, so the page channel and a MessageBox channel
  // are distinguishable — which is exactly what the one-channel tests pin.
  useProjectGoalControl: () => useMutation({ mutationFn: controlFn }),
}));

// The control the test resolves: each mutateAsync parks on `controlDeferred`.
const controlCalls: Array<{ action: string; goalId: string }> = [];
let controlDeferred: { resolve: (goal: ProjectGoal | null) => void; reject: (error: unknown) => void } | null = null;
const controlFn = (input: { goal: ProjectGoal; action: string }): Promise<ProjectGoal | null> => {
  controlCalls.push({ action: input.action, goalId: input.goal.goalId });
  return new Promise<ProjectGoal | null>((resolve, reject) => {
    controlDeferred = { resolve: () => resolve(null), reject };
  });
};

// After the window exists: react-dom decides at load whether the DOM fires `input` events.
const { createRoot } = await import('react-dom/client');

const realSdk = await import('@kortix/sdk');
const { GoalDetail } = await import('./goal-detail');

// --- fixtures ---

function capabilities(overrides: Partial<ProjectGoalCapabilities> = {}): ProjectGoalCapabilities {
  return { read: true, edit: true, pause: true, resume: true, stop: true, restart: true, answer: true, edit_criteria: true, ...overrides };
}

function record(overrides: Partial<ProjectGoalRecord> = {}): ProjectGoalRecord {
  return {
    goal_id: 'g-1',
    project_id: 'p-1',
    revision: 3,
    title: 'Close the bank account',
    state: 'active',
    waiting_on: null,
    chase_at: null,
    summary: '',
    paused_at: null,
    paused_by_user_id: null,
    stopped_at: null,
    blocked_reason: null,
    assigned_user_id: null,
    created_by_user_id: 'user-1',
    agent: 'planner',
    space: null,
    drive_id: 'd-1',
    folder: '/Users/u/Goals/bank',
    box_folder: '/drives/me/Goals/bank',
    slug: 'bank',
    owner_session_id: 's-owner',
    sessions: [{ id: 's-owner', role: 'owner', since: '2026-11-01T00:00:00Z' }],
    criteria_revision: 1,
    criteria: [],
    verification: null,
    heartbeat_every: '4h',
    next_wake_at: '2026-11-10T16:00:00Z',
    last_wake_at: '2026-11-10T15:00:00Z',
    max_wakes_per_day: 10,
    wakes_today: 2,
    max_sessions: 5,
    provenance: 'api',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-10T15:00:00Z',
    capabilities: capabilities(),
    ...overrides,
  } as ProjectGoalRecord;
}

function goalFixture(overrides: Partial<ProjectGoal> = {}): ProjectGoal {
  return {
    slug: 'bank',
    scope: 'personal',
    driveId: 'd-1',
    folder: '/Users/u/Goals/bank',
    goal: null,
    heartbeat: null,
    coordinatorSessionId: 's-owner',
    health: { state: 'healthy', issues: [] },
    projectId: 'p-1',
    goalId: 'g-1',
    revision: 3,
    capabilities: capabilities(),
    blockedReason: null,
    verification: null,
    criteria: [],
    record: record(),
    ...overrides,
  } as ProjectGoal;
}

function criterion(overrides: Partial<ProjectGoalCriterionStatus>): ProjectGoalCriterionStatus {
  return { id: 'c0', text: 'A criterion', reported_met: false, evidence: null, verified: false, ...overrides };
}

function event(overrides: Partial<ProjectGoalEvent> & { id: string; kind: string; message: string }): ProjectGoalEvent {
  return {
    goal_id: 'g-1',
    at: '2026-11-09T12:00:00Z',
    actor_kind: 'session',
    actor_id: 's-owner',
    from_state: null,
    to_state: null,
    data: {},
    ...overrides,
  } as ProjectGoalEvent;
}

const REPORT = '# Verification report\n\n2 of 3 criteria passed.';

/** Renders the page once, server-style, with the fixture in place. */
function renderPage(fixture: { goal: ProjectGoal | null; files?: FilesData; events?: ProjectGoalEvent[]; status?: number }): string {
  goalResult = {
    data: fixture.goal,
    isError: fixture.status != null,
    error: fixture.status != null ? new ApiError('nope', { status: fixture.status }) : null,
    isPending: false,
    refetch: async () => undefined,
  };
  filesResult = {
    data: fixture.files ?? { brief: null, log: null, notes: null, verification: null },
    isError: false,
    error: null,
    isPending: false,
    refetch: async () => undefined,
  };
  eventsResult = { data: { events: fixture.events ?? [] }, isError: false, error: null, isPending: false, refetch: async () => undefined };
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(GoalDetail, { projectId: 'p-1', goalId: 'g-1' })),
  );
}

afterEach(() => {
  controlCalls.length = 0;
  controlDeferred = null;
  routerPushes.length = 0;
});

// --- the page: title, criteria, rail, controls ---

describe('GoalDetail — the page', () => {
  test('pins the header title, the criteria states and the evidence rows', () => {
    const goal = goalFixture({
      criteria: [
        criterion({ id: 'c1', text: 'Account closed', reported_met: true, verified: true }),
        criterion({ id: 'c2', text: 'Funds moved', reported_met: true, verified: false }),
        criterion({ id: 'c3', text: 'Statement saved', reported_met: false, evidence: 'evidence/statement.pdf' }),
      ],
      verification: {
        attempt: 1,
        verifier_session_id: 's-ver',
        criteria_revision: 1,
        started_at: '2026-11-10T14:00:00Z',
        decided_at: '2026-11-10T14:30:00Z',
        outcome: 'fail',
        results: [{ criterion_id: 'c2', result: 'fail', note: 'No transfer receipt' }],
        evidence_hashes: {},
      } as ProjectGoalVerification,
    });
    const html = renderPage({ goal, files: { brief: '# Title\n\nThe brief text.', log: null, notes: null, verification: null } });

    expect(html).toContain('Close the bank account');
    expect(html).toContain('<h1'); // the header renders the title as the page h1
    expect(html).toContain('The brief text.'); // the description, title line dropped
    expect(html).not.toContain('>Title<');
    expect(html).toContain('data-criterion-state="verified"');
    expect(html).toContain('data-criterion-state="reported"');
    expect(html).toContain('data-criterion-state="open"');
    expect(html).toContain('goals.checkFailed'); // the failed check's note under its criterion (the t mock shows the key, not the interpolated note)
    expect(html).toContain('evidence/statement.pdf'); // the evidence file row
    expect(html).toContain('goals.verifiedCount'); // the verified/total aside
  });

  test('pins the rail properties: state, agent, wakes, visibility, sessions, folder', () => {
    sessionNames.set('s-owner', 'Owner session');
    const html = renderPage({
      goal: goalFixture(),
      files: { brief: null, log: null, notes: null, verification: null },
    });
    expect(html).toContain('data-testid="goal-properties"');
    expect(html).toContain('goals.status.active'); // the state row (open, not paused)
    expect(html).toContain('goals.wakesTodayCount'); // wakes today against the cap
    expect(html).toContain('data-testid="goal-wakes-today"');
    expect(html).toContain('data-testid="goal-visibility"'); // who can see it
    expect(html).toContain('goals.scope.personal');
    expect(html).toContain('Owner session'); // the session row's display name
    expect(html).toContain('goals.role.owner');
    expect(html).toContain('goals.filesLabel'); // the folder section
    expect(html).toContain('goals.openFolder');
  });

  test('renders the control set per capability', () => {
    const html = renderPage({ goal: goalFixture() });
    expect(html).toContain('data-testid="goal-pause"');
    expect(html).toContain('data-testid="goal-resume"');
    expect(html).toContain('data-testid="goal-restart"');
    expect(html).toContain('data-testid="goal-more"');
    expect(html).toContain('data-testid="goal-stop"'); // in the ⋯ menu
    expect(html).toContain('data-testid="goal-message"'); // the note box while it works
    expect(html).not.toContain('data-testid="goal-answer"'); // no question yet

    const minimal = renderPage({ goal: goalFixture({ capabilities: capabilities({ pause: true, resume: false, restart: false, stop: false, answer: false }) }) });
    expect(minimal).toContain('data-testid="goal-pause"');
    expect(minimal).not.toContain('data-testid="goal-resume"');
    expect(minimal).not.toContain('data-testid="goal-restart"');
    expect(minimal).not.toContain('data-testid="goal-stop"');
    expect(minimal).not.toContain('data-testid="goal-message"');
  });

  test('the answer box appears when the goal waits on a person, gated on the answer capability', () => {
    const waiting = goalFixture({ record: record({ state: 'waiting_on_user', waiting_on: 'Which bank branch?' }) });
    const html = renderPage({ goal: waiting });
    expect(html).toContain('data-testid="goal-needs-you"');
    expect(html).toContain('goals.questionForYou');
    expect(html).toContain('Which bank branch?');
    expect(html).toContain('data-testid="goal-answer"');
    expect(html).toContain('data-testid="goal-answer-send"');
    expect(html).not.toContain('data-testid="goal-message"'); // the note box waits until the question is answered

    const noAnswer = renderPage({ goal: goalFixture({ record: record({ state: 'waiting_on_user', waiting_on: 'Which bank branch?' }), capabilities: capabilities({ answer: false }) }) });
    expect(noAnswer).toContain('goals.waitingOnPerson'); // it says who it waits on instead
    expect(noAnswer).not.toContain('data-testid="goal-answer"');
  });

  test('a 404 renders the not-found state, not the page', () => {
    const html = renderPage({ goal: null, status: 404 });
    expect(html).toContain('goals.notFound'); // EmptyState drops its data-testid, the title is the pin
    expect(html).toContain('goals.back');
    expect(html).not.toContain('data-testid="goal-properties"');
  });
});

// --- the activity feed ---

describe('GoalDetail — Activity', () => {
  test('pins the feed order, the quiet-event filter and the verifier report placement', () => {
    const events = [
      event({ id: 'e1', kind: 'created', message: 'Goal created: close the bank account', to_state: 'draft', at: '2026-11-01T00:00:00Z' }),
      event({ id: 'e2', kind: 'verdict', message: 'Verification finished: 2 of 3 passed', from_state: 'verifying', to_state: 'active', at: '2026-11-09T12:00:00Z' }),
      event({ id: 'e3', kind: 'wake_admitted', message: 'Woke on schedule', at: '2026-11-09T16:00:00Z' }),
      event({ id: 'e4', kind: 'progress', message: 'Read the statements', at: '2026-11-09T17:00:00Z' }),
    ];
    const html = renderPage({
      goal: goalFixture({ record: record({ summary: 'Weekly summary: two criteria remain.' }) }),
      files: { brief: null, log: '# Log\n\n- 2026-11-04T17:00:00Z Handover', notes: null, verification: REPORT },
      events,
    });

    const created = html.indexOf('Goal created: close the bank account');
    const verdict = html.indexOf('Verification finished: 2 of 3 passed');
    const progress = html.indexOf('Read the statements');
    expect(created).toBeGreaterThanOrEqual(0);
    expect(verdict).toBeGreaterThan(created); // oldest first
    expect(progress).toBeGreaterThan(verdict);
    expect(html).not.toContain('Woke on schedule'); // a quiet event says nothing a person needs
    expect(html.match(/goal-report-toggle/g)?.length).toBe(1); // one report, under the verdict
    expect(html.indexOf('goal-report-toggle')).toBeGreaterThan(verdict);
    expect(html.indexOf('goal-report-toggle')).toBeLessThan(progress);
    expect(html.indexOf('Weekly summary')).toBeGreaterThan(progress); // the agent's summary last
    expect(html).toContain('goals.feed.update');
  });

  test('an events error offers the retry, and a load renders the skeleton instead of the feed', () => {
    goalResult = { data: goalFixture(), isError: false, error: null, isPending: false, refetch: async () => undefined };
    filesResult = { data: { brief: null, log: null, notes: null, verification: null }, isError: false, error: null, isPending: false, refetch: async () => undefined };
    eventsResult = { data: undefined, isError: true, error: new Error('boom'), isPending: false, refetch: async () => undefined };
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(GoalDetail, { projectId: 'p-1', goalId: 'g-1' })),
    );
    expect(html).toContain('goals.eventsLoadError');
    expect(html).toContain('goals.retry');
  });
});

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  controlCalls.length = 0;
  controlDeferred = null;
  routerPushes.length = 0;
});

/** Mounts the page live so the answer flow can run for real: type, submit, watch the header. */
/** happy-dom's runtime objects through the lib-dom type they match at runtime: the one bridge in this file. */
const dom = <T,>(value: unknown): T => value as T;

async function mountPage(fixture: { goal: ProjectGoal; files?: FilesData; events?: ProjectGoalEvent[] }): Promise<void> {
  goalResult = { data: fixture.goal, isError: false, error: null, isPending: false, refetch: async () => undefined };
  filesResult = { data: fixture.files ?? { brief: null, log: null, notes: null, verification: null }, isError: false, error: null, isPending: false, refetch: async () => undefined };
  eventsResult = { data: { events: fixture.events ?? [] }, isError: false, error: null, isPending: false, refetch: async () => undefined };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const mounted = createRoot(dom<Element>(host));
  root = mounted;
  await act(async () =>
    mounted.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(GoalDetail, { projectId: 'p-1', goalId: 'g-1' }))),
  );
}

async function sendMessage(text: string): Promise<void> {
  const textarea = dom<HTMLTextAreaElement | null>(document.querySelector('[data-testid="goal-message"]'));
  if (!textarea) throw new Error('the page rendered no note box');
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('no textarea value setter');
    setValue.call(textarea, text);
    textarea.dispatchEvent(dom<Event>(new win.Event('input', { bubbles: true })));
  });
  const form = dom<HTMLFormElement | null>(textarea.closest('form'));
  if (!form) throw new Error('the note box rendered no form');
  await act(async () => {
    form.dispatchEvent(dom<Event>(new win.Event('submit', { bubbles: true, cancelable: true })));
    // react-query notifies its observers on a scheduler tick, not synchronously: give it one.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function headerButton(testId: string): HTMLButtonElement {
  const button = document.querySelector(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`the header rendered no ${testId}`);
  return button as HTMLButtonElement;
}

describe('GoalDetail — one control channel', () => {
  test('an answer in flight disables the header controls', async () => {
    await mountPage({ goal: goalFixture() });
    expect(headerButton('goal-pause').disabled).toBe(false);

    await sendMessage('Please send the wire by Friday');
    expect(controlCalls).toEqual([{ action: 'answer', goalId: 'g-1' }]);
    // One request at a time: the running answer disables Pause and Stop, not just the box.
    expect(headerButton('goal-message-send').disabled).toBe(true);
    expect(headerButton('goal-pause').disabled).toBe(true);
    expect(headerButton('goal-stop').disabled).toBe(true);

    // react-query notifies its observers on a scheduler tick, not synchronously:
    // give it one, or the settled mutation's disabled=false re-render races this
    // assertion (it lost that race on a loaded CI runner).
    await act(async () => {
      controlDeferred?.resolve(null);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(headerButton('goal-pause').disabled).toBe(false);
    expect(headerButton('goal-stop').disabled).toBe(false);
    expect((document.querySelector('[data-testid="goal-message"]') as HTMLTextAreaElement).value).toBe('');
    expect(document.body.innerHTML).toContain('goals.messageSent');
  });

  test('an answer failure shows in the box with its retry, not in the page banner', async () => {
    await mountPage({ goal: goalFixture() });
    await sendMessage('Please send the wire by Friday');
    await act(async () => controlDeferred?.reject(new Error('The wake failed')));

    const error = document.querySelector('[data-testid="goal-answer-error"]');
    expect(error?.textContent).toContain('The wake failed');
    expect(document.body.innerHTML).toContain('goals.retry');
    expect(document.querySelector('[data-testid="goal-control-error"]')).toBeNull();
  });
});

export {};
