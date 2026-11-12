'use client';

import { Button } from '@kortix/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@kortix/ui/disclosure';
import { Hint } from '@kortix/ui/hint';
import { InputGroup, InputGroupAddon, InputGroupButton } from '@kortix/ui/input-group';
import Loading from '@kortix/ui/loading';
import { UnifiedMarkdown } from '@kortix/ui/markdown';
import { Skeleton } from '@kortix/ui/skeleton';
import { successToast } from '@kortix/ui/toast';
import { formatGoalTime, goalPaused, GoalStatusIcon, goalStatusIconState, useGoalClock } from '@kortix/ui/workspace';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { generateSessionId, type ProjectGoal, type ProjectGoalEvent, type ProjectGoalStatus } from '@kortix/sdk';
import { useProjectGoalEvents } from '@kortix/sdk/react';
import { ArrowUpIcon, CaretDownIcon, CaretRightIcon, ChatTextIcon, CheckCircleIcon } from '@phosphor-icons/react';
import { useRef, useState, type ReactNode } from 'react';

import { type GoalActions } from './goal-controls';
import { parseGoalLog, withoutTitle } from './goal-log';
import { GoalFilesData, SectionTitle, text } from './goal-parts';

/** The goal page's activity feed, the agent's log and the verifier's report, with the answer and note boxes. */


/**
 * One box, two jobs: the answer to the goal's question, or a note to the
 * owner agent while it works. Both go through `POST …/answer`, attributed to
 * the signed-in person. Each text gets one `answerId`, kept across retries
 * and replaced when the text changes, so a retry lands once. ⌘/Ctrl+Enter sends.
 */
function MessageBox({ projectId, goal, kind, actions }: { projectId: string; goal: ProjectGoal; kind: 'answer' | 'message'; actions: GoalActions }) {
  const t = useTranslations('goals');
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(false);
  const answerId = useRef(generateSessionId());
  const sending = actions.pending === 'answer';
  const failed = actions.failure?.input.action === 'answer';
  const send = async () => {
    const value = draft.trim();
    if (!value || sending) return;
    const ok = await actions.run({ goal, action: 'answer', text: value, answerId: answerId.current });
    if (ok) {
      setDraft('');
      setSent(true);
      answerId.current = generateSessionId();
      successToast(kind === 'answer' ? t('answerSentToast') : t('messageSentToast'));
    }
  };
  const sendLabel = kind === 'answer' ? t('sendAnswer') : t('sendMessage');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="flex flex-col gap-2"
    >
      <InputGroup className="bg-background items-stretch rounded-xl">
        <textarea
          rows={kind === 'answer' ? 3 : 2}
          value={draft}
          readOnly={sending}
          onChange={(event) => {
            setDraft(event.target.value);
            // New words are a new answer: a retry of the old one must not carry them.
            answerId.current = generateSessionId();
            if (sent) setSent(false);
            if (failed) actions.dismiss();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
          }}
          placeholder={kind === 'answer' ? t('answerPlaceholder') : t('messagePlaceholder')}
          aria-label={kind === 'answer' ? t('answerLabel') : t('messageLabel')}
          className="text-foreground placeholder:text-muted-foreground w-full min-w-0 resize-none bg-transparent px-4 pt-4 text-sm outline-none"
          data-testid={kind === 'answer' ? 'goal-answer' : 'goal-message'}
        />
        <InputGroupAddon align="block-end" className="justify-between gap-2 px-4 pt-2 pb-3">
          {sent ? (
            <span className="text-muted-foreground text-xs" role="status">
              {kind === 'answer' ? t('answerSent') : t('messageSent')}
            </span>
          ) : (
            <span />
          )}
          <InputGroupButton
            type="submit"
            size="sm"
            variant="default"
            className="gap-1.5 rounded-lg"
            aria-label={sendLabel}
            disabled={!draft.trim() || sending}
            aria-busy={sending}
            data-testid={kind === 'answer' ? 'goal-answer-send' : 'goal-message-send'}
          >
            {sending ? <Loading className="size-3.5 shrink-0" /> : <ArrowUpIcon weight="bold" className="size-3.5" aria-hidden />}
            {failed ? t('retry') : t('send')}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {failed ? (
        <p className="text-destructive text-xs" role="alert" data-testid="goal-answer-error">
          {kind === 'answer' ? t('answerError') : t('messageError')}
          {actions.failure?.message ? ` ${actions.failure.message}` : ''}
        </p>
      ) : null}
    </form>
  );
}

type FeedItem = { key: string; at: string | null; icon: ReactNode; title: ReactNode; body?: ReactNode };

/** Events the feed leaves out: one per admitted wake says nothing a person needs. */
const QUIET_EVENTS = new Set(['wake_admitted']);

/** An event's glyph: the state it moved to, else its kind. */
function eventIcon(event: ProjectGoalEvent): ReactNode {
  if (event.kind === 'created') return <CheckCircleIcon weight="fill" className="text-kortix-green size-4" aria-hidden />;
  if (event.kind === 'paused') return <GoalStatusIcon state="paused" />;
  if (event.kind === 'blocked' || event.kind === 'wake_refused') return <GoalStatusIcon state="attention" />;
  if (event.to_state && event.to_state !== event.from_state) return <StatusGlyph status={event.to_state} />;
  return <ChatTextIcon className="text-muted-foreground size-4" aria-hidden />;
}

/**
 * What happened, oldest first: the goal's events from the API (every state
 * move, pause, answer, verification and refusal, each with who and when),
 * the agent's latest summary, and the verifier's report under the verdict.
 * The agent's own log (log.md, notes.md) opens from the heading's right.
 */
function Activity({ projectId, goal, files, actions }: { projectId: string; goal: ProjectGoal; files: GoalFilesData | null; actions: GoalActions }) {
  const t = useTranslations('goals');
  const locale = useLocale();
  const now = useGoalClock();
  const events = useProjectGoalEvents(projectId, goal.goalId);
  const record = goal.record;
  const paused = goalPaused(goal);
  const open = goal.health.state !== 'closed';
  const waiting = open && !paused && record.state === 'waiting_on_user';
  const [logOpen, setLogOpen] = useState(false);
  const hasLog = !!(files?.log || files?.notes);
  const list = (events.data?.events ?? []).filter((e) => !QUIET_EVENTS.has(e.kind));
  const verdictAt = files?.verification ? list.findLastIndex((e) => e.kind === 'verdict') : -1;
  const items: FeedItem[] = list.map((event, index) => ({
    key: event.id,
    at: event.at,
    icon: eventIcon(event),
    title: text(event.message) ?? event.kind,
    body: index === verdictAt && files?.verification ? <VerificationReport report={files.verification} /> : undefined,
  }));
  if (record.summary) {
    items.push({ key: 'summary', at: record.last_wake_at ?? record.updated_at, icon: <ChatTextIcon weight="fill" className="text-kortix-blue size-4" aria-hidden />, title: t('feed.update'), body: record.summary });
  }

  return (
    <section className="border-border flex flex-col gap-5 border-t pt-8" aria-label={t('activity')} data-testid="goal-activity">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-foreground text-base font-semibold">{t('activity')}</h2>
        {hasLog ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground -mr-2 gap-1"
            aria-expanded={logOpen}
            aria-controls={logOpen ? 'goal-log' : undefined}
            onClick={() => setLogOpen((v) => !v)}
            data-testid="goal-log-toggle"
          >
            {t('agentLog')}
            <CaretDownIcon className={logOpen ? 'size-3 rotate-180 transition-transform motion-reduce:transition-none' : 'size-3 transition-transform motion-reduce:transition-none'} aria-hidden />
          </Button>
        ) : null}
      </div>
      {events.isError ? (
        <p className="text-muted-foreground text-sm">
          {t('eventsLoadError')}{' '}
          <button type="button" className="text-foreground focus-visible:ring-ring rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2" onClick={() => events.refetch()}>
            {t('retry')}
          </button>
        </p>
      ) : events.isLoading ? (
        <Skeleton className="h-16 w-full rounded-md" />
      ) : (
        <ol className="relative flex flex-col gap-5 text-sm">
          {/* The thread: one hairline behind the glyphs, from the first entry to the last. */}
          <span className="bg-border absolute top-2.5 bottom-2.5 left-2 w-px" aria-hidden />
          {items.map((item) => (
            <li key={item.key} className="relative flex gap-3">
              <span className="bg-background relative flex h-5 w-4 shrink-0 items-center justify-center">{item.icon}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="flex flex-wrap items-baseline gap-x-2 leading-5">
                  <span className="text-foreground font-medium">{item.title}</span>
                  {item.at ? <FeedTime at={item.at} label={formatGoalTime(item.at, locale, now)} /> : null}
                </p>
                {typeof item.body === 'string' ? <p className="text-muted-foreground max-w-prose leading-5 text-pretty whitespace-pre-line">{item.body}</p> : item.body}
              </div>
            </li>
          ))}
        </ol>
      )}
      {logOpen && hasLog ? (
        <div id="goal-log" className="border-border flex flex-col gap-6 border-t pt-6" data-testid="goal-log">
          <SectionTitle>{t('agentLog')}</SectionTitle>
          {files?.log ? <GoalLog markdown={files.log} /> : null}
          {files?.notes ? (
            <div className="flex max-w-prose flex-col gap-2">
              <SectionTitle>{t('notes')}</SectionTitle>
              <UnifiedMarkdown content={withoutTitle(files.notes)} trust="untrusted" variant="document" className="text-sm" />
            </div>
          ) : null}
        </div>
      ) : null}
      {open && !paused && !waiting && goal.capabilities.answer ? <MessageBox projectId={projectId} goal={goal} kind="message" actions={actions} /> : null}
    </section>
  );
}

/** The exact local date and time, for a hint: "Wednesday, November 4, 2026 at 11:22:06 PM GMT+5:30". */
function exactTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'long' });
}

/** A feed entry's relative time; hover or focus shows the exact date and time. */
function FeedTime({ at, label }: { at: string; label: string }) {
  const locale = useLocale();
  return (
    <Hint label={exactTime(at, locale)} side="top" align="start" alignOffset={0} sideOffset={6}>
      <time dateTime={at} tabIndex={0} className="text-muted-foreground focus-visible:ring-ring rounded-sm text-xs whitespace-nowrap tabular-nums outline-none focus-visible:ring-2">
        {label}
      </time>
    </Hint>
  );
}

/** A log time in the reader's time zone: "Nov 4, 11:22 PM"; the year only when it is not this one. */
function formatLogTime(iso: string, locale: string, now: number): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString(locale, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The agent's log in file order: a timed line is a row (its local time, then what happened); other Markdown stays as written. */
function GoalLog({ markdown }: { markdown: string }) {
  const locale = useLocale();
  const now = useGoalClock();
  return (
    <div className="flex max-w-prose flex-col gap-2 text-sm">
      {parseGoalLog(markdown).map((block, index) =>
        block.kind === 'entry' ? (
          <div key={`${block.at}:${index}`} className="flex gap-4">
            <Hint label={exactTime(block.at, locale)} side="top" align="start" alignOffset={0} sideOffset={6}>
              <time dateTime={block.at} className="text-muted-foreground min-w-32 shrink-0 leading-6 whitespace-nowrap tabular-nums">
                {formatLogTime(block.at, locale, now)}
              </time>
            </Hint>
            <div className="text-foreground min-w-0 flex-1">
              <UnifiedMarkdown content={block.text} trust="untrusted" variant="message" className="text-sm" />
            </div>
          </div>
        ) : (
          <div key={`text:${index}`} className="py-1">
            <UnifiedMarkdown content={block.markdown} trust="untrusted" variant="document" className="text-sm" />
          </div>
        ),
      )}
    </div>
  );
}

/** A state move's glyph: the goal status icon of the state it moved to. */
function StatusGlyph({ status }: { status: ProjectGoalStatus }) {
  // Work in motion reads blue in the feed; done, waiting and closed keep the icon's own color.
  const moving = status === 'active' || status === 'verifying';
  return <GoalStatusIcon state={goalStatusIconState(status)} progress={0} tone={moving ? 'var(--kortix-blue)' : undefined} />;
}

/** The verifier's report, folded behind "Show report". */
function VerificationReport({ report }: { report: string }) {
  const t = useTranslations('goals');
  const [open, setOpen] = useState(false);
  return (
    <Disclosure open={open} onOpenChange={setOpen}>
      <DisclosureTrigger>
        <button type="button" className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs" data-testid="goal-report-toggle">
          <CaretRightIcon className="size-3 transition-transform data-[open=true]:rotate-90" data-open={open} aria-hidden />
          {open ? t('hideReport') : t('showReport')}
        </button>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className="max-w-prose pt-2">
          <UnifiedMarkdown content={withoutTitle(report)} trust="untrusted" variant="message" className="text-sm" />
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}

export { Activity, MessageBox };
