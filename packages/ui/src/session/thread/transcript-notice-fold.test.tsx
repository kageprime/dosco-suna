import { Window } from 'happy-dom';
import { afterEach, describe, expect, test } from 'bun:test';
import { peerMessagePromptText } from '@kortix/shared';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { sessionLogOfV1Rows, sessionLogTurns, type SessionLogTurn } from '@kortix/sdk';

/** One v1 row: the shape `sessionLogOfV1Rows` converts and the store's `hydrate` takes. */
type V1MessageRow = Parameters<typeof sessionLogOfV1Rows>[2][number];

import { TranscriptTurnRow } from '../index';

/**
 * The render decision of KRTX-4732: a turn whose prompt is another agent's
 * notice (a sub-agent's report, a teammate's update) folds that row into its
 * "Worked for" fold once the turn settles, so the parent's answer is the only
 * top-level message and the child exchange stays reachable by opening the
 * row. A live turn shows the row until the turn settles, and a turn with no
 * answer at all keeps the row at the top level, where it stays reachable.
 */
const peerPrompt = peerMessagePromptText({
  kind: 'message',
  from: 'reviewer',
  fromShortId: '12345678',
  messageId: 'peer-1',
  summary: 'Review done, 2 comments',
  text: 'Rebased and reviewed. Two comments on the synthetic diff.',
});

/** A report turn that did work: a tool call, then the parent's answer text. */
const reportTurnRows: V1MessageRow[] = [
  {
    info: { id: 'peer-prompt', sessionID: 'rs', role: 'user', agent: 'build', model: { providerID: 'test', modelID: 'test' }, time: { created: 1 } },
    parts: [{ id: 'peer-text', sessionID: 'rs', messageID: 'peer-prompt', type: 'text', synthetic: true, text: peerPrompt }],
  },
  {
    info: { id: 'peer-answer', sessionID: 'rs', role: 'assistant', agent: 'build', modelID: 'test', providerID: 'test', mode: 'build', path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: 'peer-prompt', time: { created: 2, completed: 9_000 } },
    parts: [
      { id: 'peer-bash', sessionID: 'rs', messageID: 'peer-answer', type: 'tool', callID: 'call-peer-bash', tool: 'bash', state: { status: 'completed', input: { command: 'echo synthetic' }, output: 'synthetic', title: 'Run the synthetic check', metadata: {}, time: { start: 2_000, end: 5_000 } } },
      { id: 'peer-final', sessionID: 'rs', messageID: 'peer-answer', type: 'text', text: 'Run is done: 2 of 3 checks passed.' },
    ],
  },
];

const reportTurn: SessionLogTurn = sessionLogTurns(sessionLogOfV1Rows('p', 'rs', reportTurnRows).threads[0]!)[0]!;

/** A notice turn the person answered inline: the reply is text plus an
 *  answered `question` call — no tool steps, so the turn renders in the
 *  inline content mode (no fold row of its own). The notice row must still
 *  render, visible above the answer, so the exchange stays reachable. */
const inlineAnswerRows: V1MessageRow[] = [
  {
    info: { id: 'inline-prompt', sessionID: 'rs', role: 'user', agent: 'build', model: { providerID: 'test', modelID: 'test' }, time: { created: 1 } },
    parts: [{ id: 'inline-text', sessionID: 'rs', messageID: 'inline-prompt', type: 'text', synthetic: true, text: peerPrompt }],
  },
  {
    info: { id: 'inline-answer', sessionID: 'rs', role: 'assistant', agent: 'build', modelID: 'test', providerID: 'test', mode: 'build', path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, parentID: 'inline-prompt', time: { created: 2, completed: 9_000 } },
    parts: [
      { id: 'inline-q', sessionID: 'rs', messageID: 'inline-answer', type: 'tool', callID: 'call-inline-q', tool: 'question', state: { status: 'completed', title: 'Ask which plan to quote', input: { questions: [{ question: 'Which plan should we quote?' }] }, output: 'Answered', metadata: { answers: [['Plan-based']] }, time: { start: 2_000, end: 5_000 } } },
      { id: 'inline-final', sessionID: 'rs', messageID: 'inline-answer', type: 'text', text: 'Going with the plan-based quote.' },
    ],
  },
];

const inlineAnswerTurn: SessionLogTurn = sessionLogTurns(sessionLogOfV1Rows('p', 'rs', inlineAnswerRows).threads[0]!)[0]!;

function renderRow(turn: SessionLogTurn, working = false): string {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(TranscriptTurnRow, {
        turnId: turn.id,
        viewportClassName: '',
        suppressed: false,
        showBusyRow: false,
        turn,
        turnOutcome: {},
        isLast: true,
        ownsPlan: false,
        sessionId: 's',
        sessionStatus: undefined,
        permissions: [],
        questions: [],
        sessionWorking: working,
        isWorkingTurn: working,
        suppressBusyIndicator: false,
        awaitingUser: false,
        pending: false,
        isFirstTurn: false,
        onPermissionReply: () => Promise.resolve(),
        onRewind: () => undefined,
        rewindDisabled: false,
        fullTextState: 'idle',
        onLoadFullText: () => undefined,
        modelOptions: 2,
      }),
    ),
  );
}

// ─── The live → settled transition, rendered statefully (react-test-renderer) ──
const browser = new Window();
Object.defineProperty(globalThis, 'window', { value: browser, configurable: true });
Object.defineProperty(globalThis, 'document', { value: browser.document, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
let mounted: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => mounted?.unmount()); });
const client = new QueryClient();
function renderTurn(working: boolean) {
  return (
    <QueryClientProvider client={client}>
      <TranscriptTurnRow
        turnId={reportTurn.id}
        viewportClassName=""
        suppressed={false}
        showBusyRow={false}
        turn={reportTurn}
        turnOutcome={{}}
        isLast
        ownsPlan={false}
        sessionId="s"
        sessionStatus={undefined}
        permissions={[]}
        questions={[]}
        sessionWorking={working}
        isWorkingTurn={working}
        suppressBusyIndicator={false}
        awaitingUser={false}
        pending={false}
        isFirstTurn={false}
        onPermissionReply={() => Promise.resolve()}
        onRewind={() => undefined}
        rewindDisabled
        fullTextState="idle"
        onLoadFullText={() => undefined}
        modelOptions={2}
      />
    </QueryClientProvider>
  );
}
const peerRow = () => mounted!.root.find((node) => node.props['data-testid'] === 'peer-message-turn');
/** The keyed wrapper around a node: its `hidden` is the fold. */
const wrapperOf = (node: ReactTestRenderer['root'] extends never ? never : ReturnType<typeof peerRow>) => {
  let current = node.parent;
  while (current && !(current.type === 'div' && 'hidden' in current.props)) current = current.parent;
  if (!current) throw new Error('Missing notice wrapper');
  return current;
};
const workRow = () => mounted!.root.find((node) => node.type === 'button' && node.props['aria-expanded'] !== undefined && String(node.props.children?.[0]?.props?.children ?? '').startsWith('Worked'));



describe('a notice turn folds its row into the work fold (KRTX-4732)', () => {
  test('a settled report turn folds the peer message behind its Worked row', () => {
    const html = renderRow(reportTurn);
    const worked = html.indexOf('Worked for');
    expect(worked).toBeGreaterThan(-1);
    // The row is fold content: like every fold's work, it mounts on the first
    // open, so the default level shows no child message block. The parent's
    // answer is the turn's only top-level content.
    expect(html).not.toContain('data-testid="peer-message-turn"');
    expect(html).not.toContain('Rebased and reviewed. Two comments on the synthetic diff.');
    expect(html).toContain('Run is done: 2 of 3 checks passed.');
  });

  test('a report turn that mounted live folds its row at settle, hidden while closed, without a remount', async () => {
    await act(async () => { mounted = create(renderTurn(true)); });
    const row = peerRow();
    expect(row).toBeDefined();
    // No fold while the turn works: the row renders visible.
    expect(mounted!.root.findAll((node) => node.type === 'button' && node.props['aria-expanded'] !== undefined && String(node.props.children?.[0]?.props?.children ?? '').startsWith('Worked'))).toHaveLength(0);
    await act(async () => mounted?.update(renderTurn(false)));
    // The row kept its DOM identity (the fold's no-remount rule), hidden
    // behind the closed "Worked for" row; opening the row shows the exchange.
    expect(peerRow()).toBe(row);
    expect(workRow().props['aria-expanded']).toBe(false);
    expect(wrapperOf(row).props.hidden).toBe(true);
    await act(async () => workRow().props.onClick());
    expect(workRow().props['aria-expanded']).toBe(true);
    expect(wrapperOf(row).props.hidden).toBe(false);
  });

  test('a live report turn shows the peer message until the turn settles', () => {
    const html = renderRow(reportTurn, true);
    const row = html.indexOf('data-testid="peer-message-turn"');
    expect(row).toBeGreaterThan(-1);
    // No fold while the turn works: the row renders visible, not hidden.
    expect(html.slice(Math.max(0, row - 300), row)).not.toContain('hidden');
    expect(html).not.toContain('Worked for');
  });

  test('a report turn with no answer keeps the row at the top level', () => {
    const promptRows: V1MessageRow[] = [
      {
        info: { id: 'peer-prompt', sessionID: 'rs', role: 'user', agent: 'build', model: { providerID: 'test', modelID: 'test' }, time: { created: 1 } },
        parts: [{ id: 'peer-text', sessionID: 'rs', messageID: 'peer-prompt', type: 'text', synthetic: true, text: peerPrompt }],
      },
    ];
    const turn = sessionLogTurns(sessionLogOfV1Rows('p', 'rs', promptRows).threads[0]!)[0]!;
    const html = renderRow(turn);
    const row = html.indexOf('data-testid="peer-message-turn"');
    expect(row).toBeGreaterThan(-1);
    // No answer row to fold into: the row renders visible at the top level.
    expect(html.slice(Math.max(0, row - 300), row)).not.toContain('hidden');
    expect(html).not.toContain('Worked for');
  });

  test('a settled notice turn answered inline keeps the row visible above the answer', () => {
    // Inline mode (text + an answered question, no tool steps) turns the
    // fold off: there is no Worked row. The notice row must still render,
    // visible above the inline answer, or the exchange is unreachable.
    const html = renderRow(inlineAnswerTurn);
    const row = html.indexOf('data-testid="peer-message-turn"');
    expect(row).toBeGreaterThan(-1);
    expect(html.slice(Math.max(0, row - 300), row)).not.toContain('hidden');
    expect(html).toContain('Going with the plan-based quote.');
  });
});
