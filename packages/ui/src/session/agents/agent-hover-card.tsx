'use client';

import { ArrowUpRightIcon } from '@phosphor-icons/react';
import type { ProjectSession } from '@kortix/sdk';
import { useProjectSession } from '@kortix/sdk/react';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { CopyButton } from '../../markdown/copy-button';
import { useProjectSessionHref } from '../../internal/lib/navigation/session-href';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { useSessionIds } from '../../providers/session-ids';
import { agentRowOf } from './agent-model';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { cn } from '../../lib/utils';

/**
 * What an agent chip says on hover: who the agent is, how it is doing, the
 * model it runs on, and its session — the id to copy and a link that opens it
 * in a new tab. Only an agent with a session of its own gets the card; an
 * inline run (pi `session: "same"`) has nothing to open.
 */

/**
 * A hover card that mounts on first hover. A transcript holds dozens of agent
 * rows; each idle row stays a plain span, and only the one a pointer reaches
 * pays for the floating layer.
 */
function LazyAgentCard({ className, card, children }: { className?: string; card: (open: boolean) => ReactNode; children: ReactElement }) {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const trigger = (
    <span
      data-slot="agent-hover-trigger"
      className={cn('flex min-w-0', className)}
      onPointerEnter={() => {
        if (armed) return;
        setArmed(true);
        // The first hover opens after the same delay a mounted card waits.
        timer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
      }}
      onPointerLeave={() => clearTimeout(timer.current)}
    >
      {children}
    </span>
  );
  if (!armed) return trigger;
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={OPEN_DELAY} closeDelay={120}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={6}
        animated={false}
        className="w-72 p-0"
        // The card is portaled, but React still bubbles its events to the row: a click
        // on Copy or the link must not also open the row.
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {card(open)}
      </HoverCardContent>
    </HoverCard>
  );
}

const OPEN_DELAY = 350;

export function AgentHoverCard({
  sessionId,
  name,
  className,
  children,
}: {
  sessionId: string;
  name: string;
  /** The trigger box: it takes the chip's place in the row, so it takes its flex. */
  className?: string;
  children: ReactElement;
}) {
  return (
    <LazyAgentCard className={className} card={(open) => (open ? <AgentCardBody sessionId={sessionId} name={name} /> : null)}>
      {children}
    </LazyAgentCard>
  );
}

function AgentCardBody({ sessionId, name }: { sessionId: string; name: string }) {
  const t = useTranslations('tools.agent');
  const ids = useSessionIds();
  const href = useProjectSessionHref()(sessionId);
  const row = useProjectSession(ids.projectId, sessionId, { enabled: !!ids.projectId });
  const session = (row.data as ProjectSession | undefined) ?? null;
  const agent = session ? agentRowOf(session) : null;
  const model = session?.model?.split('/').pop() ?? null;
  const line = agent?.line ?? null;
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 text-sm" data-slot="agent-hover-card">
      <div className="flex min-w-0 items-center gap-2">
        <p className="text-foreground min-w-0 flex-1 truncate font-medium">{name}</p>
        {agent && <span className="text-muted-foreground shrink-0 text-xs">{t(`state.${agent.state}`)}</span>}
      </div>
      {line && <p className="text-muted-foreground line-clamp-2 text-xs">{line}</p>}
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
        {agent?.agent && agent.named && (
          <>
            <dt>{t('card.runsAs')}</dt>
            <dd className="text-foreground min-w-0 truncate">{agentDisplayName(agent.agent)}</dd>
          </>
        )}
        {model && (
          <>
            <dt>{t('card.model')}</dt>
            <dd className="text-foreground min-w-0 truncate">{model}</dd>
          </>
        )}
        <dt>{t('card.session')}</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="text-foreground min-w-0 truncate font-mono tabular-nums" title={sessionId}>
            {sessionId.slice(0, 8)}
          </span>
          <CopyButton code={sessionId} label={t('card.copyId')} size="sm" hintSide="top" />
        </dd>
      </dl>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground focus-visible:text-foreground flex w-fit items-center gap-1 text-xs"
        >
          {t('card.openNewTab')}
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
      )}
    </div>
  );
}

/** What an inline agent's card shows: it has no session, so the row's own facts. */
export interface AgentInlineDetail {
  state?: string;
  task?: string;
  model?: string | null;
  /** One line on where it ran, or why it never did. */
  note?: string;
}

/**
 * The hover card of an agent that ran inside this session (pi `session: "same"`):
 * the same card without the session line, and a note saying where it ran.
 */
export function AgentInlineHoverCard({
  name,
  detail,
  className,
  children,
}: {
  name: string;
  detail: AgentInlineDetail;
  className?: string;
  children: ReactElement;
}) {
  return (
    <LazyAgentCard className={className} card={() => <InlineCardBody name={name} detail={detail} />}>
      {children}
    </LazyAgentCard>
  );
}

function InlineCardBody({ name, detail }: { name: string; detail: AgentInlineDetail }) {
  const t = useTranslations('tools.agent');
  const model = detail.model?.split('/').pop() ?? null;
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5 text-sm" data-slot="agent-hover-card">
      <div className="flex min-w-0 items-center gap-2">
        <p className="text-foreground min-w-0 flex-1 truncate font-medium">{name}</p>
        {detail.state && <span className="text-muted-foreground shrink-0 text-xs">{detail.state}</span>}
      </div>
      {detail.task && <p className="text-muted-foreground line-clamp-2 text-xs">{detail.task}</p>}
      {model && (
        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-xs">
          <dt>{t('card.model')}</dt>
          <dd className="text-foreground min-w-0 truncate">{model}</dd>
        </dl>
      )}
      {detail.note && <p className="text-muted-foreground text-xs">{detail.note}</p>}
    </div>
  );
}
