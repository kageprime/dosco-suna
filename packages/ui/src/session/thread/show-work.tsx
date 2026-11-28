'use client';

import { getChildSessionId, type SessionLogBlock } from '@kortix/sdk';
import { useProjectSession, useSessionStateStore } from '@kortix/sdk/react';
import { useContext } from 'react';

import { useTranslations } from '../../i18n';
import { useSessionIds } from '../../providers/session-ids';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { formatDuration } from '../../internal/session-types';
import { useElapsedLabel } from './typing-indicator';
import { sessionDisplayLabel } from '../actions/session-label';
import { type TranscriptRows, TranscriptRowsContext } from './transcript-rows';

/**
 * The sessions working behind one message of a talk-only thread
 * (`TranscriptRows.front`): the child of every `agent` call of the turn, and
 * the session of every report the turn answers (the worker's run-end notice).
 * In first-seen order, each once.
 */
export function messageWorkerIds(blocks: readonly SessionLogBlock[], reportSessionIds: readonly (string | null | undefined)[]): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'tool_call') continue;
    const child = getChildSessionId(block);
    if (child) ids.add(child);
  }
  for (const id of reportSessionIds) if (id) ids.add(id);
  return [...ids];
}

/**
 * A router thread's live status while its hidden workers run: one row per
 * busy worker, its mark and "<Agent> is working · 0:42", under the message
 * that started it. A row leaves when its worker goes idle (its report then
 * reaches the router, which replies).
 */
export function WorkerStatusRows({ sessionIds }: { sessionIds: readonly string[] }) {
  const ids = useSessionIds();
  const author = useContext(TranscriptRowsContext)?.author;
  if (!ids.projectId || sessionIds.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {sessionIds.map((sessionId) => (
        <WorkerStatusRow key={sessionId} projectId={ids.projectId!} sessionId={sessionId} author={author} />
      ))}
    </div>
  );
}

function WorkerStatusRow({ projectId, sessionId, author }: { projectId: string; sessionId: string; author?: TranscriptRows['author'] }) {
  const t = useTranslations('sessionUi.turn');
  const row = useProjectSession(projectId, sessionId).data;
  const busy = useSessionStateStore((s) => {
    const type = s.sessionStatus[sessionId]?.type;
    return type === 'busy' || type === 'retry';
  });
  const working = busy || row?.working?.state === 'working';
  const elapsed = useElapsedLabel(working ? (row?.working?.since ?? row?.created_at ?? null) : null, formatDuration);
  if (!working || !row?.agent_name) return null;
  const agent = row.agent_name;
  const label = sessionDisplayLabel(row).trim();
  // An untitled worker falls back to an id or branch: no task to name then.
  const task = label && !row.session_id.startsWith(label) && label !== row.branch_name?.slice(0, 14) ? label : null;
  const face = (
    <span className="inline-flex items-center gap-1.5">
      <AgentMark slug={agent} size={14} />
      <span className="text-foreground font-medium">{agentDisplayName(agent)}</span>
    </span>
  );
  return (
    <div role="status" aria-live="polite" className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs tabular-nums">
      {author ? author({ kind: 'agent', name: agent }, face, 'name') : face}
      {/* What it works on (the worker session's title), so two workers read apart. */}
      <span className="min-w-0 truncate" title={task ?? undefined}>
        {task
          ? elapsed
            ? t('agentWorkingOnFor', { task, time: elapsed })
            : t('agentWorkingOn', { task })
          : elapsed
            ? t('agentWorkingFor', { time: elapsed })
            : t('agentWorking')}
      </span>
    </div>
  );
}
