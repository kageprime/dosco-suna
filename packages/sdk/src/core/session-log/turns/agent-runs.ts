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
import { parsePeerSend, parseStoppedChild } from '../../multi-agent/tool-data';
import { getChildSessionId } from '../../turns/parts';
import { parsePeerMessagePrompt } from '../../turns/peer-message-prompt';
import { textRendersCard } from '../../turns/segments/card-text';
import { callStartsConnectorSignIn } from '../../turns/segments/sign-in-call';
import { isNoGroupActivityTool, isQuestionTool, normalizeActivityToolName } from '../../turns/segments/session-activity-groups';
import { STARTED_WORK_TOOLS } from '../../turns/segments/started-work';
import { formatDuration } from '../../turns/state';
import { parseNoticeBatch, parseSubagentNotice } from '../../turns/subagent-notice';
import { parseKortixToolResult } from '../../turns/tools/kortix-tool-card';
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

/**
 * A reporter: the child session a notice names, else the peer's short session id and handle.
 * `progress`: a plain message (`send_message`), not a finish. From an agent this session
 * started it says how the work goes; the agent has reported only when it finishes.
 */
type Reporter = ({ sessionId: string } | { shortId: string; handle: string }) & { progress?: boolean };

function reportersOf(message: SessionLogMessage): Reporter[] | null {
  for (const text of promptTexts(message)) {
    // A batch first: its first notice alone would read as the whole prompt.
    const batch = parseNoticeBatch(text);
    if (batch && batch.length > 1) {
      return batch.map((item) =>
        item.kind === 'peer_idle' ? { shortId: item.info.fromShortId, handle: item.info.from } : { sessionId: item.notice.sessionId },
      );
    }
    const peer = parsePeerMessagePrompt(text);
    if (peer) return [{ shortId: peer.fromShortId, handle: peer.from, progress: peer.kind === 'message' }];
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

const isCall = (b: SessionLogTurn['blocks'][number], tool: string): b is ToolCallBlock =>
  b.type === 'tool_call' && normalizeActivityToolName(b.name) === tool;

/** The platform result a call returned (`KortixToolResult.data`), or undefined while it runs or when it is not one. */
function resultData(b: ToolCallBlock): unknown {
  const raw = (b.result?.content ?? []).flatMap((c) => ('text' in c && typeof c.text === 'string' ? [c.text] : [])).join('');
  return parseKortixToolResult(raw, b.name)?.data;
}

/** A note the turn sent: who it names, and the session the platform delivered it to (null while it runs). */
interface Note {
  to: string;
  sessionId: string | null;
}

/** The turn sent a note at all, delivered or not. */
const sendsNote = (turn: SessionLogTurn): boolean => turn.blocks.some((b) => isCall(b, 'send_message'));

/**
 * The notes that reached someone. Once a call has its result, only a `delivered` result names who
 * got it (its receiver's session); any other answer hands nobody work. While it still runs, the
 * name it addresses stands in.
 */
const notesOf = (turn: SessionLogTurn): Note[] =>
  turn.blocks.flatMap((b): Note[] => {
    if (!isCall(b, 'send_message')) return [];
    if (b.status === 'pending' || b.status === 'running') {
      const to = ((b.input ?? {}) as { to?: unknown }).to;
      // The API reads `@writer` as `writer`.
      const name = typeof to === 'string' ? to.trim().replace(/^@/, '') : '';
      return name ? [{ to: name, sessionId: null }] : [];
    }
    const data = resultData(b);
    const receiver = (data as { to?: { session_id?: unknown } } | undefined)?.to?.session_id;
    if (parsePeerSend(data)?.status !== 'delivered' || typeof receiver !== 'string') return [];
    return [{ to: '', sessionId: receiver }];
  });

/** The children a turn stopped (`task_stop`): a stop the parent made sends no finish notice, so the stop is the finish. */
const stoppedBy = (turn: SessionLogTurn): string[] =>
  turn.blocks.flatMap((b): string[] => {
    if (!isCall(b, 'task_stop') || b.status === 'error') return [];
    const stopped = parseStoppedChild(resultData(b));
    return stopped ? [stopped.sessionId] : [];
  });

/**
 * The agents a turn's notes hand work again: a note to an agent this session started wakes it
 * (by its task_id or its name), and it reports again when it finishes. A note to another session
 * hands this session nothing to wait for.
 */
const wokenBy = (turn: SessionLogTurn, launched: readonly Child[]): Child[] =>
  notesOf(turn).flatMap(({ to, sessionId }): Child[] => {
    // The session the platform delivered to decides: a session of the same name is not the child.
    if (sessionId) {
      const child = launched.find((c) => c.id === sessionId);
      return child ? [{ id: child.id, handles: child.handles }] : [];
    }
    // An unnamed child answers to its generated handle, `<agent>-<first 8 of its session id>`.
    const shortId = /-([0-9a-z]{8})$/i.exec(to)?.[1];
    const child =
      launched.find((c) => c.id === to || (to.length >= 8 && c.id.startsWith(to)) || (!!shortId && c.id.startsWith(shortId))) ??
      lastNamed(launched, to);
    return child ? [{ id: child.id, handles: child.handles }] : [];
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
      normalizeActivityToolName(b.name) !== 'send_message' &&
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
  /** Child id → the indexes of the turns that carried its finish, in order. */
  const reportedAt = new Map<string, number[]>();
  const launches: Array<{ id: string; index: number; children: string[]; untracked: boolean }> = [];
  /** Turns whose notes went only to sessions this one did not start: nothing to wait for. */
  const settledNotes = new Set<string>();
  /** Child id → the index of the last turn that started it or handed it work. */
  const handedAt = new Map<string, number>();
  /** The child finished since it was last handed work. */
  const idle = (id: string) => (reportedAt.get(id)?.at(-1) ?? -1) > (handedAt.get(id) ?? -1);
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
    // A working anchor is live wherever it is; one still waiting on an agent only at the tail.
    const live = !stopped && (anchor.live || (tail && waiting));
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
    const woken = wokenBy(turn, launched);
    const children = [...childrenOf(turn), ...woken];
    const ids = [...new Set(children.map((c) => c.id))];
    // A note that woke nobody waits on nothing, unless other work the turn started still runs.
    if (sendsNote(turn) && woken.length === 0 && childrenOf(turn).length === 0 && !runsUntracked(turn)) settledNotes.add(turn.id);
    const finishBy = (id: string) => {
      reportedAt.set(id, [...(reportedAt.get(id) ?? []), index]);
      if (stretchStarted.has(id)) stretchReported.add(id);
    };
    if (!reporters) {
      for (const id of ids) handedAt.set(id, index);
      close(false);
      // A colleague still out when the person asks something else stays out: its next report is not a new run's whole story.
      const out = [...new Set(launched.map((c) => c.id))].filter((id) => handedAt.has(id) && !idle(id));
      stretchStarted = new Set([...out, ...ids]);
      stretchReported = new Set();
      for (const id of stoppedBy(turn)) finishBy(id);
      if (ids.length) launches.push({ id: turn.id, index, children: ids, untracked: runsUntracked(turn) });
      launched.push(...children);
      previousEnd = ended(turn);
      return;
    }
    for (const id of ids) stretchStarted.add(id);
    if (ids.length) launches.push({ id: turn.id, index, children: ids, untracked: runsUntracked(turn) });
    launched.push(...children);
    const keys = reporters.map((r) => {
      // The latest agent of that name wins: a name is reused once its agent ended.
      const id =
        'sessionId' in r
          ? r.sessionId
          : (launched.find((c) => c.id.startsWith(r.shortId)) ?? lastNamed(launched, r.handle))?.id;
      if (!id) return `peer:${'handle' in r ? r.handle : ''}`;
      // A started agent's message is progress; it has reported when it finishes.
      if (r.progress && launched.some((c) => c.id === id)) return id;
      reportedAt.set(id, [...(reportedAt.get(id) ?? []), index]);
      if (stretchStarted.has(id)) stretchReported.add(id);
      return id;
    });
    for (const id of stoppedBy(turn)) finishBy(id);
    // A note that wakes a colleague that had finished hands it new work: its row folded away with
    // that finish, so this turn draws on its own and the note stays in view while it works. A relay
    // to a colleague still working stays in the run: its row is still in view.
    const rewoken = woken.some((child) => idle(child.id));
    // A colleague handed work again is out again, even when its finish came in this same turn.
    for (const child of woken) stretchReported.delete(child.id);
    for (const id of ids) handedAt.set(id, index);
    if (needsPerson(turn) || rewoken) {
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

  const settledLaunches = new Set<string>(settledNotes);
  for (const launch of launches) {
    if (launch.untracked) continue;
    // A finish counts only after this launch: a colleague continued here is working again.
    const at = launch.children.map((id) => reportedAt.get(id)?.find((i) => i > launch.index));
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
