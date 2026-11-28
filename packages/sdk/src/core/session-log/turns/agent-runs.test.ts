import { describe, expect, test } from 'bun:test';
import type { SessionLogBlock, SessionLogMessage, ToolCallBlock } from '../types';
import { isSessionLogAgentNotice, sessionLogAgentRunLabel, sessionLogAgentRuns } from './agent-runs';
import type { SessionLogTurn } from './turn';

// Synthetic values only. The notice texts are what the API writes:
// `subagentNoticeText` (apps/api/src/projects/subagent-notice.ts) and
// `peerMessagePromptText` (@kortix/shared).

// A peer names its session by the first 8 characters, so each child differs there.
const child = (n: number) => `${String(n).padStart(8, '0')}-0b7c-4000-8000-2f1e00000000`;
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 12, 9, 0, 0) + minutes * 60_000).toISOString();

function subagentNotice(n: number): string {
  return [
    'A background subagent you started has finished. This message is from the platform, not from the user.',
    `task_id: ${child(n)}`,
    'status: completed',
    '',
    `<task_result>\nReport ${n}.\n</task_result>`,
  ].join('\n');
}

function peerMessage(from: string, n: number): string {
  return `[message from ${from} · session ${child(n).slice(0, 8)} · #m_${n} · Report ${n}]\nReport ${n} from ${from}.\n\n---\nThis message comes from another session.`;
}

/** A `send_message` the platform delivered to `sessionId` (the result `sendMessage` returns). */
function delivered(id: string, to: string, sessionId: string): ToolCallBlock {
  const data = { status: 'delivered', to: { handle: to.replace(/^@/, ''), session_id: sessionId } };
  return {
    ...call(id, 'send_message'),
    input: { to, message: 'A note.' },
    result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: 'send_message', card: { title: `Message to ${to}`, status: 'done' }, data }) }], is_error: false },
  } as ToolCallBlock;
}

/** A teammate went idle (`firePeerIdleNotices`): its finish, the way a sub-agent notice is. */
function idleNotice(from: string, n: number): string {
  return `[idle notice from ${from} · session ${child(n).slice(0, 8)} · #i_${n}]\n${from} finished its turn and is idle.\n\nIts last answer: Report ${n}.\n\n---\nThis message comes from another session.`;
}

const text = (id: string, body: string): SessionLogBlock => ({ id, type: 'text', text: body });

function call(id: string, name: string, details?: Record<string, unknown>): ToolCallBlock {
  return {
    id,
    type: 'tool_call',
    call_id: id,
    name,
    kind: 'task',
    input: {},
    status: 'complete',
    result: { content: [], is_error: false, ...(details ? { details } : {}) },
  } as ToolCallBlock;
}

function message(id: string, role: 'user' | 'assistant', blocks: SessionLogBlock[], created: string, completed: string | null): SessionLogMessage {
  return { message_id: id, role, kind: 'turn', status: 'complete', created_at: created, completed_at: completed, blocks } as unknown as SessionLogMessage;
}

interface TurnSpec {
  id: string;
  prompt: string;
  /** Minutes after 09:00 the prompt arrived. */
  start: number;
  /** Minutes after 09:00 the reply ended; null = no reply. */
  end?: number | null;
  blocks?: SessionLogBlock[];
  live?: boolean;
  queued?: boolean;
  status?: SessionLogTurn['status'];
}

function turn(spec: TurnSpec): SessionLogTurn {
  const blocks = spec.blocks ?? [];
  const end = spec.end === undefined ? spec.start + 0.1 : spec.end;
  const replies = end === null ? [] : [message(`${spec.id}-reply`, 'assistant', blocks, at(spec.start), at(end))];
  const response = [...blocks].reverse().find((b) => b.type === 'text' && b.text.trim()) ?? null;
  return {
    id: spec.id,
    user: message(spec.id, 'user', [text(`${spec.id}-p`, spec.prompt)], at(spec.start), at(spec.start)),
    assistant: replies,
    partial: false,
    continues: null,
    blocks,
    status: spec.status ?? (end === null ? 'pending' : 'complete'),
    error: null,
    cost: null,
    compaction: null,
    threads: [],
    plan: false,
    shell: null,
    response,
    attachments: [],
    live: spec.live ?? false,
    queued: spec.queued ?? false,
    retrying: false,
    internal: false,
  } as SessionLogTurn;
}

/** The person's prompt that starts three agents. */
const launch = turn({
  id: 'launch',
  prompt: 'Ship the launch post.',
  start: 0,
  end: 0.1,
  blocks: [
    call('a1', 'agent', { sessionId: child(1) }),
    call('a2', 'agent', { sessionId: child(2) }),
    call('a3', 'agent', { sessionId: child(3) }),
    text('ack', 'Three colleagues are on it.'),
  ],
});

const report = (id: string, prompt: string, start: number, blocks: SessionLogBlock[] = [], extra: Partial<TurnSpec> = {}) =>
  turn({ id, prompt, start, end: start + 0.1, blocks, ...extra });

describe('isSessionLogAgentNotice', () => {
  test('a sub-agent notice, a peer message and a batch are notices; a person prompt is not', () => {
    expect(isSessionLogAgentNotice(turn({ id: 'x', prompt: subagentNotice(1), start: 0 }).user)).toBe(true);
    expect(isSessionLogAgentNotice(turn({ id: 'x', prompt: peerMessage('writer', 1), start: 0 }).user)).toBe(true);
    expect(isSessionLogAgentNotice(turn({ id: 'x', prompt: `${subagentNotice(1)}\n\n${subagentNotice(2)}`, start: 0 }).user)).toBe(true);
    expect(isSessionLogAgentNotice(launch.user)).toBe(false);
  });
});

describe('sessionLogAgentRuns', () => {
  test('silent reports fold into the turn that answers: one run, anchored on the answer', () => {
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2),
      report('r2', idleNotice('checker', 2), 3),
      report('r3', subagentNotice(3), 5, [text('final', 'The launch post is ready.')]),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect([...layout.absorbed]).toEqual(['r1', 'r2']);
    expect(layout.anchorOf.get('r1')).toBe('r3');
    expect(layout.anchorOf.get('r2')).toBe('r3');
    const run = layout.runs.get('r3')!;
    expect(run.turns).toEqual(['r1', 'r2', 'r3']);
    expect(run.agents).toBe(3);
    expect(run.started).toBe(3);
    expect(run.reported).toBe(3);
    expect(run.live).toBe(false);
    // From the end of the launch reply (09:00:06) to the end of the answer (09:05:06).
    expect(run.durationMs).toBe(5 * 60_000);
    expect(sessionLogAgentRunLabel(run)).toBe('Worked for 5m · 3 agents');
  });

  test('a notice the harness delivered as synthetic text (an internal turn) still joins its run', () => {
    const internal = (t: SessionLogTurn) => ({ ...t, internal: true });
    const turns = [
      launch,
      internal(report('r1', subagentNotice(1), 2)),
      internal(report('r2', subagentNotice(2), 3)),
      internal(report('r3', subagentNotice(3), 5, [text('f', 'Done.')])),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect([...layout.absorbed]).toEqual(['r1', 'r2']);
    expect(layout.runs.get('r3')!.agents).toBe(3);
  });

  test('every agent reported and the run settled: the launch turn folds its agent rows', () => {
    const turns = [launch, report('r1', subagentNotice(1), 2), report('r2', subagentNotice(2), 3), report('r3', subagentNotice(3), 5, [text('f', 'Done.')])];
    expect([...sessionLogAgentRuns(turns).settledLaunches]).toEqual(['launch']);
  });

  test('a turn with an interim answer joins the run too: the host keeps its answer in view under the run row', () => {
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2, [text('i1', 'Got the draft, waiting on the numbers.')]),
      report('r2', subagentNotice(2), 3),
      report('r3', subagentNotice(3), 5, [text('f', 'Done.')]),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect([...layout.absorbed]).toEqual(['r1', 'r2']);
    expect(layout.runs.get('r3')!.turns).toEqual(['r1', 'r2', 'r3']);
  });

  test('a run still waiting on an agent is live, and the launch keeps its rows', () => {
    const turns = [launch, report('r1', subagentNotice(1), 2), report('r2', idleNotice('checker', 2), 3)];
    const layout = sessionLogAgentRuns(turns);
    const run = layout.runs.get('r2')!;
    expect([...layout.absorbed]).toEqual(['r1']);
    expect(run.live).toBe(true);
    expect(run.reported).toBe(2);
    expect(run.started).toBe(3);
    expect(sessionLogAgentRunLabel(run)).toBe('Working · 2 of 3 agents reported');
    expect(layout.settledLaunches.size).toBe(0);
  });

  test('the agent turn that is working keeps the run live', () => {
    const turns = [launch, report('r1', subagentNotice(1), 2), report('r2', subagentNotice(2), 3), turn({ id: 'r3', prompt: subagentNotice(3), start: 5, end: null, live: true })];
    const run = sessionLogAgentRuns(turns).runs.get('r3')!;
    expect(run.live).toBe(true);
    expect(sessionLogAgentRunLabel(run)).toBe('Working · 3 of 3 agents reported');
  });

  test('a stopped run says so', () => {
    const turns = [launch, report('r1', subagentNotice(1), 2), report('r2', subagentNotice(2), 3, [], { status: 'aborted' })];
    const run = sessionLogAgentRuns(turns).runs.get('r2')!;
    expect(run.stopped).toBe(true);
    expect(run.live).toBe(false);
    expect(sessionLogAgentRunLabel(run)).toBe('Stopped · 2 of 3 agents reported');
  });

  test('a person prompt ends the run', () => {
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2),
      turn({ id: 'p2', prompt: 'How is it going?', start: 3, blocks: [text('s', 'Two are still out.')] }),
      report('r2', subagentNotice(2), 4),
      report('r3', subagentNotice(3), 5, [text('f', 'Done.')]),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect([...layout.absorbed]).toEqual(['r2']);
    expect(layout.runs.get('r1')!.turns).toEqual(['r1']);
    expect(layout.runs.get('r3')!.turns).toEqual(['r2', 'r3']);
  });

  test('a report that needs the person stays out of every run and splits it', () => {
    const question = { ...call('q', 'question'), input: { questions: [{ question: 'Which anchor?' }] } } as ToolCallBlock;
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2),
      report('r2', subagentNotice(2), 3),
      report('decide', peerMessage('reviewer', 3), 4, [question, text('a', 'Plan-based it is.')]),
      report('r3', subagentNotice(3), 5, [text('f', 'Done.')]),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect(layout.runs.has('decide')).toBe(false);
    expect(layout.absorbed.has('decide')).toBe(false);
    expect(layout.runs.get('r2')!.turns).toEqual(['r1', 'r2']);
    expect(layout.runs.get('r3')!.turns).toEqual(['r3']);
  });

  test('a report that hands over a deliverable stays out of every run', () => {
    const turns = [launch, report('r1', subagentNotice(1), 2), report('show', subagentNotice(2), 3, [call('s', 'show')]), report('r3', subagentNotice(3), 5, [text('f', 'Done.')])];
    const layout = sessionLogAgentRuns(turns);
    expect(layout.runs.has('show')).toBe(false);
    expect(layout.absorbed.has('show')).toBe(false);
  });

  test('a report that starts a connector sign-in stays out of every run: its Connect card waits on the person', () => {
    const connect = { ...call('c', 'bash'), input: { command: 'kortix connectors connect gmail' } } as ToolCallBlock;
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2),
      report('connect', subagentNotice(2), 3, [connect, text('a', 'Click Connect on the card.')]),
      report('r3', subagentNotice(3), 5, [text('f', 'Done.')]),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect(layout.runs.has('connect')).toBe(false);
    expect(layout.absorbed.has('connect')).toBe(false);
  });

  test('a single report is a run of one: nothing is absorbed', () => {
    const turns = [launch, report('r1', subagentNotice(1), 4, [text('f', 'The draft is in.')])];
    const layout = sessionLogAgentRuns(turns);
    expect(layout.absorbed.size).toBe(0);
    expect(layout.runs.get('r1')!.agents).toBe(1);
  });

  test('a batch counts each agent once, and an agent that reported twice counts once', () => {
    const turns = [
      launch,
      report('r1', peerMessage('writer', 1), 2),
      report('r2', `${subagentNotice(1)}\n\n${subagentNotice(2)}`, 3),
      report('r3', subagentNotice(3), 5, [text('f', 'Done.')]),
    ];
    const run = sessionLogAgentRuns(turns).runs.get('r3')!;
    expect(run.agents).toBe(3);
    expect(run.reported).toBe(3);
  });

  test('a peer resolves to the agent it is by its handle when its short id names no launched session', () => {
    const named = turn({
      id: 'launch',
      prompt: 'Ship the launch post.',
      start: 0,
      end: 0.1,
      blocks: [
        { ...call('a1', 'agent', { sessionId: 'ses_writer' }), input: { name: 'draft-writer', subagent_type: 'writer' } } as ToolCallBlock,
        { ...call('a2', 'agent', { sessionId: 'ses_checker' }), input: { subagent_type: 'metrics-checker' } } as ToolCallBlock,
        text('ack', 'On it.'),
      ],
    });
    const turns = [
      named,
      // The writer messages, then its finish notice arrives: one agent, not two.
      report('r1', peerMessage('draft-writer', 91), 2),
      report('r2', peerMessage('metrics-checker', 92), 3),
      report('r3', subagentNotice(1).replace(child(1), 'ses_writer'), 5, [text('f', 'Done.')]),
    ];
    const layout = sessionLogAgentRuns(turns);
    // A message from an agent this session started is progress: the run stays open until it finishes.
    const run = layout.runs.get('r3')!;
    expect(run.turns).toEqual(['r1', 'r2', 'r3']);
    // The writer's message and its finish notice are one agent, not two.
    expect(run.agents).toBe(2);
    expect(run.started).toBe(2);
    // Only the writer finished: the checker only sent a message, so the launch keeps its rows.
    expect(run.reported).toBe(1);
    expect(layout.settledLaunches.size).toBe(0);
  });

  test('a colleague that reports progress by message stays one run until its finish notice', () => {
    const one = turn({ id: 'launch', prompt: 'Write the plan, check in after each section.', start: 0, end: 0.1, blocks: [call('a1', 'agent', { sessionId: child(1) }), text('ack', 'On it.')] });
    const sections = [1, 2, 3].map((n) => report(`s${n}`, peerMessage('writer', 1).replace('Report 1', `Section ${n}`), n, [text(`a${n}`, `Section ${n} is in.`)]));
    const live = sessionLogAgentRuns([one, ...sections]);
    // Three progress messages: one run, still working, nothing settled.
    expect([...live.runs.keys()]).toEqual(['s3']);
    expect(live.runs.get('s3')!.turns).toEqual(['s1', 's2', 's3']);
    expect(live.runs.get('s3')!.live).toBe(true);
    expect(live.settledLaunches.size).toBe(0);
    const done = sessionLogAgentRuns([one, ...sections, report('fin', subagentNotice(1), 5, [text('f', 'The plan is saved.')])]);
    expect([...done.runs.keys()]).toEqual(['fin']);
    expect(done.runs.get('fin')!.turns).toEqual(['s1', 's2', 's3', 'fin']);
    expect(done.runs.get('fin')!.live).toBe(false);
    expect([...done.settledLaunches]).toEqual(['launch']);
  });

  test('a colleague continued in a new turn is working again: its earlier report does not settle the new hand-off', () => {
    const first = turn({ id: 'launch', prompt: 'Write the plan.', start: 0, end: 0.1, blocks: [call('a1', 'agent', { sessionId: child(1) }), text('ack', 'On it.')] });
    const done = report('fin', subagentNotice(1), 2, [text('f', 'The plan is saved.')]);
    const again = turn({ id: 'again', prompt: 'Lead with the money-first hook instead.', start: 3, end: 3.1, blocks: [call('a2', 'agent', { sessionId: child(1) }), text('ack2', 'Sent it back to the writer.')] });
    const layout = sessionLogAgentRuns([first, done, again]);
    expect(layout.settledLaunches.has('launch')).toBe(true);
    expect(layout.settledLaunches.has('again')).toBe(false);
    const finished = sessionLogAgentRuns([first, done, again, report('fin2', subagentNotice(1), 5, [text('f2', 'Updated.')])]);
    expect(finished.settledLaunches.has('again')).toBe(true);
  });

  test('no launch in sight: the run starts at its first report, and the label has no total', () => {
    const turns = [report('r1', peerMessage('writer', 7), 2), report('r2', peerMessage('checker', 8), 4, [text('f', 'Done.')])];
    const run = sessionLogAgentRuns(turns).runs.get('r2')!;
    expect(run.started).toBe(0);
    expect(run.durationMs).toBe(2 * 60_000 + 6_000);
    expect(sessionLogAgentRunLabel(run)).toBe('Worked for 2m 6s · 2 agents');
    expect(sessionLogAgentRunLabel({ ...run, live: true })).toBe('Working · 2 agents reported');
  });

  test('one agent reads singular', () => {
    // The launch reply ends at 09:00:06; the answer ends at 09:01:00.
    const one = turn({ id: 'launch', prompt: 'Ship it.', start: 0, end: 0.1, blocks: [call('a1', 'agent', { sessionId: child(1) }), text('ack', 'On it.')] });
    const turns = [one, report('r1', subagentNotice(1), 0.9, [text('f', 'Done.')])];
    expect(sessionLogAgentRunLabel(sessionLogAgentRuns(turns).runs.get('r1')!)).toBe('Worked for 54s · 1 agent');
  });

  test('a queued notice joins no run: the turn that is streaming stays the anchor', () => {
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2),
      turn({ id: 'r2', prompt: subagentNotice(2), start: 3, end: null, live: true }),
      turn({ id: 'q3', prompt: subagentNotice(3), start: 4, end: null, queued: true }),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect([...layout.absorbed]).toEqual(['r1']);
    expect(layout.runs.get('r2')!.live).toBe(true);
    expect(layout.runs.has('q3')).toBe(false);
  });

  test('a queued person prompt leaves a working run working', () => {
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2),
      turn({ id: 'r2', prompt: subagentNotice(2), start: 3, end: null, live: true }),
      turn({ id: 'p3', prompt: 'Also add a hero image.', start: 4, end: null, queued: true }),
    ];
    const run = sessionLogAgentRuns(turns).runs.get('r2')!;
    expect(run.live).toBe(true);
    expect(sessionLogAgentRunLabel(run)).toBe('Working · 2 of 3 agents reported');
  });

  test('an answer that renders a card ends its run: it anchors and is never absorbed', () => {
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2),
      report('r2', subagentNotice(2), 3, [text('c', 'Connect GitHub: /connect/ksl_x')]),
      report('r3', subagentNotice(3), 5, [text('f', 'Done.')]),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect(layout.absorbed.has('r2')).toBe(false);
    expect(layout.runs.get('r2')!.turns).toEqual(['r1', 'r2']);
    expect(layout.runs.get('r3')!.turns).toEqual(['r3']);
  });

  test('a turn that ended on an error ends its run and anchors it as stopped', () => {
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2, [], { status: 'error' }),
      report('r2', subagentNotice(2), 3),
      report('r3', subagentNotice(3), 5, [text('f', 'Done.')]),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect(layout.absorbed.has('r1')).toBe(false);
    expect(layout.runs.get('r1')!.stopped).toBe(true);
    expect(layout.runs.get('r3')!.turns).toEqual(['r2', 'r3']);
  });

  test('a launch with a workflow still running is not settled', () => {
    const withWorkflow = { ...launch, blocks: [...launch.blocks, { ...call('w', 'workflow'), status: 'running' } as ToolCallBlock] };
    const turns = [withWorkflow, report('r1', subagentNotice(1), 2), report('r2', subagentNotice(2), 3), report('r3', subagentNotice(3), 5, [text('f', 'Done.')])];
    expect(sessionLogAgentRuns(turns).settledLaunches.size).toBe(0);
  });

  test('the run ends where the last agent reports: a late notice after the full answer never hides it', () => {
    const turns = [
      launch,
      report('r1', subagentNotice(1), 2),
      report('r2', subagentNotice(2), 3),
      report('r3', subagentNotice(3), 5, [text('f', 'All three are back: the post, the numbers, the review.')]),
      report('late', peerMessage('checker', 2), 6, [text('n', 'Nothing changed: the answers above stand.')]),
    ];
    const layout = sessionLogAgentRuns(turns);
    expect(layout.runs.get('r3')!.turns).toEqual(['r1', 'r2', 'r3']);
    expect(layout.absorbed.has('r3')).toBe(false);
    expect(layout.runs.get('late')!.turns).toEqual(['late']);
    // The late run's time starts where the full answer ended, not at the launch.
    expect(layout.runs.get('late')!.durationMs).toBe(60_000);
  });

  test('a note sent to a colleague this session started hands it work again: the turn settles when it finishes again', () => {
    const first = turn({ id: 'launch', prompt: 'Write the plan.', start: 0, end: 0.1, blocks: [{ ...call('a1', 'agent', { sessionId: child(1) }), input: { name: 'gtm-writer' } } as ToolCallBlock, text('ack', 'On it.')] });
    const done = report('fin', subagentNotice(1), 2, [text('f', 'The plan is saved.')]);
    const note = turn({ id: 'steer', prompt: 'Lead with the money-first hook instead.', start: 3, end: 3.1, blocks: [delivered('s1', 'gtm-writer', child(1)), text('ack2', 'Sent it to the writer.')] });
    const working = sessionLogAgentRuns([first, done, note]);
    expect(working.settledLaunches.has('steer')).toBe(false);
    const finished = sessionLogAgentRuns([first, done, note, report('fin2', subagentNotice(1), 5, [text('f2', 'Updated.')])]);
    expect(finished.settledLaunches.has('steer')).toBe(true);
    expect(finished.runs.get('fin2')!.started).toBe(1);
  });

  test('a report answered by handing the colleague more work stays out of every run, and the colleague is out again', () => {
    const first = turn({ id: 'launch', prompt: 'Write the plan.', start: 0, end: 0.1, blocks: [{ ...call('a1', 'agent', { sessionId: child(1) }), input: { name: 'gtm-writer' } } as ToolCallBlock, text('ack', 'On it.')] });
    // The finish arrives, and the answer to it hands the writer the next part (by `@handle`).
    const back = report('fin', subagentNotice(1), 2, [delivered('s1', '@gtm-writer', child(1)), text('f', 'Section 1 is in; the writer is on pricing.')]);
    const layout = sessionLogAgentRuns([first, back]);
    // The turn draws on its own, so its note to the writer stays in view while the writer works.
    expect(layout.runs.size).toBe(0);
    expect(layout.absorbed.size).toBe(0);
    expect(layout.settledLaunches.has('fin')).toBe(false);
    // The next progress message from the writer is not a finished run of its own.
    const progress = report('p1', peerMessage('gtm-writer', 1), 3, [text('p', 'Pricing is half done.')]);
    const next = sessionLogAgentRuns([first, back, progress]);
    expect(next.runs.get('p1')!.live).toBe(true);
  });

  test('a note to a session this one did not start waits on nothing: its turn is settled at once', () => {
    const note = turn({ id: 'tell', prompt: 'Tell the other session we ship Friday.', start: 0, end: 0.1, blocks: [{ ...call('s1', 'send_message'), input: { to: 'release-notes', message: 'We ship Friday.' } } as ToolCallBlock, text('ack', 'Told it.')] });
    expect(sessionLogAgentRuns([note]).settledLaunches.has('tell')).toBe(true);
  });

  test('a batch that starts with an idle notice still counts every finish in it', () => {
    const turns = [launch, report('b', `${idleNotice('checker', 2)}\n\n${subagentNotice(1)}\n\n${subagentNotice(3)}`, 3, [text('f', 'All three are back.')])];
    const run = sessionLogAgentRuns(turns).runs.get('b')!;
    expect(run.reported).toBe(3);
    expect(run.live).toBe(false);
  });

  test('a question about something else does not forget a colleague that is still out', () => {
    const one = turn({ id: 'launch', prompt: 'Write the plan.', start: 0, end: 0.1, blocks: [{ ...call('a1', 'agent', { sessionId: child(1) }), input: { name: 'gtm-writer' } } as ToolCallBlock, text('ack', 'On it.')] });
    const aside = turn({ id: 'aside', prompt: 'What time is it in Berlin?', start: 1, end: 1.1, blocks: [text('t', 'It is 14:00 in Berlin.')] });
    const progress = report('p1', peerMessage('gtm-writer', 1), 2, [text('p', 'Section 1 is in.')]);
    const layout = sessionLogAgentRuns([one, aside, progress]);
    expect(layout.runs.get('p1')!.live).toBe(true);
    expect(layout.runs.get('p1')!.started).toBe(1);
  });

  test('a note to an unnamed colleague by its generated handle hands it work again', () => {
    const first = turn({ id: 'launch', prompt: 'Write the plan.', start: 0, end: 0.1, blocks: [{ ...call('a1', 'agent', { sessionId: child(1) }), input: { subagent_type: 'writer' } } as ToolCallBlock, text('ack', 'On it.')] });
    const done = report('fin', subagentNotice(1), 2, [text('f', 'Saved.')]);
    const note = turn({ id: 'steer', prompt: 'Add risks.', start: 3, end: 3.1, blocks: [{ ...call('s1', 'send_message'), status: 'running', result: undefined, input: { to: `writer-${child(1).slice(0, 8)}`, message: 'Add risks.' } } as ToolCallBlock, text('ack2', 'Sent.')] });
    expect(sessionLogAgentRuns([first, done, note]).settledLaunches.has('steer')).toBe(false);
  });

  test('a note that did not arrive hands nobody work: refused, or delivered to another session of the same name', () => {
    const named = { ...call('a1', 'agent', { sessionId: child(1) }), input: { name: 'gtm-writer' } } as ToolCallBlock;
    const first = turn({ id: 'launch', prompt: 'Write the plan.', start: 0, end: 0.1, blocks: [named, text('ack', 'On it.')] });
    const done = report('fin', subagentNotice(1), 2, [text('f', 'Saved.')]);
    const sent = (id: string, data: Record<string, unknown>) =>
      ({ ...call(id, 'send_message'), input: { to: 'gtm-writer', message: 'Add risks.' }, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: 'send_message', card: { title: 'Message to gtm-writer', status: 'done' }, data }) }], is_error: false } }) as ToolCallBlock;
    const refused = turn({ id: 'refused', prompt: 'Add risks.', start: 3, end: 3.1, blocks: [sent('s1', { status: 'refused', note: 'It refuses messages.' }), text('a', 'It refused.')] });
    const elsewhere = turn({ id: 'elsewhere', prompt: 'Tell the other writer.', start: 4, end: 4.1, blocks: [sent('s2', { status: 'delivered', to: { handle: 'gtm-writer', session_id: 'ffffffff-0b7c-4000-8000-2f1e00000000' } }), text('b', 'Told it.')] });
    const layout = sessionLogAgentRuns([first, done, refused, elsewhere]);
    expect(layout.settledLaunches.has('refused')).toBe(true);
    expect(layout.settledLaunches.has('elsewhere')).toBe(true);
    // The writer was handed nothing, so its next message is a run of its own, not a working one.
    const later = sessionLogAgentRuns([first, done, refused, elsewhere, report('p', peerMessage('gtm-writer', 1), 5, [text('c', 'Noted.')])]);
    expect(later.runs.get('p')!.live).toBe(false);
  });

  test('a colleague this session stopped is finished: the stop is its last word, no notice follows', () => {
    const named = { ...call('a1', 'agent', { sessionId: child(1) }), input: { name: 'gtm-writer' } } as ToolCallBlock;
    const first = turn({ id: 'launch', prompt: 'Write the plan.', start: 0, end: 0.1, blocks: [named, text('ack', 'On it.')] });
    const progress = report('p1', peerMessage('gtm-writer', 1), 1, [text('p', 'Section 1 is in.')]);
    const stop = turn({ id: 'stop', prompt: 'Stop the writer.', start: 2, end: 2.1, blocks: [{ ...call('t1', 'task_stop'), input: { name: 'gtm-writer' }, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: 'task_stop', card: { title: 'Stopped gtm-writer', status: 'done' }, data: { sessionId: child(1), handle: 'gtm-writer', stopped: true } }) }], is_error: false } } as ToolCallBlock, text('s', 'Stopped it.')] });
    const aside = turn({ id: 'aside', prompt: 'Anything else?', start: 3, end: 3.1, blocks: [text('n', 'No.')] });
    const layout = sessionLogAgentRuns([first, progress, stop, aside]);
    expect(layout.settledLaunches.has('launch')).toBe(true);
    // A late message from it after the stop is not a run waiting on it.
    const late = sessionLogAgentRuns([first, progress, stop, aside, report('p2', peerMessage('gtm-writer', 1), 4, [text('q', 'ok')])]);
    expect(late.runs.get('p2')!.live).toBe(false);
  });

  test('a note the platform answered without delivering it hands nobody work, even to a colleague it names', () => {
    const named = { ...call('a1', 'agent', { sessionId: child(1) }), input: { name: 'gtm-writer' } } as ToolCallBlock;
    const first = turn({ id: 'launch', prompt: 'Write the plan.', start: 0, end: 0.1, blocks: [named, text('ack', 'On it.')] });
    const done = report('fin', subagentNotice(1), 2, [text('f', 'Saved.')]);
    const failed = { ...call('s1', 'send_message'), input: { to: 'gtm-writer', message: '' }, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: 'send_message', card: { title: 'Not sent', status: 'error' }, error: { kind: 'invalid', message: 'message is empty' } }) }], is_error: true } } as ToolCallBlock;
    const note = turn({ id: 'steer', prompt: 'Nudge it.', start: 3, end: 3.1, blocks: [failed, text('a', 'It did not go through.')] });
    expect(sessionLogAgentRuns([first, done, note]).settledLaunches.has('steer')).toBe(true);
  });

  test('a note to another session does not settle a turn whose workflow still runs', () => {
    const running = { ...call('w1', 'workflow'), status: 'running', result: undefined } as ToolCallBlock;
    const note = turn({ id: 'both', prompt: 'Run the audit and tell release-notes.', start: 0, end: 0.1, blocks: [running, delivered('s1', 'release-notes', 'ffffffff-0b7c-4000-8000-2f1e00000000'), text('a', 'Running.')] });
    expect(sessionLogAgentRuns([note]).settledLaunches.has('both')).toBe(false);
  });

  test('a transcript without agents has no runs', () => {
    const layout = sessionLogAgentRuns([launch, turn({ id: 'p2', prompt: 'Thanks', start: 1, blocks: [text('t', 'Anytime.')] })]);
    expect(layout.runs.size).toBe(0);
    expect(layout.absorbed.size).toBe(0);
    expect(layout.settledLaunches.size).toBe(0);
  });
});
