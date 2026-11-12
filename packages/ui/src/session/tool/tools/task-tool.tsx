'use client';

import { SubagentDialog } from '../../agents/subagent-view';
import { BasicTool, ToolSurfaceContext, firstMeaningfulLine, partInput, partMetadata, partStatus, partError } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { SubAgentStatusBanner, useSubAgentThread } from '../shared/sub-agent';
import type { ToolProps } from '../shared/types';
import { useTranslations } from '../../../i18n';
import { getChildSessionId } from '../../../internal/session-types';
import { useContext, useMemo, useState } from 'react';
import type { ProjectSession, SessionLogThread } from '@kortix/sdk';
import { useProjectSession, useSessionAsks, useSessionStateStore } from '@kortix/sdk/react';
import { agentDisplayName } from '../../../internal/components/agent-mark';
import { useSessionIds } from '../../../providers/session-ids';
import type { SessionDisplayStatus } from '../../actions/session-label';
import { agentRowOf, type AgentRowState } from '../../agents/agent-model';
import { AgentFace, AgentFailure, AgentRowBody, AgentRowScope, AgentStatus, AgentTrigger, OpenAgentButton } from '../../agents/agent-surface';

/**
 * Whether a background hand-off's child still works. The child's status is
 * known while this tab streams it; without it, a child whose last reply has
 * completed is not working, and any other child is taken as still at work.
 */
function useBackgroundWorking(childSessionId: string | undefined, childThread: SessionLogThread | null): boolean {
  const childStatus = useSessionStateStore((s) => (childSessionId ? s.sessionStatus[childSessionId] : undefined));
  if (childStatus?.type === 'busy' || childStatus?.type === 'retry') return true;
  if (childStatus?.type === 'idle') return false;
  const last = childThread?.messages.findLast((m) => m.role === 'assistant');
  return !last || last.completed_at === null;
}

/**
 * An agent call (`agent`, `task`, Codex `spawn_agent`) is one tool row, the
 * grammar of every other tool row:
 *
 *   [face] Researcher  Research competitor pricing…          ◔ Working  >
 *
 * A click opens the agent's session in the side panel (its face, name, state,
 * conversation and a box to message it); without a panel, in the agent dialog.
 */
export function TaskTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const t = useTranslations('tools.agent');
  const tNotice = useTranslations('multiAgent.notice');
  const input = partInput(call);
  const status = partStatus(call);

  // Tool input is the model's JSON: every field is `unknown` at runtime, and a
  // truthy non-string used to crash the render tree (`e.replace is not a
  // function`, KRTX-4511). Read each field by type, never by cast — an empty
  // or junk value falls through to the same fallback as an absent one.
  // pi's `agent` field is an object by schema: an inline agent spec
  // (`{ instructions, model?, tools?, description? }`). Its child runs as the
  // `inline` agent (`INLINE_AGENT` in the pi subagents extension), so the row
  // names it that way, never as `general`.
  const subagentType =
    (typeof input.subagent_type === 'string' && input.subagent_type) ||
    (typeof input.agent === 'string' && input.agent) ||
    (typeof input.agent === 'object' && input.agent !== null ? INLINE_AGENT : '') ||
    'general';
  const name = typeof input.name === 'string' ? input.name : '';
  const description = useMemo(
    () =>
      (typeof input.description === 'string' && input.description) ||
      firstMeaningfulLine(input.prompt) ||
      // Codex `spawn_agent`.
      firstMeaningfulLine(input.message) ||
      firstMeaningfulLine(input.title, 80),
    [input],
  );
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : typeof input.message === 'string' ? input.message.trim() : '';

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(call), [call]);
  const childThread = useSubAgentThread(childSessionId);

  // `agent(…, { background: true })` returns as soon as the child exists. The call is
  // over; the work goes on in the child's own session, and the row says so.
  const background = partMetadata(call).background === true;
  const backgroundWorking = useBackgroundWorking(background ? childSessionId : undefined, childThread);

  const [modalOpen, setModalOpen] = useState(false);
  const isRunning = status === 'running' || status === 'pending';
  const errorText = partError(call);

  // The child's own session row says how it is doing; the call's status is the fallback.
  const ids = useSessionIds();
  const childRow = useProjectSession(ids.projectId, childSessionId, { enabled: !!ids.projectId && !!childSessionId });
  const child = childRow.data ? agentRowOf(childRow.data as ProjectSession) : null;
  // A colleague whose access waits for the person (pi `awaitingApproval`): no session exists yet.
  // "Needs you" while its ask is open; once decided, the call is over and a new call starts the colleague.
  const askId = !childSessionId && partMetadata(call).awaitingApproval === true ? partMetadata(call).askId : undefined;
  const openAsks = useSessionAsks(ids.projectId ?? '', { enabled: !!ids.projectId && typeof askId === 'string' });
  const awaitingApproval = typeof askId === 'string' && !!openAsks.data?.asks.some((ask) => ask.id === askId);
  const state: AgentRowState = errorText
    ? 'failed'
    : awaitingApproval
      ? 'needs_input'
      : (child?.state ?? (isRunning || (background && backgroundWorking) ? 'working' : status === 'completed' ? 'completed' : 'idle'));
  // The name its parent gave it (`agent({ name })`) reads best; else the kind of agent.
  const handle = name || (child?.named ? child.handle : '') || subagentType;
  const title = name || (child?.named ? child.handle : '') || agentDisplayName(subagentType);

  // A row with a session opens it: beside the chat in the side panel, or as the agent
  // dialog where there is no panel. Its prompt, steps and answer are that session's
  // conversation, so the row carries no copy of them. A call that never got a
  // session keeps what it has in place. On the panel's own surface a row is a fold
  // (it takes no click), so there the fold holds Open.
  const surface = useContext(ToolSurfaceContext);
  const opensAgent = !!childSessionId && surface !== 'panel';
  const hasBody = !opensAgent && (!!prompt || !!errorText || !!childSessionId);
  return (
    <AgentRowScope>
      <BasicTool
        icon={<AgentFace handle={handle} />}
        trigger={<AgentTrigger title={title} subtitle={description} />}
        triggerAction={<AgentStatus status={STATE_GLYPH[state]} label={t(`state.${state}`)} opens={opensAgent || hasBody} />}
        onClick={opensAgent ? () => setModalOpen(true) : undefined}
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
      >
        {hasBody ? (
          <AgentRowBody>
            {prompt && prompt !== description && (
              <p className="text-muted-foreground line-clamp-4 whitespace-pre-wrap wrap-break-word">{prompt}</p>
            )}
            {errorText && <AgentFailure sentence={tNotice('failedSentence')} raw={errorText} />}
            {childSessionId && <OpenAgentButton label={t('openAgent', { name: description || title })} onClick={() => setModalOpen(true)} />}
          </AgentRowBody>
        ) : undefined}
      </BasicTool>
      <SubAgentStatusBanner childSessionId={childSessionId} childThread={childThread} />
      {childSessionId && (
        <SubagentDialog open={modalOpen} onOpenChange={setModalOpen} sessionId={childSessionId} title={title} handle={handle} task={description || undefined} failure={errorText || undefined} />
      )}
    </AgentRowScope>
  );
}

/** The agent name an inline agent spec's child runs under (pi `INLINE_AGENT`). */
const INLINE_AGENT = 'inline';

/** The session-list glyph an agent's state draws. */
const STATE_GLYPH: Record<AgentRowState, SessionDisplayStatus> = {
  working: 'running',
  needs_input: 'needs-you',
  failed: 'failed',
  idle: 'done',
  completed: 'done',
  stopped: 'stopped',
};
// pi's `agent` (`task` is its deprecated alias) reaches this row through its kind (`toolKind`).
ToolRegistry.register('task', TaskTool);
