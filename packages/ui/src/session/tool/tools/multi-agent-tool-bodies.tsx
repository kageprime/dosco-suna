'use client';

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { Hint } from '../../../primitives/hint';
import { ToolResultCard } from '../shared/result-card';
import { SubagentDialog } from '../../agents/subagent-view';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { AgentStateMark } from '../../agents/agent-state-mark';
import { subagentTitle } from '../../agents/agent-model';
import { agentDisplayName } from '../../../internal/components/agent-mark';
import { peerHandleLabel } from '@kortix/shared';
import { AgentChip, AgentFace, AgentHandle, AgentRowBody, AgentRowScope, AgentStatus, AgentTrigger, SmallGlyph, taskGlyphStatus } from '../../agents/agent-surface';
import type { SessionDisplayStatus } from '../../actions/session-label';
import { BasicTool, ToolSurfaceContext } from '../shared/infrastructure';
import {
  ArrowSquareOutIcon,
  ArrowUpRightIcon,
  ListChecksIcon,
  PaperPlaneTiltIcon,
  StopCircleIcon,
  UsersThreeIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useContext, useState, type ReactNode } from 'react';
import { SolidCheckIcon } from '../../../internal/icons/solid-check-icon';
import { ToolStartedAtContext } from '../shared/infrastructure-contexts';
import type { KortixToolResult, MultiAgentTool } from './kortix-tool-card';
import { useSessionChildren } from '@kortix/sdk/react';
import { useSessionIds } from '../../../providers/session-ids';
import { WorkFoldContext } from '../../turn/turn-work-accordion';
import {
  sessionWorkState,
  parsePeerSend,
  parseReachable,
  parseStoppedChild,
  parseTasks,
  type StoppedChild,
  type SessionBoardState,
  type PeerMessageStatus,
  type PeerSendSummary,
  type ReachableAgentRow,
  type TeamTaskRow,
  type SessionTaskStatus,
} from '@kortix/sdk';

/**
 * The card bodies of the multi-agent tools (`send_message`, `list_agents`,
 * `task_*`, `task_stop`), drawn from the result's `data`. Each status chip takes
 * the hue of its meaning (color.md status table): green done or running, orange
 * waiting on a person or refused by design, red failed, no hue idle.
 */

type BadgeVariant = 'success' | 'warning' | 'destructive' | 'info' | 'muted';

export const MULTI_AGENT_ICON: Record<MultiAgentTool, Icon> = {
  send_message: PaperPlaneTiltIcon,
  list_agents: UsersThreeIcon,
  task_create: ListChecksIcon,
  task_list: ListChecksIcon,
  task_get: ListChecksIcon,
  task_update: ListChecksIcon,
  task_stop: StopCircleIcon,
};

/** The key under `multiAgent.tools.running` for a call still in flight. */
export function runningKey(tool: MultiAgentTool): 'sending' | 'checkingAgents' | 'checkingTasks' | 'updatingTasks' | 'stopping' {
  switch (tool) {
    case 'send_message':
      return 'sending';
    case 'list_agents':
      return 'checkingAgents';
    case 'task_list':
    case 'task_get':
      return 'checkingTasks';
    case 'task_create':
    case 'task_update':
      return 'updatingTasks';
    case 'task_stop':
      return 'stopping';
  }
}

const TASK_VARIANT: Record<SessionTaskStatus, BadgeVariant> = {
  pending: 'muted',
  in_progress: 'info',
  completed: 'success',
};

const STATE_KEY: Record<SessionBoardState, string> = {
  working: 'working',
  needs_input: 'needsInput',
  idle: 'idle',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};

const TASK_KEY: Record<SessionTaskStatus, string> = {
  pending: 'pending',
  in_progress: 'inProgress',
  completed: 'completed',
};

const ROW_CLASS = 'flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs';

/** An agent's face as a tool row's 16px icon: its pixel mark on its own tile. */
export const AgentAvatarIcon = AgentFace;

/** "To {to}" in any locale, split at the name: the words before it lead the chip, the words after it (Japanese "{to} へ") trail it. */
const TO_MARK = '\u0000';
function aroundName(sentence: string): { lead: string; trail: string } {
  const [lead = '', trail = ''] = sentence.split(TO_MARK);
  return { lead: lead.trim(), trail: trail.trim() };
}

/** The state a send ended in, as a session-list glyph: delivered is done, held waits on a person. */
const PEER_GLYPH: Record<PeerMessageStatus, SessionDisplayStatus> = {
  delivered: 'done',
  held: 'needs-you',
  refused: 'stopped',
  denied: 'stopped',
  expired: 'stopped',
  dropped: 'stopped',
};

/**
 * `send_message`: one agent row, the receiver's face as its icon:
 *
 *   [face] To reviewer  Migration finished                  ✓ Delivered
 *          │ the whole message
 *          │ why it did not arrive, when it did not
 *
 * The state is a glyph and a muted word: a held message waits on a person, it did not fail.
 * A delivered note to a colleague this session started reads Working while that colleague
 * works on it: the note handed it work, and the row is where the person sees that. Only the
 * note whose turn is still open does: a settled one sits in its turn's fold and keeps its state.
 */
export function PeerSendRow({
  send,
  receiverId,
  defaultOpen,
  forceOpen,
  locked,
}: {
  send: PeerSendSummary;
  /** The session the platform delivered the note to (`data.to.session_id`). */
  receiverId?: string | null;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  locked?: boolean;
}) {
  const t = useTranslations('multiAgent.tools');
  const delivered = send.status === 'delivered';
  const settled = useContext(WorkFoldContext);
  const working = useColleagueWorking(delivered && !settled ? { handle: send.to, sessionId: receiverId ?? null } : null);
  const preview = send.summary || firstLineOf(send.message) || undefined;
  const hasBody = !!send.message || (!delivered && !!send.note);
  // The side panel has the room for what happened to the message, in order.
  if (useContext(ToolSurfaceContext) === 'panel') {
    return <PeerSendTimeline send={send} working={working} />;
  }
  return (
    <AgentRowScope>
      <BasicTool
        trigger={
          send.to ? (
            <AgentTrigger {...aroundName(t('messageToName', { to: TO_MARK }))} handle={send.to} title={peerHandleLabel(send.to).replace(/^@/, '')} subtitle={preview} sessionId={receiverId} />
          ) : (
            <AgentTrigger title={t('messageSent')} subtitle={preview} />
          )
        }
        triggerAction={
          working ? (
            <AgentStatus status="running" label={t('state.working')} opens={hasBody} />
          ) : (
            <AgentStatus status={PEER_GLYPH[send.status]} label={t(`peerStatus.${send.status}`)} opens={hasBody} />
          )
        }
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
      >
        {hasBody ? (
          <AgentRowBody>
            {send.message && <p className="text-foreground whitespace-pre-wrap wrap-break-word">{send.message}</p>}
            {!delivered && send.note && <p className="text-muted-foreground">{send.note}</p>}
          </AgentRowBody>
        ) : undefined}
      </BasicTool>
    </AgentRowScope>
  );
}

/**
 * A sent message in the side panel, as a timeline (one rail, one node per
 * event, the time on the right): who it went to and what it said, then what
 * became of it — the receiver working on it, or the delivery state and the
 * platform's note when it did not get through.
 */
function PeerSendTimeline({ send, working }: { send: PeerSendSummary; working: boolean }) {
  const t = useTranslations('multiAgent.tools');
  const startedAt = useContext(ToolStartedAtContext);
  const clock = startedAt ? new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  const delivered = send.status === 'delivered';
  const { lead, trail } = aroundName(t('messageToName', { to: TO_MARK }));
  const name = send.to ? peerHandleLabel(send.to).replace(/^@/, '') : null;
  const title = send.summary || null;
  const text = send.message && send.message !== title ? send.message : null;

  return (
    <ol className="flex flex-col py-1">
      <TimelineNode glyph={<PaperPlaneTiltIcon className="size-3.5" />} rail>
        <div className="flex min-h-5 min-w-0 items-center gap-1.5 text-sm">
          {name ? (
            <>
              {lead && <span className="text-muted-foreground shrink-0">{lead.trim()}</span>}
              <AgentChip handle={send.to!} name={name} plain className="max-w-none min-w-0 shrink" />
              {trail && <span className="text-muted-foreground shrink-0">{trail.trim()}</span>}
            </>
          ) : (
            <span className="text-muted-foreground">{t('messageSent')}</span>
          )}
          {clock && <span className="text-muted-foreground ml-auto shrink-0 pl-2 text-xs tabular-nums">{clock}</span>}
        </div>
        {(title || text) && (
          <div className="bg-popover border-border mt-2 rounded-md border px-3 py-2.5 text-sm">
            {title && <p className="text-foreground font-medium">{title}</p>}
            {text && (
              <p className={cn('whitespace-pre-wrap wrap-break-word', title ? 'text-muted-foreground mt-1' : 'text-foreground')}>{text}</p>
            )}
          </div>
        )}
      </TimelineNode>
      <TimelineNode
        glyph={
          working ? (
            <SmallGlyph status="running" />
          ) : delivered ? (
            <SolidCheckIcon className="size-3.5" />
          ) : (
            <SmallGlyph status={PEER_GLYPH[send.status]} />
          )
        }
      >
        <div className="flex min-h-5 items-center text-sm">
          <span className="text-muted-foreground">{working ? t('state.working') : t(`peerStatus.${send.status}`)}</span>
        </div>
        {!delivered && send.note && <p className="text-muted-foreground mt-0.5 text-sm">{send.note}</p>}
      </TimelineNode>
    </ol>
  );
}

/** One event on the rail: a 20px glyph node, the rail running down to the next node, the content beside it. */
function TimelineNode({ glyph, rail = false, children }: { glyph: ReactNode; rail?: boolean; children: ReactNode }) {
  return (
    <li className={cn('relative flex gap-3', rail && 'pb-4')}>
      {rail && <span aria-hidden className="bg-border absolute top-6 bottom-1 left-2.5 w-px" />}
      <span aria-hidden className="text-muted-foreground flex size-5 shrink-0 items-center justify-center">
        {glyph}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/**
 * Whether the child of this session a note reached works now: by the session the note was
 * delivered to, else by its handle (an unnamed child has none). Reads the child list the agents
 * line under the composer polls (same query key), so the row adds no request of its own.
 */
function useColleagueWorking(receiver: { handle: string | null; sessionId: string | null } | null): boolean {
  const ids = useSessionIds();
  const ready = !!receiver && (!!receiver.handle || !!receiver.sessionId) && !!ids.projectId && !!ids.sessionId;
  // The agents line's page size: the query key has no limit, so a smaller page would replace its list.
  const { sessions } = useSessionChildren(ids.projectId ?? '', ids.sessionId ?? '', { enabled: ready, limit: 50 });
  if (!ready) return false;
  return sessions.some(
    (child) =>
      (receiver!.sessionId ? child.session_id === receiver!.sessionId : child.agent_handle === receiver!.handle) &&
      sessionWorkState(child) === 'running',
  );
}

/** The session the platform delivered a note to (`data.to.session_id`), or null. */
export function peerReceiverId(data: unknown): string | null {
  const id = (data as { to?: { session_id?: unknown } } | null | undefined)?.to?.session_id;
  return typeof id === 'string' && id ? id : null;
}

function firstLineOf(text: string | null): string {
  return text?.split('\n').find((line) => line.trim())?.trim() ?? '';
}

/** Row actions: shown on hover and on keyboard focus, always on a touch screen (as in the agents line). */
const ROW_ACTIONS =
  'flex shrink-0 items-center pr-1 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100';

/**
 * One agent `list_agents` found, drawn as the agents line draws it: the state
 * mark, the handle and its state, then one muted line with what it works on
 * and how it relates to this session. The row opens the agent's session.
 */
function AgentLine({ agent }: { agent: ReachableAgentRow }) {
  const t = useTranslations('multiAgent.tools');
  const tStrip = useTranslations('multiAgent.strip');
  const [viewing, setViewing] = useState(false);
  const title = agent.title ? subagentTitle(agent.title) || null : null;
  const relation = t.has(`relation.${agent.relation}`) ? t(`relation.${agent.relation}`) : null;
  const meta = [
    title ?? (agent.agentName ? tStrip('runsAs', { agent: agentDisplayName(agent.agentName) }) : null),
    relation,
    agent.canReceive ? null : t('cannotReceive'),
  ]
    .filter(Boolean)
    .join(' · ');
  const name = `@${agent.handle}`;
  const label = peerHandleLabel(agent.handle).replace(/^@/, '');
  const failed = agent.state === 'failed';
  // The agent's mark and name, its state on the right edge, and what it works
  // on below, on the name's edge. No tinted pill: the mark is the agent's face.
  return (
    <li className="group/row hover:bg-hover focus-within:bg-hover flex min-w-0 items-start rounded-md" data-agent-row={agent.sessionId}>
      <button
        type="button"
        onClick={() => setViewing(true)}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 py-2 pl-1 text-left outline-none"
      >
        <span className="flex min-w-0 items-center gap-2">
          <AgentChip handle={agent.handle} name={label} plain className="max-w-none min-w-0 shrink" />
          <span className="flex-1" />
          {agent.state && (
            <span className={cn('shrink-0 text-xs', failed ? 'text-kortix-red' : 'text-muted-foreground')}>
              {t(`state.${STATE_KEY[agent.state]}`)}
            </span>
          )}
        </span>
        {meta && (
          <span className="text-muted-foreground block truncate pl-5 text-xs" title={meta}>
            {meta}
          </span>
        )}
      </button>
      <div className={cn(ROW_ACTIONS, 'pt-1.5 pl-1')}>
        <Hint label={tStrip('openAgent', { name: label })} side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={tStrip('openAgent', { name })}
            onClick={() => setViewing(true)}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowUpRightIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
      </div>
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={agent.sessionId} title={name} />
    </li>
  );
}

function TaskLine({ task }: { task: TeamTaskRow }) {
  const t = useTranslations('multiAgent.tools');
  const done = task.status === 'completed';
  return (
    <div className={ROW_CLASS} data-task-seq={task.seq}>
      <SmallGlyph status={task.blocked && !done ? 'stopped' : taskGlyphStatus(task.status)} label={t(`taskStatus.${TASK_KEY[task.status]}`)} />
      <span className="text-muted-foreground shrink-0 tabular-nums">#{task.seq}</span>
      <span className={cn('min-w-0 flex-1 truncate', done ? 'text-muted-foreground' : 'text-foreground')} title={task.subject}>
        {task.subject}
      </span>
      {task.blockedBy.length > 0 && task.blocked && (
        <span className="text-muted-foreground shrink-0">
          {t('blockedBy', { tasks: task.blockedBy.map((n) => `#${n}`).join(', ') })}
        </span>
      )}
      {task.owner && <AgentHandle handle={task.owner} />}
    </div>
  );
}

/** `task_stop`: the agent it stopped, whether it was still running, and a way into its session. */
function StoppedChildBody({ child }: { child: StoppedChild }) {
  const t = useTranslations('multiAgent.tools');
  const [viewing, setViewing] = useState(false);
  const name = child.handle ? `@${child.handle}` : (child.title ?? child.sessionId.slice(0, 8));
  const detail = child.handle ? child.title : null;
  return (
    <ToolResultCard bodyClassName="py-0.5">
      <div className={ROW_CLASS} data-testid="stopped-child-body">
        <span className="text-foreground shrink-0 font-medium">{name}</span>
        {detail ? (
          <>
            <span aria-hidden className="text-muted-foreground shrink-0">
              ·
            </span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate" title={detail}>
              {detail}
            </span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        <Badge variant="muted" size="sm" className="shrink-0">
          {child.stopped ? t('stopped') : t('alreadyEnded')}
        </Badge>
        <Hint label={t('openSession')}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('openSession')}
            onClick={() => setViewing(true)}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <ArrowSquareOutIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
      </div>
      <SubagentDialog open={viewing} onOpenChange={setViewing} sessionId={child.sessionId} title={name} />
    </ToolResultCard>
  );
}

function RowList({ children }: { children: ReactNode[] }) {
  return (
    <ToolResultCard bodyClassName="py-0.5">
      <ul>{children}</ul>
    </ToolResultCard>
  );
}

/**
 * The body a multi-agent result draws from its `data`, or `null` when the data
 * does not parse or holds nothing to show (the card's own rows draw instead).
 */
export function multiAgentBody(tool: MultiAgentTool, result: KortixToolResult): ReactNode | null {
  switch (tool) {
    case 'send_message': {
      const send = parsePeerSend(result.data);
      return send ? <PeerSendRow send={send} receiverId={peerReceiverId(result.data)} /> : null;
    }
    case 'list_agents': {
      const agents = parseReachable(result.data);
      if (!agents || agents.length === 0) return null;
      // One list under the row, no card around it: each agent is a row of its own.
      return (
        <ul className="-mx-1 flex flex-col">
          {agents.map((agent) => (
            <AgentLine key={agent.sessionId} agent={agent} />
          ))}
        </ul>
      );
    }
    case 'task_create':
    case 'task_list':
    case 'task_get':
    case 'task_update': {
      const tasks = parseTasks(result.data);
      if (!tasks || tasks.length === 0) return null;
      return (
        <RowList>
          {tasks.map((task) => (
            <li key={task.seq}>
              <TaskLine task={task} />
            </li>
          ))}
        </RowList>
      );
    }
    case 'task_stop': {
      const child = parseStoppedChild(result.data);
      return child ? <StoppedChildBody child={child} /> : null;
    }
  }
}
