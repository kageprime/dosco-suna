import { Window } from 'happy-dom';
import { afterEach, describe, expect, test } from 'bun:test';
import { peerMessagePromptText } from '@kortix/shared';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { sessionLogAgentRuns, sessionLogOfV1Rows, sessionLogTurns } from '@kortix/sdk';

import { TranscriptTurnRow } from '../index';

/**
 * KRTX-4732, the run fold: a person's agents report back as one unit. The
 * turns of a run fold into the turn that answers it ("Worked for 5m · 3
 * agents"), the absorbed turns draw nothing, the agent's relays between
 * colleagues (`send_message`) are not shown, and once every agent reported,
 * the turn that started them folds its agent rows. Synthetic values only.
 */

type V1MessageRow = Parameters<typeof sessionLogOfV1Rows>[2][number];

const child = (n: number) => `${String(n).padStart(8, '0')}-0b7c-4000-8000-2f1e00000000`;
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0);
const min = (m: number) => T0 + m * 60_000;

const subagentNotice = (n: number) =>
  [
    'A background subagent you started has finished. This message is from the platform, not from the user.',
    `task_id: ${child(n)}`,
    'status: completed',
    '',
    `<task_result>\nReport ${n}: synthetic result.\n</task_result>`,
  ].join('\n');

const peerReport = peerMessagePromptText({
  kind: 'message',
  from: 'metrics-checker',
  fromShortId: child(2).slice(0, 8),
  messageId: 'm_2',
  summary: '5 of 6 numbers match',
  text: 'Checked all 6 numbers; one corrected.',
});

const assistantInfo = (id: string, parent: string, created: number, completed: number) => ({
  id, sessionID: 'rs', role: 'assistant' as const, agent: 'build', modelID: 'test', providerID: 'test', mode: 'build',
  path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  parentID: parent, time: { created, completed },
});
const userRow = (id: string, text: string, created: number, synthetic = false): V1MessageRow => ({
  info: { id, sessionID: 'rs', role: 'user', agent: 'build', model: { providerID: 'test', modelID: 'test' }, time: { created } },
  parts: [{ id: `${id}-text`, sessionID: 'rs', messageID: id, type: 'text', ...(synthetic ? { synthetic: true } : {}), text }],
} as V1MessageRow);
const tool = (mid: string, n: number, name: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
  id: `${mid}-t${n}`, sessionID: 'rs', messageID: mid, type: 'tool' as const, callID: `call-${mid}-${n}`, tool: name,
  state: { status: 'completed' as const, input, output: 'ok', title: name, metadata, time: { start: 1, end: 2 } },
});
const textPart = (mid: string, text: string) => ({ id: `${mid}-x`, sessionID: 'rs', messageID: mid, type: 'text' as const, text });

const rows: V1MessageRow[] = [
  userRow('launch', 'Ship the launch post.', min(0)),
  {
    info: assistantInfo('launch-a', 'launch', min(0), min(0.1)),
    parts: [
      tool('launch-a', 1, 'agent', { description: 'Draft the launch post', subagent_type: 'draft-writer' }, { sessionId: child(1) }),
      tool('launch-a', 2, 'agent', { description: 'Verify the numbers', subagent_type: 'metrics-checker' }, { sessionId: child(2) }),
      tool('launch-a', 3, 'agent', { description: 'Review the post', subagent_type: 'post-reviewer' }, { sessionId: child(3) }),
      textPart('launch-a', 'Three colleagues are on it.'),
    ],
  } as V1MessageRow,
  userRow('r1', subagentNotice(1), min(2), true),
  {
    info: assistantInfo('r1-a', 'r1', min(2), min(2.1)),
    parts: [tool('r1-a', 1, 'send_message', { to: 'post-reviewer', summary: 'Draft v1 is up', message: 'Review the draft.' })],
  } as V1MessageRow,
  userRow('r2', peerReport, min(3), true),
  { info: assistantInfo('r2-a', 'r2', min(3), min(3.1)), parts: [textPart('r2-a', 'Got the numbers, waiting on the review.')] } as V1MessageRow,
  userRow('r3', subagentNotice(3), min(5), true),
  { info: assistantInfo('r3-a', 'r3', min(5), min(5.1)), parts: [textPart('r3-a', 'The launch post is ready.')] } as V1MessageRow,
];

const turns = sessionLogTurns(sessionLogOfV1Rows('p', 'rs', rows).threads[0]!);
const layout = sessionLogAgentRuns(turns);
const byId = new Map(turns.map((turn) => [turn.id, turn]));
const anchor = byId.get('r3')!;
const run = layout.runs.get('r3')!;
const runTurns = run.turns.slice(0, -1).map((id) => byId.get(id)!);

type RowProps = ComponentProps<typeof TranscriptTurnRow>;
const base = (turn: RowProps['turn']): RowProps => ({
  turnId: turn.id, viewportClassName: '', suppressed: false, showBusyRow: false, turn, turnOutcome: {}, isLast: true,
  ownsPlan: false, sessionId: 's', sessionStatus: undefined, permissions: [], questions: [], sessionWorking: false,
  isWorkingTurn: false, suppressBusyIndicator: false, awaitingUser: false, pending: false, isFirstTurn: false,
  onPermissionReply: () => Promise.resolve(), onRewind: () => undefined, rewindDisabled: false, fullTextState: 'idle',
  onLoadFullText: () => undefined, modelOptions: 2,
});
const html = (props: RowProps) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TranscriptTurnRow, props)));

const browser = new Window();
Object.defineProperty(globalThis, 'window', { value: browser, configurable: true });
Object.defineProperty(globalThis, 'document', { value: browser.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let mounted: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => mounted?.unmount()); });

describe('agent run fold (KRTX-4732)', () => {
  test('the fixture is one run of three agents, anchored on the answer', () => {
    expect([...layout.absorbed]).toEqual(['r1', 'r2']);
    expect(run.agents).toBe(3);
    expect([...layout.settledLaunches]).toEqual(['launch']);
  });

  test('the anchor reads as one row over every answer of the run; the reports stay folded', () => {
    const out = html({ ...base(anchor), agentRun: run, runTurns });
    expect(out).toContain('Worked for 5m · 3 agents');
    // Every answer stays in view, in order, the last one last: the agent may answer in full
    // before the last report arrives.
    const interim = out.indexOf('Got the numbers, waiting on the review.');
    expect(interim).toBeGreaterThan(out.indexOf('Worked for 5m · 3 agents'));
    expect(out.indexOf('The launch post is ready.')).toBeGreaterThan(interim);
    // A report turn with no answer draws no block.
    expect(out.match(/data-testid="agent-run-answer"/g)).toHaveLength(1);
    // Folded and not yet opened: no report is mounted.
    expect(out).not.toContain('data-testid="agent-run-member"');
    expect(out).not.toContain('metrics-checker');
    expect(out).not.toContain('Worked for 6s');
  });

  test('an absorbed turn draws nothing', () => {
    const out = html({ ...base(byId.get('r2')!), suppressed: true });
    expect(out).not.toContain('peer-message-turn');
    expect(out).not.toContain('Got the numbers');
  });

  test('opening the row shows each report and its work, never the relay calls', async () => {
    await act(async () => {
      mounted = create(
        <QueryClientProvider client={new QueryClient()}>
          <TranscriptTurnRow {...base(anchor)} agentRun={run} runTurns={runTurns} />
        </QueryClientProvider>,
      );
    });
    const toggle = mounted!.root.findAll((node) => node.type === 'button' && node.props['aria-expanded'] === false)[0]!;
    await act(async () => toggle.props.onClick());
    const members = mounted!.root.findAll((node) => node.props['data-testid'] === 'agent-run-member');
    expect(members).toHaveLength(2);
    const text = JSON.stringify(mounted!.toJSON());
    expect(text).toContain('metrics-checker');
    expect(text).not.toContain('post-reviewer · summary');
    expect(text.toLowerCase()).not.toContain('send message');
  });

  test('a live run says how many agents reported', () => {
    const live = { ...run, live: true, durationMs: null, reported: 2 };
    expect(html({ ...base(anchor), agentRun: live, runTurns, isWorkingTurn: true, sessionWorking: true })).toContain('Working · 2 of 3 agents reported');
  });

  test('every agent reported: the launch turn folds its agent rows behind its own row', () => {
    const launch = byId.get('launch')!;
    const open = html(base(launch));
    const folded = html({ ...base(launch), foldStartedWork: true });
    // Before every agent reported, the agent rows stay in view, even with no other work.
    expect(open).toContain('Draft the launch post');
    expect(open).not.toContain('Worked for');
    expect(folded).toContain('Worked for 6s');
    expect(folded).toContain('Three colleagues are on it.');
  });
});
