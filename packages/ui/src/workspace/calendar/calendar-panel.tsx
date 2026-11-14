'use client';

// The side panel: one calendar item (when, owner, notes, comments) or one
// scheduled trigger or Loop (read only, with a link to Triggers).
import type { CalendarAssigneeInput, CalendarItem } from '@kortix/sdk';
import { ApiError } from '@kortix/sdk';
import { useWorkspaceCalendarActions, useWorkspaceCalendarItem } from '@kortix/sdk/react';
import { agentDisplayName } from '@kortix/shared';
import { ArrowSquareOutIcon, CheckCircleIcon, CircleIcon, DotsThreeIcon, TrashIcon, UserCircleIcon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { describeCadence, describeEvery, describeOneOff } from '../../customize/triggers/schedule/schedule-copy';
import { useLocale, useTranslations } from '../../i18n';
import { adminPath, uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { Checkbox } from '../../primitives/checkbox';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { ErrorState } from '../../primitives/error-state';
import { Input } from '../../primitives/input';
import { Skeleton } from '../../primitives/skeleton';
import { SplitSheetBody, SplitSheetHeader, SplitSheetTitle } from '../../primitives/split-sheet';
import { errorToast } from '../../primitives/toast';
import { UiLink } from '../../providers/ui-provider';
import { fromLocalInput, toLocalInput } from './calendar-dates';
import { MentionText, personName, Who, type CalendarDirectory } from './calendar-people';
import { everySeconds, type ScheduledFire } from './calendar-scheduled';
import { MentionTextarea } from './mention-textarea';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** Who owns the item: nobody, a person (People first) or an agent. */
export function OwnerMenu({
  assignee,
  directory,
  onChange,
}: {
  assignee: CalendarItem['assignee'];
  directory: CalendarDirectory;
  onChange: (assignee: CalendarAssigneeInput | null) => void;
}) {
  const t = useTranslations('calendar');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="-ml-2.5 max-w-full justify-start font-normal">
          {assignee ? (
            <Who who={assignee} directory={directory} unknown={t('formerMember')} />
          ) : (
            <span className="text-muted-foreground inline-flex items-center gap-1.5">
              <UserCircleIcon className="size-4" aria-hidden />
              {t('nobody')}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onChange(null)}>{t('nobody')}</DropdownMenuItem>
        {directory.people.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('people')}</DropdownMenuLabel>
            {directory.people.map((person) => (
              <DropdownMenuItem key={person.user_id} onSelect={() => onChange({ user_id: person.user_id })}>
                <Who who={{ kind: 'person', user_id: person.user_id }} directory={directory} unknown={personName(person, person.handle)} />
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {directory.agents.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('agents')}</DropdownMenuLabel>
            {directory.agents.map((agent) => (
              <DropdownMenuItem key={agent} onSelect={() => onChange({ agent })}>
                <Who who={{ kind: 'agent', agent }} directory={directory} unknown={agent} />
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A date and time, or a date only, or none. Saved when the field loses focus. */
export function WhenField({
  startsAt,
  allDay,
  onChange,
}: {
  startsAt: string | null;
  allDay: boolean;
  onChange: (value: { starts_at: string | null; all_day: boolean }) => void;
}) {
  const t = useTranslations('calendar');
  const initial = allDay ? (startsAt?.slice(0, 10) ?? '') : toLocalInput(startsAt);
  const [value, setValue] = useState(initial);
  // A new value from the server replaces the draft (adjust state while rendering, no effect).
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setValue(initial);
  }
  const commit = (next: string, nextAllDay: boolean) => {
    if (!next) return onChange({ starts_at: null, all_day: false });
    if (nextAllDay) return onChange({ starts_at: `${next.slice(0, 10)}T00:00:00.000Z`, all_day: true });
    const iso = fromLocalInput(next);
    if (iso) onChange({ starts_at: iso, all_day: false });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type={allDay ? 'date' : 'datetime-local'}
        value={value}
        aria-label={t('when')}
        className="h-8 w-auto"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => value !== initial && commit(value, allDay)}
        onKeyDown={(event) => event.key === 'Enter' && commit(value, allDay)}
      />
      <label className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <Checkbox
          checked={allDay}
          onCheckedChange={(checked) => {
            const nextAllDay = checked === true;
            const next = value ? (nextAllDay ? value.slice(0, 10) : `${value.slice(0, 10)}T09:00`) : '';
            setValue(next);
            if (next) commit(next, nextAllDay);
          }}
        />
        {t('allDay')}
      </label>
      {startsAt ? (
        <Button variant="ghost" size="xs" onClick={() => onChange({ starts_at: null, all_day: false })}>
          {t('clearDate')}
        </Button>
      ) : null}
    </div>
  );
}

function useStamp() {
  const locale = useLocale();
  const format = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (iso: string) => format.format(new Date(iso));
}

export function ItemPanel({
  projectId,
  itemId,
  directory,
  onClose,
}: {
  projectId: string;
  itemId: string;
  directory: CalendarDirectory;
  onClose: () => void;
}) {
  const t = useTranslations('calendar');
  const stamp = useStamp();
  const query = useWorkspaceCalendarItem(projectId, itemId);
  const actions = useWorkspaceCalendarActions(projectId);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [comment, setComment] = useState('');
  const [confirming, setConfirming] = useState(false);
  const item = query.data?.item;
  // The stored title and notes replace the drafts when they change on the server.
  const stored = item ? `${item.title}\u0000${item.notes}` : null;
  const [seen, setSeen] = useState<string | null>(null);
  if (item && stored !== seen) {
    setSeen(stored);
    setTitle(item.title);
    setNotes(item.notes);
  }

  const save = (input: Parameters<typeof actions.update.mutate>[0]['input']) =>
    actions.update.mutate({ itemId, input }, { onError: (error) => errorToast(error instanceof Error ? error.message : t('saveFailed')) });

  if (query.isPending) {
    return (
      <SplitSheetBody className="flex flex-col gap-3">
        <Skeleton className="h-7 w-2/3 rounded-md" />
        <Skeleton className="h-24 w-full rounded-md" />
      </SplitSheetBody>
    );
  }
  if (!item) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return (
      <>
        <SplitSheetHeader closeLabel={t('close')}>
          <SplitSheetTitle>{gone ? t('goneTitle') : t('itemLoadFailed')}</SplitSheetTitle>
        </SplitSheetHeader>
        <SplitSheetBody>
          {gone ? (
            <p className="text-muted-foreground text-sm">{t('goneBody')}</p>
          ) : (
            <ErrorState size="sm" title={t('itemLoadFailed')} action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t('tryAgain')}</Button>} />
          )}
        </SplitSheetBody>
      </>
    );
  }

  const done = item.status === 'done';
  const comments = query.data?.comments ?? [];
  const send = () => {
    const body = comment.trim();
    if (!body || actions.comment.isPending) return;
    actions.comment.mutate(
      { itemId, body },
      {
        onSuccess: () => setComment(''),
        onError: (error) => errorToast(error instanceof Error ? error.message : t('commentFailed')),
      },
    );
  };
  const author = item.created_by;

  return (
    <>
      <SplitSheetHeader closeLabel={t('close')} className="items-center">
        <SplitSheetTitle className="sr-only">{item.title}</SplitSheetTitle>
        {/* The header stacks its children; the actions keep their own size on one row. */}
        <div className="flex items-center gap-1">
          <Button
            variant={done ? 'outline' : 'default'}
            size="xs"
            className="gap-1.5"
            aria-busy={actions.update.isPending}
            disabled={actions.update.isPending}
            onClick={() => save({ status: done ? 'open' : 'done' })}
          >
            {done ? <CircleIcon className="size-3.5 shrink-0" aria-hidden /> : <CheckCircleIcon className="size-3.5 shrink-0" aria-hidden />}
            {done ? t('reopen') : t('markDone')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('moreActions')}>
                <DotsThreeIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                <TrashIcon aria-hidden />
                {t('delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SplitSheetHeader>
      <SplitSheetBody className="flex flex-col gap-6">
        <textarea
          value={title}
          rows={1}
          aria-label={t('titleLabel')}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value.replace(/\n/g, ' '))}
          onBlur={() => {
            const next = title.trim();
            if (!next) setTitle(item.title);
            else if (next !== item.title) save({ title: next });
          }}
          onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), event.currentTarget.blur())}
          className={cn(
            'text-foreground focus-visible:ring-ring -mx-1 w-full resize-none rounded-sm bg-transparent px-1 text-lg font-medium outline-none [field-sizing:content] focus-visible:ring-2',
            done && 'text-muted-foreground line-through',
          )}
        />
        <dl className="flex flex-col gap-1">
          <Row label={t('when')}>
            <WhenField startsAt={item.starts_at} allDay={item.all_day} onChange={(value) => save(value)} />
          </Row>
          <Row label={t('owner')}>
            <OwnerMenu assignee={item.assignee} directory={directory} onChange={(assignee) => save({ assignee })} />
          </Row>
          <Row label={t('created')}>
            <span className="text-muted-foreground inline-flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
              <span className="text-foreground text-sm">
                <Who who={author} directory={directory} unknown={t('formerMember')} />
              </span>
              <span className="tabular-nums">{stamp(item.created_at)}</span>
              {author.kind === 'agent' && author.session_id && uiRoutes().session ? (
                <UiLink href={uiRoutes().session(projectId, author.session_id)} className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 underline-offset-4 hover:underline">
                  {t('openSession')}
                  <ArrowSquareOutIcon className="size-3" aria-hidden />
                </UiLink>
              ) : null}
            </span>
          </Row>
        </dl>
        <section className="flex flex-col gap-2" aria-label={t('notes')}>
          <h3 className="text-muted-foreground text-xs">{t('notes')}</h3>
          <MentionTextarea
            value={notes}
            onChange={setNotes}
            directory={directory}
            ariaLabel={t('notes')}
            placeholder={t('notesPlaceholder')}
            minHeight={72}
            onBlur={() => notes !== item.notes && save({ notes })}
          />
        </section>
        <section className="flex flex-col gap-3" aria-label={t('commentsTitle')}>
          <h3 className="text-muted-foreground text-xs">{t('commentsTitle')}</h3>
          {comments.length > 0 ? (
            <ul className="flex flex-col gap-4">
              {comments.map((entry) => (
                <li key={entry.comment_id} className="flex flex-col gap-1">
                  <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <span className="text-foreground text-sm font-medium">
                      <Who who={entry.author} directory={directory} unknown={t('formerMember')} />
                    </span>
                    <span className="tabular-nums">{stamp(entry.created_at)}</span>
                  </span>
                  <p className="text-foreground text-sm whitespace-pre-wrap wrap-anywhere">
                    <MentionText text={entry.body} directory={directory} />
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          <MentionTextarea
            value={comment}
            onChange={setComment}
            directory={directory}
            ariaLabel={t('commentLabel')}
            placeholder={t('commentPlaceholder')}
            minHeight={52}
            onSubmit={send}
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={send} disabled={!comment.trim() || actions.comment.isPending} aria-busy={actions.comment.isPending}>
              {t('comment')}
            </Button>
          </div>
        </section>
      </SplitSheetBody>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('deleteTitle')}
        description={t('deleteBody', { title: item.title })}
        confirmLabel={t('delete')}
        confirmVariant="destructive"
        isPending={actions.remove.isPending}
        onConfirm={() =>
          actions.remove.mutate(itemId, {
            onSuccess: () => {
              setConfirming(false);
              onClose();
            },
            onError: (error) => errorToast(error instanceof Error ? error.message : t('deleteFailed')),
          })
        }
      />
    </>
  );
}

/** "Every day at 09:00", "Every 4 hours", "Once on …": the sentence the Triggers page shows. */
function scheduleSentence(source: ScheduledFire['trigger']['source']): string {
  if (source.at) return describeOneOff(source.at);
  const every = everySeconds(source.every);
  if (every) return describeEvery(every);
  if (source.cron) return describeCadence(source.cron.trim().split(/\s+/).length === 5 ? `0 ${source.cron}` : source.cron);
  return '';
}

export function FirePanel({ projectId, fire, directory }: { projectId: string; fire: ScheduledFire; directory: CalendarDirectory }) {
  const t = useTranslations('calendar');
  const stamp = useStamp();
  const { trigger } = fire;
  const loop = trigger.target.kind === 'session';
  return (
    <>
      <SplitSheetHeader closeLabel={t('close')}>
        <SplitSheetTitle className="text-base font-medium">{trigger.name || trigger.id}</SplitSheetTitle>
      </SplitSheetHeader>
      <SplitSheetBody className="flex flex-col gap-6">
        <dl className="flex flex-col gap-1">
          <Row label={t('kind')}>{loop ? t('loop') : t('trigger')}</Row>
          <Row label={t('target')}>
            {trigger.target.kind === 'session' ? (
              <UiLink href={uiRoutes().session(projectId, trigger.target.session_id)} className="hover:underline underline-offset-4">
                {trigger.target.session_name || t('session')}
              </UiLink>
            ) : trigger.target.kind === 'app' ? (
              trigger.target.app
            ) : (
              <Who who={{ kind: 'agent', agent: trigger.agent }} directory={directory} unknown={agentDisplayName(trigger.agent)} />
            )}
          </Row>
          <Row label={t('schedule')}>
            <span className="flex flex-col">
              <span>{scheduleSentence(trigger.source)}</span>
              {trigger.source.cron ? (
                <span className="text-muted-foreground font-mono text-xs">
                  {trigger.source.cron} {trigger.source.timezone ? `· ${trigger.source.timezone}` : ''}
                </span>
              ) : null}
            </span>
          </Row>
          <Row label={fire.past ? t('lastRun') : t('thisDay')}>
            <span className="tabular-nums">
              {stamp(fire.at)}
              {fire.count > 1 ? ` · ${t('runs', { count: fire.count, capped: fire.capped ? 'yes' : 'no' })}` : ''}
              {fire.past ? ` · ${fire.failed ? t('failed') : t('succeeded')}` : ''}
            </span>
          </Row>
          {trigger.next_fire_at ? (
            <Row label={t('nextRun')}>
              <span className="tabular-nums">{stamp(trigger.next_fire_at)}</span>
            </Row>
          ) : null}
        </dl>
        {trigger.prompt ? (
          <section className="flex flex-col gap-2" aria-label={t('prompt')}>
            <h3 className="text-muted-foreground text-xs">{t('prompt')}</h3>
            <p className="text-foreground line-clamp-12 text-sm whitespace-pre-wrap wrap-anywhere">{trigger.prompt}</p>
          </section>
        ) : null}
        <div>
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <UiLink href={adminPath(projectId, 'triggers')}>
              {t('openTriggers')}
              <ArrowSquareOutIcon className="size-3.5 shrink-0" aria-hidden />
            </UiLink>
          </Button>
        </div>
      </SplitSheetBody>
    </>
  );
}
