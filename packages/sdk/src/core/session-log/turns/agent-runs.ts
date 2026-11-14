/**
 * Agent runs: the reports a person's agents send back, read as one unit (KRTX-4732).
 *
 * The agent hands work to colleagues, and each colleague's report arrives as its own turn (a
 * sub-agent's notice, a teammate's message, a batch of those). Drawn one by one, the internal
 * exchange buries the answer. A **run** is a sequence of those report turns with no person's
 * prompt between them. Its last turn is the **anchor**: it draws the run. The other turns of the
 * run are **absorbed**: a host draws no row for them. Their reports and work fold into the
 * anchor's "Worked for 5m · 3 agents" row, and their answers stay in view under it, in order,
 * above the anchor's own. The agent may answer in full before the last report arrives, so no
 * answer is ever folded away.
 *
 * Rules (`agent-runs.test.ts`):
 * - A person's prompt ends the run. So does a report turn that needs the person (it asks a
 *   question, hands over a deliverable, or renders a card); that turn stays out of every run.
 * - The turn where the last agent of the stretch reports ends its run: it carries the full answer.
 *   A later notice (an agent that reports again) is a run of its own and never folds it away.
 * - A turn whose answer renders a card, or that stopped, ends its run as its anchor.
 * - A queued turn joins no run and ends none.
 * - Live: the anchor is working, or it has no answer yet while an agent of this stretch (started
 *   since the last person's prompt) has not reported. Only the transcript's last run can be live.
 * - Stopped: the anchor ended aborted or on an error.
 * - A launch turn (one that started agents) is settled once every agent it started has reported
 *   and the turns holding those reports have settled: a host folds its agent rows then.
 * - The run's time runs from the end of the turn before it (the launch) to the end of the anchor.
 *
 * Framework-free: web and mobile draw the same runs.
 */
import { getChildSessionId } from '../../turns/parts';
import { parsePeerMessagePrompt } from '../../turns/peer-message-prompt';
import { textRendersCard } from '../../turns/segments/card-text';
import { callStartsConnectorSignIn } from '../../turns/segments/sign-in-call';
import { isNoGroupActivityTool, isQuestionTool, normalizeActivityToolName } from '../../turns/segments/session-activity-groups';
import { STARTED_WORK_TOOLS } from '../../turns/segments/started-work';
import { formatDuration } from '../../turns/state';
import { parseNoticeBatch, parseSubagentNotice } from '../../turns/subagent-notice';
import type { SessionLogMessage, ToolCallBlock } from '../types';
import type { SessionLogTurn } from './turn';

export interface SessionLogAgentRun {
  /** The turn that answers the run (the last one): the host draws the run's row on it. */
  anchor: string;
  /** Every turn of the run, in order, the anchor last. */
  turns: string[];
  /** Distinct agents that reported in this run. */
  agents: number;
  /** Agents started since the last person's prompt (0 when none is in sight). */
  started: number;
  /** Of those, the agents that have reported so far. */
  reported: number;
  /** The run's time: the end of the turn before it to the end of the anchor. Null while live or unknown. */
  durationMs: number | null;
  live: boolean;
  stopped: boolean;
}

export interface SessionLogAgentRuns {
  /** Every run, keyed by its anchor turn id. */
  runs: ReadonlyMap<string, SessionLogAgentRun>;
  /** The turns a host draws no row for: their reports and work fold into their anchor's row, their answers stay under it. */
  absorbed: ReadonlySet<string>;
  /** Each absorbed turn's anchor. */
  anchorOf: ReadonlyMap<string, string>;
  /** The turns that started agents, every one of which has reported in a settled turn: a host folds their agent rows. */
  settledLaunches: ReadonlySet<string>;
}

/** The prompt texts of a message: its text blocks and the text a `harness` block carries. */
function promptTexts(message: SessionLogMessage): string[] {
  return message.blocks.flatMap((b): string[] => {
    if (b.type === 'text') return [b.text];
    if (b.type !== 'harness' || b.kind !== 'text') return [];
    const data = b.data as { text?: unknown } | null;
    return typeof data?.text === 'string' ? [data.text] : [];
  });
}

/** A reporter: the child session a notice names, else the peer's short session id and handle. */
type Reporter = { sessionId: string } | { shortId: string; handle: string };

function reportersOf(message: SessionLogMessage): Reporter[] | null {
  for (const text of promptTexts(message)) {
    const peer = parsePeerMessagePrompt(text);
    if (peer) return [{ shortId: peer.fromShortId, handle: peer.from }];
    const batch = parseNoticeBatch(text);
    if (batch && batch.length > 1) {
      return batch.map((item) =>
        item.kind === 'peer_idle' ? { shortId: item.info.fromShortId, handle: item.info.from } : { sessionId: item.notice.sessionId },
      );
    }
    const notice = parseSubagentNotice(text);
    if (notice) return [{ sessionId: notice.sessionId }];
  }
  return null;
}

/** The prompt is another agent's notice (a sub-agent or teammate that finished, a peer message, a batch), not a person's message. */
export function isSessionLogAgentNotice(message: SessionLogMessage): boolean {
  return reportersOf(message) !== null;
}

/** An agent a turn started: its session, and the handles a peer message may name it by (`name`, `subagent_type`). */
interface Child {
  id: string;
  handles: string[];
}

const childrenOf = (turn: SessionLogTurn): Child[] =>
  turn.blocks.flatMap((b): Child[] => {
    if (b.type !== 'tool_call') return [];
    const id = getChildSessionId(b);
    if (!id) return [];
    const input = (b.input ?? {}) as { name?: unknown; subagent_type?: unknown };
    const handles = [input.name, input.subagent_type].filter((h): h is string => typeof h === 'string' && !!h);
    return [{ id, handles }];
  });

/** The turn asks the person something, hands over a deliverable, or renders a card before its answer. */
function needsPerson(turn: SessionLogTurn): boolean {
  return turn.blocks.some((b) => {
    if (b.type === 'tool_call') {
      return (
        isQuestionTool(b.name) ||
        isNoGroupActivityTool(b.name) ||
        callStartsConnectorSignIn(b)
      );
    }
    return b.type === 'text' && b !== turn.response && textRendersCard(b.text);
  });
}

/** The turn's answer renders a card, or the turn stopped: it must stay in view, so it anchors its run and ends it. */
const endsRun = (turn: SessionLogTurn): boolean =>
  turn.status === 'aborted' || turn.status === 'error' || (!!turn.response && textRendersCard(turn.response.text));

/** Work the turn started that no report will close (a workflow), still running. */
const runsUntracked = (turn: SessionLogTurn): boolean =>
  turn.blocks.some(
    (b) =>
      b.type === 'tool_call' &&
      STARTED_WORK_TOOLS.has(normalizeActivityToolName(b.name)) &&
      !getChildSessionId(b) &&
      (b.status === 'pending' || b.status === 'running'),
  );

/** The latest agent started under `handle` (no `findLast`: the core runs on older engines too). */
function lastNamed(children: readonly Child[], handle: string): Child | undefined {
  for (let i = children.length - 1; i >= 0; i--) if (children[i]!.handles.includes(handle)) return children[i];
  return undefined;
}

const ended = (turn: SessionLogTurn): string | null => turn.assistant.at(-1)?.completed_at ?? null;
const ms = (iso: string | null): number | null => {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : null;
};

interface OpenRun {
  turns: SessionLogTurn[];
  reporters: Set<string>;
  startedAt: string | null;
}

/** The runs of a transcript. See the module comment for the rules. */
export function sessionLogAgentRuns(turns: readonly SessionLogTurn[]): SessionLogAgentRuns {
  const runs = new Map<string, SessionLogAgentRun>();
  const absorbed = new Set<string>();
  const anchorOf = new Map<string, string>();
  /** Every agent ever started, so a peer resolves to its session by short id, else by handle. */
  const launched: Child[] = [];
  /** Child id → the index of the turn that carried its report. */
  const reportedAt = new Map<string, number>();
  const launches: Array<{ id: string; children: string[]; untracked: boolean }> = [];
  let stretchStarted = new Set<string>();
  let stretchReported = new Set<string>();
  let previousEnd: string | null = null;
  let open: OpenRun | null = null;
  /** The last turn the thread placed: only queued turns may follow it. */
  let lastPlaced = -1;
  turns.forEach((t, i) => {
    if (!t.queued) lastPlaced = i;
  });

  const close = (tail: boolean) => {
    if (!open) return;
    const anchor = open.turns.at(-1)!;
    const stopped = anchor.status === 'aborted' || anchor.status === 'error';
    const waiting = [...stretchStarted].some((id) => !stretchReported.has(id));
    // A working anchor is live wherever it is; one still waiting on a report only at the tail.
    const live = !stopped && (anchor.live || (tail && !anchor.response && waiting));
    const start = ms(open.startedAt);
    const end = ms(ended(anchor));
    runs.set(anchor.id, {
      anchor: anchor.id,
      turns: open.turns.map((t) => t.id),
      agents: open.reporters.size,
      started: stretchStarted.size,
      reported: stretchReported.size,
      durationMs: live || start === null || end === null ? null : Math.max(0, end - start),
      live,
      stopped,
    });
    for (const turn of open.turns.slice(0, -1)) {
      absorbed.add(turn.id);
      anchorOf.set(turn.id, anchor.id);
    }
    previousEnd = ended(anchor);
    open = null;
  };

  turns.forEach((turn, index) => {
    // An inbox prompt the thread has not placed yet joins no run and ends none.
    if (turn.queued) return;
    // A notice arrives as synthetic text, so its turn is `internal`: read the prompt, not the flag.
    const reporters = turn.compaction ? null : reportersOf(turn.user);
    const children = childrenOf(turn);
    const ids = children.map((c) => c.id);
    if (!reporters) {
      close(false);
      stretchStarted = new Set(ids);
      stretchReported = new Set();
      if (ids.length) launches.push({ id: turn.id, children: ids, untracked: runsUntracked(turn) });
      launched.push(...children);
      previousEnd = ended(turn);
      return;
    }
    for (const id of ids) stretchStarted.add(id);
    launched.push(...children);
    const keys = reporters.map((r) => {
      // The latest agent of that name wins: a name is reused once its agent ended.
      const id =
        'sessionId' in r
          ? r.sessionId
          : (launched.find((c) => c.id.startsWith(r.shortId)) ?? lastNamed(launched, r.handle))?.id;
      if (!id) return `peer:${'handle' in r ? r.handle : ''}`;
      reportedAt.set(id, index);
      if (stretchStarted.has(id)) stretchReported.add(id);
      return id;
    });
    if (needsPerson(turn)) {
      close(false);
      previousEnd = ended(turn);
      return;
    }
    open ??= { turns: [], reporters: new Set(), startedAt: previousEnd ?? turn.user.created_at };
    open.turns.push(turn);
    for (const key of keys) open.reporters.add(key);
    // The turn where the last outstanding agent reports carries the full answer: the run ends there,
    // so a later notice (an agent reporting again) cannot fold it away.
    const allIn = stretchStarted.size > 0 && [...stretchStarted].every((id) => stretchReported.has(id));
    if (endsRun(turn) || allIn) close(index === lastPlaced);
  });
  close(true);

  const settledLaunches = new Set<string>();
  for (const launch of launches) {
    if (launch.untracked) continue;
    const at = launch.children.map((id) => reportedAt.get(id));
    if (at.some((i) => i === undefined)) continue;
    const last = turns[Math.max(...(at as number[]))]!;
    const run = runs.get(anchorOf.get(last.id) ?? last.id);
    if (!last.live && !run?.live) settledLaunches.add(launch.id);
  }

  return { runs, absorbed, anchorOf, settledLaunches };
}

/** The run's row: `Worked for 5m · 3 agents`, `Working · 2 of 3 agents reported`, or `Stopped · 2 of 3 agents reported`. */
export function sessionLogAgentRunLabel(run: Pick<SessionLogAgentRun, 'agents' | 'started' | 'reported' | 'durationMs' | 'live' | 'stopped'>): string {
  const agents = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;
  if (run.live || run.stopped) {
    const progress = run.started >= run.reported && run.started > 0 ? `${run.reported} of ${agents(run.started)}` : agents(run.agents);
    return `${run.live ? 'Working' : 'Stopped'} · ${progress} reported`;
  }
  const duration = run.durationMs == null ? '' : formatDuration(run.durationMs);
  return `${duration ? `Worked for ${duration}` : 'Worked'} · ${agents(run.agents)}`;
}
