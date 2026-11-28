'use client';

import { stopProjectSession, type ProjectSession } from '@kortix/sdk';
import { qk, useNow, useProjectSession, usePromptAttachments } from '@kortix/sdk/react';
import { ArrowSquareOutIcon, SquareIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';


import { useTranslations } from '../../i18n';
import { agentDisplayName } from '../../internal/components/agent-mark';
import { SESSION_BAR_CLASS } from '../../internal/layout/panel-chrome';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { ErrorState } from '../../primitives/error-state';
import { Hint } from '../../primitives/hint';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '../../primitives/modal';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink } from '../../providers/ui-provider';
import { useSessionIds } from '../../providers/session-ids';
import { appendMentionRefs } from '../../internal/lib/project-preamble';
import { SessionChatInput } from '../composer/session-chat-input';
import { agentRowOf, isActive, shortElapsed, type AgentRow } from './agent-model';
import { AgentChip, AgentFailure } from './agent-surface';
import { AgentStateMark } from './agent-state-mark';
import { LegacySubagentChat } from './legacy-subagent-chat';
import { SessionPeek } from './session-peek';
import { useSteerSession } from './steer-session';

/** A mouse or trackpad: focusing a text field there opens no on-screen keyboard. */
function finePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
}

export interface SubagentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The child session: a Kortix project session, or an in-process child's runtime id. */
  sessionId: string;
  /** What the opener calls it; the session's own handle wins once its row loads. */
  title?: string;
  /** The project; default: the project of the session page the dialog opens over. */
  projectId?: string;
  /** Why it did not finish, when the opener knows: one sentence, the raw text behind Details. */
  failure?: string;
}


/**
 * Which body a child gets. A child that is its own project session (every
 * sub-agent, teammate and workflow agent since each runs on its own computer)
 * answers `GET /projects/:pid/sessions/:child` and reads its own log
 * (`SessionPeek`). A child that answers 404 or 400 there is not a project
 * session (an in-process `session: "same"` child, an old OpenCode subagent):
 * its transcript lives in the lead's computer, so it keeps the legacy chat.
 * Any other failure is a failed read of a real child: the surface says so.
 */
function bodyKind(row: ReturnType<typeof useProjectSession>, projectId: string | undefined): 'peek' | 'legacy' | 'loading' | 'error' {
  if (!projectId) return 'legacy';
  if (row.data) return 'peek';
  if (row.isError) {
    const status = (row.error as { status?: number } | null)?.status;
    return status === 404 || status === 400 ? 'legacy' : 'error';
  }
  return 'loading';
}

/** One child session, read live: its row, its state words, Stop. The dialog and the pane share it. */
function useSubagent(projectId: string | undefined, sessionId: string, title: string | undefined, enabled: boolean) {
  const t = useTranslations('multiAgent.subagent');
  const tStrip = useTranslations('multiAgent.strip');
  const row = useProjectSession(projectId, sessionId, { enabled: enabled && !!projectId });
  const kind = bodyKind(row, projectId);
  const agent: AgentRow | null = row.data ? agentRowOf(row.data as ProjectSession) : null;
  const name = agent?.named ? agent.handle : title || agent?.handle || t('fallbackTitle');
  const working = agent?.state === 'working';
  const now = useNow(1_000, enabled && working);
  const queryClient = useQueryClient();

  // The header's state follows the transcript: a new message re-reads the row.
  const refreshRow = () => projectId && void queryClient.invalidateQueries({ queryKey: qk.project.session(projectId, sessionId) });
  const stop = useMutation({
    mutationFn: () => stopProjectSession(projectId!, sessionId),
    onSettled: refreshRow,
    onError: (error) => errorToast(tStrip('stopAgentFailed', { name }), { description: error instanceof Error ? error.message : undefined }),
  });

  const stateText = agent
    ? agent.state === 'working' && agent.workingSinceMs !== null
      ? tStrip('workingFor', { elapsed: shortElapsed(now - agent.workingSinceMs) })
      : tStrip(`state.${agent.state}`)
    : null;

  return { row, kind, agent, name, working, stateText, stop, refreshRow };
}

type Subagent = ReturnType<typeof useSubagent>;

/** Open page and Stop: the header actions both surfaces carry. */
function SubagentActions({
  sub,
  projectId,
  sessionId,
  onLeave,
  children,
}: {
  sub: Subagent;
  projectId: string | undefined;
  sessionId: string;
  onLeave: () => void;
  /** The last member of the group: Close. */
  children?: React.ReactNode;
}) {
  const t = useTranslations('multiAgent.subagent');
  const tStrip = useTranslations('multiAgent.strip');
  return (
    // One group, secondary buttons: Open page, Stop while it works, Close. On a phone Open page is its icon.
    // Two groups a gap apart (the primitive spaces nested groups with gap-2): a missed tap on Close never stops the agent.
    <ButtonGroup className="shrink-0">
      <ButtonGroup>
      {projectId && sub.kind === 'peek' && (
        <Hint label={t('openPage')} side="bottom">
          <Button asChild variant="secondary" size="icon">
            <UiLink href={uiRoutes().session(projectId, sessionId)} onClick={onLeave} aria-label={t('openPage')}>
              <ArrowSquareOutIcon className="size-3.5 shrink-0" />
            </UiLink>
          </Button>
        </Hint>
      )}
      {sub.agent && isActive(sub.agent.state) && (
        <Hint label={tStrip('stopHint')} side="bottom">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label={tStrip('stopAgent', { name: sub.name })}
            disabled={sub.stop.isPending}
            aria-busy={sub.stop.isPending}
            onClick={() => sub.stop.mutate()}
          >
            <SquareIcon weight="fill" className="size-2.5" />
          </Button>
        </Hint>
      )}
      </ButtonGroup>
      <ButtonGroup>{children}</ButtonGroup>
    </ButtonGroup>
  );
}

function CloseAction({ onClose }: { onClose: () => void }) {
  const t = useTranslations('multiAgent.subagent');
  return (
    <Button type="button" variant="secondary" size="icon" aria-label={t('close')} onClick={onClose}>
      <XIcon className="size-3.5" />
    </Button>
  );
}

/** The transcript, the legacy chat, an error or a skeleton, by `bodyKind`. */
function SubagentBody({ sub, projectId, sessionId, density }: { sub: Subagent; projectId: string | undefined; sessionId: string; density?: 'compact' }) {
  if (sub.kind === 'peek' && projectId) {
    return <SessionPeek projectId={projectId} sessionId={sessionId} working={sub.working} onActivity={sub.refreshRow} density={density} />;
  }
  if (sub.kind === 'legacy') return <LegacySubagentChat sessionId={sessionId} />;
  if (sub.kind === 'error') return <SessionPeekRowError onRetry={() => void sub.row.refetch()} />;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-7 pt-6" aria-busy="true">
      <Skeleton className="ml-auto h-9 w-2/5 rounded-xl" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

export function SubagentDialogContent({ open, onOpenChange, sessionId, title, projectId: projectIdProp, failure }: SubagentDialogProps) {
  const tStrip = useTranslations('multiAgent.strip');
  const tNotice = useTranslations('multiAgent.notice');
  const ids = useSessionIds();
  const projectId = projectIdProp ?? ids.projectId ?? undefined;
  const sub = useSubagent(projectId, sessionId, title, open);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        variant="base"
        showCloseButton={false}
        data-testid="subagent-dialog"
        data-body={sub.kind}
        // Open, the message box takes the focus (type at once), never Stop: a focused Stop shows its tooltip.
        onOpenAutoFocus={(event) => {
          // Never Stop (its tooltip would pop). With a mouse the box takes the focus; on a touch screen the
          // dialog does, so no keyboard covers the transcript the person opened it to read.
          const content = event.currentTarget as HTMLElement | null;
          const box = content?.querySelector<HTMLInputElement>('[data-testid="subagent-dialog-message"]');
          event.preventDefault();
          if (box && finePointer()) box.focus();
          else content?.focus();
        }}
        className={cn(
          'flex flex-col gap-0 space-y-0 overflow-hidden p-0',
          // lg:max-w-* is required: the base modal sets lg:max-w-lg, which
          // tailwind-merge does not strip for an unprefixed override.
          'h-[80vh] max-h-[840px] lg:h-[80vh] lg:max-w-6xl',
          // A small window gets the whole screen: no sheet edge to aim at.
          'max-[720px]:inset-0 max-[720px]:h-dvh max-[720px]:max-h-none max-[720px]:rounded-none',
        )}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b py-2.5 pr-3 pl-4">
          {sub.agent && <AgentStateMark state={sub.agent.state} size="md" />}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <ModalTitle className="min-w-0 truncate text-sm font-medium">{sub.name}</ModalTitle>
              {sub.stateText && <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{sub.stateText}</span>}
            </div>
            <ModalDescription className="text-muted-foreground truncate text-xs">
              {sub.agent?.agent && sub.agent.named ? tStrip('runsAs', { agent: agentDisplayName(sub.agent.agent) }) : null}
            </ModalDescription>
          </div>
          <SubagentActions sub={sub} projectId={projectId} sessionId={sessionId} onLeave={() => onOpenChange(false)}>
            <CloseAction onClose={() => onOpenChange(false)} />
          </SubagentActions>
        </div>

        {failure && (
          <div data-testid="subagent-dialog-failure" className="shrink-0 border-b px-4 py-2.5 text-sm">
            <AgentFailure sentence={tNotice('failedSentence')} raw={failure} />
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <SubagentBody sub={sub} projectId={projectId} sessionId={sessionId} />
        </div>

        {sub.kind === 'peek' && projectId && (
          <SubagentMessageBox key={sessionId} projectId={projectId} sessionId={sessionId} name={sub.name} onSent={sub.refreshRow} />
        )}
      </ModalContent>
    </Modal>
  );
}

export interface SubagentPanelProps {
  /** The child session. */
  sessionId: string;
  /** What the chat row calls it; the session's own handle wins once its row loads. */
  title?: string;
  /** The agent's handle, for its pixel mark. */
  handle?: string;
  projectId?: string;
  /** What it works on, as the chat row says it; the session's own name wins. */
  task?: string;
  /** Why it did not finish, when the chat row knows. */
  failure?: string;
  /** Closes the side panel's detail. */
  onClose: () => void;
  /** What leads the header: the panel's sidebar toggle, when the panel fills the window. */
  leading?: React.ReactNode;
}

/**
 * An agent's session in the side panel, opened from its row in the chat:
 *
 *   [face] pricing-scout  ◔ Working for 2m            [Open page][■] [×]
 *   the agent's conversation, live
 *   [+  Message pricing-scout…                                    ↑]
 *
 * The same reads and actions as the agent dialog, in the panel's header grammar.
 */
export function SubagentPanel({ sessionId, title, handle, projectId: projectIdProp, task: taskProp, failure, onClose, leading }: SubagentPanelProps) {
  const tNotice = useTranslations('multiAgent.notice');
  const ids = useSessionIds();
  const projectId = projectIdProp ?? ids.projectId ?? undefined;
  const sub = useSubagent(projectId, sessionId, title, true);
  const tAgent = useTranslations('tools.agent');
  const now = useNow(1_000, sub.working);
  const face = handle || sub.agent?.agent || 'general';
  // The name the person clicked in the chat; what the agent works on, muted, after it.
  const name = title || sub.name;
  const ownName = typeof sub.row.data?.name === 'string' ? sub.row.data.name : '';
  const task = [ownName, taskProp].find((line) => !!line && line !== name) ?? null;
  // The chat row's state words ("Done", "Working"), so the row and its panel read the same.
  const stateText = sub.agent ? tAgent(`state.${sub.agent.state}`) : null;
  const elapsed = sub.agent?.state === 'working' && sub.agent.workingSinceMs !== null ? shortElapsed(now - sub.agent.workingSinceMs) : null;
  return (
    <section data-testid="subagent-panel" data-body={sub.kind} aria-label={name} className="flex h-full min-h-0 min-w-0 flex-col">
      {/* The shared session bar (`panel-chrome.ts`): same height and rule as the chat header beside it, so the two lines meet. */}
      <header className={cn(SESSION_BAR_CLASS, 'gap-2 px-3')}>
        {leading}
        {/* The face and the name are one target: hover fills it, and it opens the details
            (state with its time, then the task). No status icon in the bar. */}
        <HoverCard openDelay={300} closeDelay={100}>
          <HoverCardTrigger asChild>
            <div
              tabIndex={0}
              className="hover:bg-secondary focus-visible:ring-ring duration-fast -ml-1.5 flex h-8 min-w-0 cursor-default items-center gap-2 rounded-md px-1.5 transition-colors outline-none focus-visible:ring-2"
            >
              <h2 data-agent-state={sub.agent?.state} className="flex min-w-0">
                <AgentChip handle={face} name={name} plain className="max-w-none" />
              </h2>
            </div>
          </HoverCardTrigger>
          <HoverCardContent side="bottom" align="start" sideOffset={6} animated={false} className="w-64 p-3">
            <p className="text-foreground truncate text-sm font-medium">{name}</p>
            {sub.agent ? (
              <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs tabular-nums">
                <AgentStateMark state={sub.agent.state} />
                <span>{[stateText, elapsed].filter(Boolean).join(' · ')}</span>
              </p>
            ) : null}
            {task ? <p className="text-muted-foreground border-border mt-2.5 line-clamp-3 border-t pt-2.5 text-xs text-pretty">{task}</p> : null}
          </HoverCardContent>
        </HoverCard>
        <span className="min-w-0 flex-1" />
        <SubagentActions sub={sub} projectId={projectId} sessionId={sessionId} onLeave={onClose}>
          <CloseAction onClose={onClose} />
        </SubagentActions>
      </header>
      {failure && (
        <div data-testid="subagent-panel-failure" className="shrink-0 px-3 pb-2.5 text-sm">
          <AgentFailure sentence={tNotice('failedSentence')} raw={failure} />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <SubagentBody sub={sub} projectId={projectId} sessionId={sessionId} density="compact" />
      </div>
      {sub.kind === 'peek' && projectId && (
        <SubagentMessageBox key={sessionId} projectId={projectId} sessionId={sessionId} name={name} onSent={sub.refreshRow} className="px-3 pb-3" autoFocus={false} />
      )}
    </section>
  );
}

function SessionPeekRowError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('multiAgent.subagent');
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <ErrorState
        size="sm"
        title={t('loadFailed')}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        }
      />
    </div>
  );
}

/**
 * The message box under the transcript, one pill: + attaches images, the text,
 * and Enter sends it to the agent as a steer. Attached images show as chips
 * above the text until the message is sent.
 */
function SubagentMessageBox({
  projectId,
  sessionId,
  name,
  onSent,
  className,
  autoFocus = true,
}: {
  projectId: string;
  sessionId: string;
  name: string;
  onSent: () => void;
  className?: string;
  /** The dialog types at once; the panel beside the chat leaves the focus in the chat. */
  autoFocus?: boolean;
}) {
  const t = useTranslations('multiAgent.subagent');
  const uploads = usePromptAttachments(projectId);
  const send = useSteerSession(projectId);
  // The main composer in its one-row `inline` mode: the same @ menu, paste and
  // attachments, growing into the card when the text wraps. A message steers
  // the sub-agent through the API's prompt route.
  return (
    <div data-testid="subagent-dialog-message" className={cn('shrink-0 px-4 pb-4', className)}>
      <SessionChatInput
        inline
        hideAgentPicker
        projectId={projectId}
        sessionId={sessionId}
        promptAttachments={uploads}
        placeholder={t('messagePlaceholder', { name })}
        // Static: the composer's rotating tips (⌘K, / commands) are for the main chat.
        hint={t('messagePlaceholder', { name })}
        autoFocus={autoFocus && finePointer()}
        isSending={send.isPending}
        clearOnSend
        cardClassName="rounded-lg"
        underbarPlacement="inline"
        slashMenuPlacement="above"
        onSend={async (text, _files, mentions, attachments) => {
          const message = appendMentionRefs(text.trim(), mentions);
          try {
            const files = attachments ? await attachments.whenReady() : [];
            await send.mutateAsync({ sessionId, text: message, files });
            attachments?.release();
            successToast(t('sent'));
            onSent();
          } catch (error) {
            errorToast(t('sendFailed'), { description: error instanceof Error ? error.message : undefined });
            throw error;
          }
        }}
      />
    </div>
  );
}
