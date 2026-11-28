'use client';

import { ArrowUpRightIcon, CaretRightIcon } from '@phosphor-icons/react';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { useContext, useId, useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { AgentMarkGlyph, agentMarkTileClass, agentMarkVars } from '../../internal/components/agent-mark';
import { cn } from '../../lib/utils';
import { SessionStatusMark } from '../list/session-status-mark';
import type { SessionDisplayStatus } from '../actions/session-label';
import { TextShimmer } from '../../primitives/text-shimmer';
import { Hint } from '../../primitives/hint';
import { BoundActivateContext, ToolOutcomeContext, ToolRunningContext, ToolStartedAtContext, useToolOpen } from '../tool/shared/infrastructure-contexts';
import { ToolSurfaceContext } from '../tool/shared/surface';
import { AgentHoverCard, AgentInlineHoverCard, type AgentInlineDetail } from './agent-hover-card';

/**
 * The parts every MyKortix agent surface in the chat is drawn from. An agent
 * call, an agent's finish, a message to or from another agent and a workflow
 * agent are all one row grammar, the grammar of every other tool row:
 *
 *   [face] Title  what it is about…                 ◔ State
 *          │ the detail, on a rail in the icon lane, when the row opens
 *
 * The face is the agent's pixel mark in the 16px icon lane. The state is the
 * session list's static glyph and a muted word: the hue is on the glyph, never
 * on the words (color.md). A row opens in place; nothing opens beside the chat.
 */

/** An agent's own handle, or the lead session's generated handle, as a pixel-mark slug. */
export function agentSlug(handle: string): string {
  return /^(mykortix|meta)-[0-9a-f]{8}$/.test(handle) ? 'mykortix' : handle;
}

/** The agent's face: its pixel mark on its tile, 16px, in the row's icon lane. */
export function AgentFace({ handle, className }: { handle: string; className?: string }) {
  const slug = agentSlug(handle);
  return (
    <span
      aria-hidden
      data-tone="agent"
      style={agentMarkVars(slug)}
      className={cn('flex size-4 shrink-0 items-center justify-center rounded-sm bg-(--mark-tile)', agentMarkTileClass(slug), className)}
    >
      <AgentMarkGlyph slug={slug} size={14} />
    </span>
  );
}

/** A session-list glyph at 14px in a 14px slot. */
export function SmallGlyph({ status, label }: { status: SessionDisplayStatus; label?: string }) {
  return (
    <>
      <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5">
        <SessionStatusMark status={status} waitingOn="answer" />
      </span>
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

/**
 * An agent as one chip: its pixel mark and its name in a full-round pill. The
 * fill is the agent's colour (the mark's ink) at a medium tint, so every agent
 * reads as its own colour, grey ones included; the name stays in the
 * foreground ink. Every agent name on a MyKortix surface is this chip.
 * A chip that leads a row starts on the row's left edge, where every other
 * row's icon starts; that row draws no separate face.
 */
export function AgentChip({
  handle,
  name,
  className,
  plain = false,
}: {
  handle: string;
  name: ReactNode;
  className?: string;
  /** Mark and name only, no pill: for a header that already has its own surface. */
  plain?: boolean;
}) {
  const slug = agentSlug(handle);
  return (
    <span
      data-tone="agent"
      data-slot="agent-chip"
      style={{ ...agentMarkVars(slug), ...(plain ? {} : { backgroundColor: 'color-mix(in oklab, var(--mark-ink) 14%, transparent)' }) }}
      className={cn(
        'text-foreground flex h-6 max-w-44 min-w-0 shrink-0 items-center gap-1.5 text-sm',
        !plain && 'rounded-full pr-2.5 pl-1.5',
        className,
      )}
    >
      <span className="flex w-3.5 shrink-0 justify-center">
        <AgentMarkGlyph slug={slug} size={14} trim />
      </span>
      {/* A cut name stays readable on hover. */}
      <span className="min-w-0 truncate" title={typeof name === 'string' ? name : undefined}>
        {name}
      </span>
    </span>
  );
}

/** A Kortix session id. An inline run's pi thread id (`ses_pi…`) has no session to open. */
const PROJECT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The title and subtitle of an agent row. The title is a handle or a name, so it
 * yields past `max-w-40` and the subtitle (what the agent works on) keeps its room.
 * With `handle`, the title is the agent itself: it renders as its chip, after
 * `lead` when the row says something before the name ("To").
 */
export function AgentTrigger({
  title,
  subtitle,
  handle,
  lead,
  trail,
  sessionId,
  detail,
}: {
  title: string;
  subtitle?: string | null;
  handle?: string;
  lead?: string;
  trail?: string;
  /** The agent's own session: its chip then opens a hover card with the id and a link. */
  sessionId?: string | null;
  /** An agent without a session of its own: its chip's hover card shows these facts. */
  detail?: AgentInlineDetail;
}) {
  const running = useContext(ToolRunningContext);
  // The side panel is narrow: the name keeps its own line and what the agent
  // works on reads below it, so neither is cut to a few letters.
  const panel = useContext(ToolSurfaceContext) === 'panel';
  const startedAt = useContext(ToolStartedAtContext);
  const clock = panel && startedAt ? new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
  // In the chat a role name ("Bike delivery operations researcher") keeps its words; the
  // subtitle yields first. The narrow panel lets the chip shrink instead.
  // The panel names the agent by its mark and name, no tinted pill.
  const chip = handle ? <AgentChip handle={handle} name={title} plain={panel} className={panel ? 'max-w-none shrink' : 'max-w-64'} /> : null;
  const name = chip ? (
    sessionId && PROJECT_SESSION_ID.test(sessionId) ? (
      <AgentHoverCard sessionId={sessionId} name={title} className={panel ? 'shrink' : 'shrink-0'}>
        {chip}
      </AgentHoverCard>
    ) : detail ? (
      <AgentInlineHoverCard name={title} detail={detail} className={panel ? 'shrink' : 'shrink-0'}>
        {chip}
      </AgentInlineHoverCard>
    ) : (
      chip
    )
  ) : (
    <span className="text-foreground max-w-40 min-w-0 shrink-0 truncate text-sm" title={title}>
      {title}
    </span>
  );
  const leadWord = lead && <span className="text-foreground shrink-0 text-sm">{`${lead} `}</span>;
  const trailWord = trail && <span className="text-foreground shrink-0 text-sm">{` ${trail}`}</span>;
  const sub =
    subtitle &&
    (running ? (
      <TextShimmer className="min-w-0 flex-1 truncate text-sm">{subtitle}</TextShimmer>
    ) : (
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm font-normal" title={subtitle}>
        {subtitle}
      </span>
    ));
  if (panel) {
    // To whom, then what, then when on the right edge. The message reads in
    // full up to two lines, on the name's edge (past the 14px mark and its gap).
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {leadWord}
          {name}
          {trailWord}
          {clock && <span className="text-muted-foreground ml-auto shrink-0 pl-2 text-xs font-normal tabular-nums">{clock}</span>}
        </div>
        {subtitle && (
          <p className={cn('text-muted-foreground line-clamp-2 text-sm font-normal whitespace-normal', chip && 'pl-5')} title={subtitle}>
            {subtitle}
          </p>
        )}
      </div>
    );
  }
  return (
    <>
      {leadWord}
      {name}
      {trailWord}
      {sub}
    </>
  );
}

/**
 * The right edge of an agent row: the state glyph and its word, muted. A row
 * that opens ends in a caret, so it reads as one before anyone clicks it.
 */
export function AgentStatus({
  status,
  label,
  time,
  opens = false,
}: {
  status?: SessionDisplayStatus;
  label: string;
  time?: string;
  /** The row has a body to open: draw the caret. */
  opens?: boolean;
}) {
  const open = useToolOpen();
  // The side panel is narrow and its row draws its own disclosure caret: there
  // the state is the glyph alone, its word a hint (and read aloud), so the
  // agent's task keeps the width.
  if (useContext(ToolSurfaceContext) === 'panel') {
    // Done and working read from the glyph alone. Every other state (failed,
    // refused, expired, needs you) shares a glyph with others, so its word stays.
    const glyphOnly = status === 'done' || status === 'running';
    return (
      <Hint label={time ? `${label} · ${time}` : label} side="left">
        <span data-agent-status={status} className="text-muted-foreground flex shrink-0 items-center gap-1.5 pl-1 text-xs">
          {/* Done is a resting state: a meta-ink check. Green is for an agent that runs now. */}
          {status === 'done' ? (
            <>
              <SolidCheckIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="sr-only">{label}</span>
            </>
          ) : (
            status && <SmallGlyph status={status} label={glyphOnly ? label : undefined} />
          )}
          {(!glyphOnly || !status) && <span className="whitespace-nowrap">{label}</span>}
        </span>
      </Hint>
    );
  }
  return (
    <span data-agent-status={status} className="text-muted-foreground flex shrink-0 items-center gap-1.5 pl-3 text-xs">
      {status && <SmallGlyph status={status} />}
      <span className="whitespace-nowrap">{label}</span>
      {time && <span className="tabular-nums">{time}</span>}
      {/* The caret's slot is always there, so every row's state word ends on one edge. */}
      <CaretRightIcon
        aria-hidden
        data-slot={opens ? 'agent-row-caret' : undefined}
        className={cn(
          'size-3 shrink-0 transition-transform duration-(--duration-fast) motion-reduce:transition-none',
          !opens && 'invisible',
          open && 'rotate-90',
        )}
      />
    </span>
  );
}

/**
 * An agent row's detail, when it opens: on a rail in the icon lane (the centre
 * of the 16px face), its text on the title's left edge, at the chat's reading size.
 */
export function AgentRowBody({ children, className }: { children: ReactNode; className?: string }) {
  // The side panel's card already frames the body: no rail there.
  const panel = useContext(ToolSurfaceContext) === 'panel';
  return (
    // In the panel the body starts on the message column, under the name.
    <div className={cn('flex min-w-0 flex-col gap-2.5 text-sm', panel ? 'py-0.5 pl-5' : 'border-border ml-2 border-l py-1 pl-3', className)}>
      {children}
    </div>
  );
}

/**
 * The agent rows own their disclosure: a click opens the row in place. The chat
 * would otherwise route a tool row's click into the side panel, and an errored
 * call would trade the agent's face for the warning triangle; the state word says it.
 */
export function AgentRowScope({ children }: { children: ReactNode }) {
  return (
    <BoundActivateContext.Provider value={null}>
      <ToolOutcomeContext.Provider value="ok">
        {children}
      </ToolOutcomeContext.Provider>
    </BoundActivateContext.Provider>
  );
}

/** "Open" on an agent row's body: the agent's own conversation, in the agent dialog. */
export function OpenAgentButton({ onClick, label, children }: { onClick: () => void; label: string; children?: ReactNode }) {
  const t = useTranslations('tools.agent');
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="text-foreground hover:bg-muted/60 -ml-1.5 flex h-7 w-fit cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs transition-colors"
    >
      {children ?? t('open')}
      <ArrowUpRightIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
    </button>
  );
}

/**
 * Why an agent did not finish: one sentence in ink, and the raw text the
 * platform or provider gave behind "Details", in mono (layout.md, errors).
 */
export function AgentFailure({ sentence, raw }: { sentence: string; raw?: string | null }) {
  const t = useTranslations('multiAgent.notice');
  const [open, setOpen] = useState(false);
  const id = useId();
  const detail = raw?.trim();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-foreground">{sentence}</p>
      {detail && detail !== sentence && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
            className="text-muted-foreground hover:text-foreground flex w-fit cursor-pointer items-center gap-1 text-xs"
          >
            <CaretRightIcon aria-hidden className={cn('size-3 transition-transform duration-(--duration-fast) motion-reduce:transition-none', open && 'rotate-90')} />
            {t('details')}
          </button>
          {open && (
            <pre id={id} className="text-muted-foreground font-mono text-xs whitespace-pre-wrap wrap-break-word">
              {detail}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/** A team task's status as a session-list glyph: open is a grey ring, in progress the working arc, done the done ring. */
export function taskGlyphStatus(status: 'pending' | 'in_progress' | 'completed'): SessionDisplayStatus {
  return status === 'completed' ? 'done' : status === 'in_progress' ? 'running' : 'starting';
}

/** Who owns a task or sent a message: the agent's face and its handle. */
export function AgentHandle({ handle }: { handle: string }) {
  return (
    <AgentChip handle={handle} name={`@${handle}`} className="max-w-36" />
  );
}
