'use client';

/**
 * /debug/notice-fold — KRTX-4732 visual harness.
 *
 * A run of several sub-agents must read as ONE top-level answer: each report
 * turn folds its peer-message row into its own "Worked for" fold, and the
 * last turn's consolidated reply is the only message at the default level.
 * The one exception renders too: a report that needs a decision answers
 * inline (text plus an answered question, no fold row), and its notice row
 * stays visible above that answer. This page seeds the parent transcript of
 * a three-colleague run — the peer message shapes `peerMessagePromptText`
 * writes, the `agent` dispatches and the `send_message` steering calls — and
 * renders it through the real `SessionTurn`, exactly as a live session
 * would. No network, no runtime.
 *
 * Open the run's row to read each child's report and the work it led to.
 * led to. Synthetic values only.
 */

import '@kortix/ui/session/tool/tools/register';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { SessionTurn, TurnViewport, useAgentRunLayout } from '@kortix/ui/session';
import { SESSION_TRANSCRIPT_CLASS } from '@kortix/ui/session/thread/session-body';
import { peerMessagePromptText } from '@kortix/shared';
import { isSessionLogAgentNotice, sessionLogOfV1Rows, sessionLogTurns, type SessionLogTurn } from '@kortix/sdk';
import { useSessionStateStore } from '@kortix/sdk/react';

const SESSION_ID = 'ses_krtx4732_parent';
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

const AGENTS = ['draft-writer', 'metrics-checker', 'post-reviewer'] as const;

type V1Row = Parameters<typeof sessionLogOfV1Rows>[2][number];

const baseInfo = (id: string, at: number) => ({
  id,
  sessionID: SESSION_ID,
  role: 'user' as const,
  agent: 'mykortix',
  model: { providerID: 'mock', modelID: 'mock' },
  time: { created: at },
});

const assistantInfo = (id: string, parentID: string, created: number, completed: number) => ({
  id,
  sessionID: SESSION_ID,
  role: 'assistant' as const,
  parentID,
  agent: 'mykortix',
  modelID: 'mock',
  providerID: 'mock',
  mode: 'mykortix',
  path: { cwd: '/workspace', root: '/workspace' },
  cost: 0.0021,
  tokens: { total: 240, input: 190, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, completed },
});

const toolPart = (mid: string, n: number, tool: string, title: string, input: Record<string, unknown>, output: string, metadata: Record<string, unknown> = {}) => ({
  id: `${mid}-tool-${n}`,
  sessionID: SESSION_ID,
  messageID: mid,
  type: 'tool' as const,
  callID: `call-${mid}-${n}`,
  tool,
  state: {
    status: 'completed' as const,
    input,
    output,
    title,
    metadata,
    time: { start: T0 + 1_000, end: T0 + 4_000 },
  },
});

const textPart = (mid: string, text: string, synthetic = false) => ({
  id: `${mid}-text`,
  sessionID: SESSION_ID,
  messageID: mid,
  type: 'text' as const,
  text,
  synthetic,
});

const report = (mid: string, from: string, summary: string, text: string, created: number, reply: V1Row['parts']): V1Row[] => [
  {
    info: baseInfo(mid, created),
    parts: [
      textPart(
        mid,
        peerMessagePromptText({ kind: 'message', from, fromShortId: 'b445ac6c', messageId: `m_${mid}`, summary, text }),
        true,
      ),
    ],
  },
  {
    info: assistantInfo(`${mid}-reply`, mid, created + 400, created + 5_800),
    parts: reply,
  },
];

/** The parent transcript of one run: a prompt, the dispatch turn, three report turns, one consolidated answer. */
const ROWS: V1Row[] = [
  {
    info: baseInfo('msg_prompt', T0),
    parts: [textPart('msg_prompt', 'Ship the launch post: draft it, check the numbers against the Q3 report, and have it reviewed.')],
  },
  {
    info: assistantInfo('msg_reply_prompt', 'msg_prompt', T0 + 1_000, T0 + 6_400),
    parts: [
      { id: 'msg_reply_prompt-reasoning', sessionID: SESSION_ID, messageID: 'msg_reply_prompt', type: 'reasoning' as const, text: 'Three independent pieces: the draft, the numbers, the review. One colleague each, all in the background; I report back once they have all reported.', time: { start: T0 + 1_000, end: T0 + 3_200 } },
      toolPart('msg_reply_prompt', 1, 'agent', 'Draft the launch post', { subagent_type: 'draft-writer', description: 'Draft the launch post', prompt: 'Draft the launch post. TASK_MARKER_1.' }, 'task_id: ses_krtx4732_draft_writer (for resuming to continue this task if needed)\n\n<task_result>\nStarted.\n</task_result>', { sessionId: 'ses_krtx4732_draft_writer' }),
      toolPart('msg_reply_prompt', 2, 'agent', 'Verify the numbers', { subagent_type: 'metrics-checker', description: 'Verify the numbers', prompt: 'Verify the numbers against the Q3 report. TASK_MARKER_2.' }, 'task_id: ses_krtx4732_metrics_checker (for resuming to continue this task if needed)\n\n<task_result>\nStarted.\n</task_result>', { sessionId: 'ses_krtx4732_metrics_checker' }),
      toolPart('msg_reply_prompt', 3, 'agent', 'Review the post', { subagent_type: 'post-reviewer', description: 'Review the post', prompt: 'Review the post against the style guide. TASK_MARKER_3.' }, 'task_id: ses_krtx4732_post_reviewer (for resuming to continue this task if needed)\n\n<task_result>\nStarted.\n</task_result>', { sessionId: 'ses_krtx4732_post_reviewer' }),
      textPart('msg_reply_prompt', "⏳ Three colleagues are on it — draft, numbers, review. I'll report back when they're done."),
    ],
  },
  ...report(
    'msg_report_draft',
    'draft-writer',
    'Draft v1 posted to the review doc',
    'Draft v1 is up in the review doc. Two open questions for you at the end: the plan line and the pricing anchor. Everything else is complete.',
    T0 + 92_000,
    [
      toolPart('msg_report_draft-reply', 1, 'send_message', 'Message the reviewer', { to: 'post-reviewer', summary: 'Draft v1 is up — review against it', message: 'Draft v1 is in the review doc. Review it against the style guide; the plan line and pricing anchor are still open.' }, '{"status":"delivered","note":"Delivered between its steps."}'),
      // An interim line: the run's answer supersedes it, so it folds with the report.
      { ...textPart('msg_report_draft-reply', 'The draft is in. Waiting on the numbers and the review.'), id: 'msg_report_draft-reply-interim' },
    ],
  ),
  ...report(
    'msg_report_metrics',
    'metrics-checker',
    '5 of 6 numbers match; 1 corrected',
    'Checked all 6 numbers against the Q3 report. 5 match. One off: the post said 4.7M sessions, the report says 4.2M — corrected in my notes for the reviewer.',
    T0 + 168_000,
    [
      toolPart('msg_report_metrics-reply', 1, 'send_message', 'Message the reviewer', { to: 'post-reviewer', summary: 'Use 4.2M sessions, not 4.7M', message: 'Numbers check: use 4.2M sessions (the Q3 report), not 4.7M. Everything else in the draft matches.' }, '{"status":"delivered","note":"Delivered between its steps."}'),
    ],
  ),
  ...report(
    'msg_report_anchor',
    'post-reviewer',
    'The CTA needs a pricing anchor decision',
    'Mid-review: the CTA can anchor on either the plan-based or the usage-based price. Which one should the post quote?',
    T0 + 300_000,
    [
      { id: 'msg_report_anchor-reply-q', sessionID: SESSION_ID, messageID: 'msg_report_anchor-reply', type: 'tool' as const, callID: 'call-msg_report_anchor-reply-q', tool: 'question', state: { status: 'completed' as const, title: 'Ask which anchor to quote', input: { questions: [{ question: 'Which pricing anchor should the post quote?' }] }, output: 'Answered', metadata: { answers: [['Plan-based']] }, time: { start: T0 + 301_000, end: T0 + 304_000 } } },
      textPart('msg_report_anchor-reply', 'Plan-based it is — the CTA quotes the plan price and links the pricing page.'),
    ],
  ),
  ...report(
    'msg_report_review',
    'post-reviewer',
    'Review done, 2 comments, both resolved',
    'Review done. Two comments (the opening line, the CTA wording); both addressed with the writer. The post reads clean and the numbers match the Q3 report.',
    T0 + 402_000,
    [
      textPart('msg_report_review-reply', '✅ The launch post is ready. The reviewer passed it with both comments addressed, and all 6 numbers now match the Q3 report (one was off: 4.2M sessions, not 4.7M). Draft: the review doc.'),
    ],
  ),
];

/** The same run while it is still going: two of the three colleagues have reported. */
const LIVE_ROWS: V1Row[] = ROWS.slice(0, ROWS.findIndex((row) => row.info.id === 'msg_report_anchor'));

/** Minimal child transcripts, so an opened dispatch row shows its session as a live one would. */
const CHILD_ROWS: Record<string, V1Row[]> = Object.fromEntries(
  AGENTS.map((agent, n) => [
    `ses_krtx4732_${agent.replace(/-/g, '_')}`,
    [
      {
        info: { id: `child-${n}-prompt`, sessionID: `ses_krtx4732_${agent.replace(/-/g, '_')}`, role: 'user' as const, agent, time: { created: T0 + 2_000 } },
        parts: [{ id: `child-${n}-text`, sessionID: `ses_krtx4732_${agent.replace(/-/g, '_')}`, messageID: `child-${n}-prompt`, type: 'text' as const, text: `${agent}: start the task.` }],
      },
      {
        info: { id: `child-${n}-reply`, sessionID: `ses_krtx4732_${agent.replace(/-/g, '_')}`, role: 'assistant' as const, parentID: `child-${n}-prompt`, agent, time: { created: T0 + 3_000, completed: T0 + 9_000 } },
        parts: [{ id: `child-${n}-reply-text`, sessionID: `ses_krtx4732_${agent.replace(/-/g, '_')}`, messageID: `child-${n}-reply`, type: 'text' as const, text: `${agent}: on it.` }],
      },
    ] as V1Row[],
  ]),
);

function seed() {
  const store = useSessionStateStore.getState();
  store.hydrate(SESSION_ID, ROWS);
  for (const [childId, rows] of Object.entries(CHILD_ROWS)) store.hydrate(childId, rows);
  store.setStatus(SESSION_ID, { type: 'idle' });
  for (const childId of Object.keys(CHILD_ROWS)) store.setStatus(childId, { type: 'idle' });
  return () => {
    const current = useSessionStateStore.getState();
    current.clearSession(SESSION_ID);
    for (const childId of Object.keys(CHILD_ROWS)) current.clearSession(childId);
  };
}

const NOOP = () => {};
const noopAsync = async () => {};

/** One transcript, laid out as the session view lays it out: a run's other turns draw nothing. */
function Transcript({ title, turns }: { title: string; turns: SessionLogTurn[] }) {
  const runs = useAgentRunLayout(turns, false);
  return (
    <section data-testid={`harness-${title.split(' ')[0]!.toLowerCase()}`} className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-muted-foreground mb-6 text-xs">{title}</p>
      <div role="log" className={SESSION_TRANSCRIPT_CLASS}>
        <div className="flex min-w-0 flex-col">
          {turns.map((turn, turnIndex) => (
            <TurnViewport
              key={turn.id}
              turnId={turn.id}
              className={turnIndex === 0 ? '' : isSessionLogAgentNotice(turn.user) ? 'mt-6' : 'mt-12'}
              continues={turn.compaction !== null || turn.continues !== null}
            >
              {runs.absorbed.has(turn.id) ? null : (
                <SessionTurn
                  turn={turn}
                  turnOutcome={{}}
                  isLast={turnIndex === turns.length - 1}
                  sessionId={SESSION_ID}
                  sessionStatus={undefined}
                  sessionWorking={false}
                  isWorkingTurn={false}
                  suppressBusyIndicator={false}
                  awaitingUser={false}
                  pending={false}
                  isFirstTurn={turnIndex === 0}
                  ownsPlan={false}
                  permissions={[]}
                  questions={[]}
                  onPermissionReply={noopAsync}
                  onRewind={NOOP}
                  rewindDisabled
                  {...runs.propsOf(turn.id)}
                />
              )}
            </TurnViewport>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function NoticeFoldPage() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } }));
  useEffect(() => seed(), []);
  const turns = useMemo(() => sessionLogTurns(sessionLogOfV1Rows(SESSION_ID, SESSION_ID, ROWS).threads[0]!), []);
  const liveTurns = useMemo(() => sessionLogTurns(sessionLogOfV1Rows(SESSION_ID, SESSION_ID, LIVE_ROWS).threads[0]!), []);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="bg-background min-h-dvh">
        <header className="border-border border-b px-4 py-3">
          <p className="text-sm font-medium">Agent run fold — KRTX-4732</p>
          <p className="text-muted-foreground text-xs">
            One run of three colleagues. The reports fold into one row over the answer; open the
            row to read them. The report that needed a decision stays in view. Seeded in-store; no
            runtime attached.
          </p>
        </header>
        <Transcript title="Settled" turns={turns} />
        <Transcript title="Live · two of three reported" turns={liveTurns} />
      </div>
    </QueryClientProvider>
  );
}
