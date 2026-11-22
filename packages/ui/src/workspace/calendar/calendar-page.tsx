'use client';

// /workspaces/[id]/calendar (flag `calendar`): the workspace's shared
// calendar. The middle is the week (one row per day) or the month; a card
// opens its detail in the side panel, which the URL keeps (`?item=<id>`).
// Items come from the calendar API; the scheduled triggers and Loops come
// from the trigger list the workspace already serves, computed here.
import type { CalendarItem, CalendarParticipant } from '@kortix/sdk';
import { useUnifiedTriggers, useWorkspaceCalendarActions, useWorkspaceCalendarItem, useWorkspaceCalendarItems } from '@kortix/sdk/react';
import { agentDisplayName } from '@kortix/shared';
import { CaretDownIcon, CaretLeftIcon, CaretRightIcon, PlusIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from '../../i18n';
import { ProjectPageHeader } from '../../internal/layout/project-page-header';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { ErrorState } from '../../primitives/error-state';
import { Hint } from '../../primitives/hint';
import { Skeleton } from '../../primitives/skeleton';
import { SplitSheet, SplitSheetContent, SplitSheetMain } from '../../primitives/split-sheet';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { errorToast } from '../../primitives/toast';
import { useUiPathname, useUiSearchParams, useUiShallowNavigate, useUiViewerId } from '../../providers/ui-provider';
import { addDays, itemDayKey, moveToDay, parseDayKey, viewRange, weekStart } from './calendar-dates';
import { NewItemModal } from './calendar-new-item';
import { FirePanel, ItemPanel } from './calendar-panel';
import { ParticipantMark, personName, useCalendarDirectory, type CalendarDirectory } from './calendar-people';
import { scheduledFires } from './calendar-scheduled';
import { MonthView, UNDATED, WeekView, type CalendarSelection } from './calendar-views';

type Mode = 'week' | 'month';
/** `all`, `me`, `user:<id>` or `agent:<name>`: who the items are with (the API's `with` filter). */
type WithFilter = string;

const ITEM_ID = /^[0-9a-f-]{36}$/i;

/** The current minute, so "today" and "overdue" move without a reload. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function CalendarPage({ projectId }: { projectId: string }) {
  const t = useTranslations('calendar');
  const locale = useLocale();
  const now = useNow();
  const viewerId = useUiViewerId();
  const pathname = useUiPathname();
  const search = useUiSearchParams();
  const navigate = useUiShallowNavigate();
  const directory = useCalendarDirectory(projectId);
  const actions = useWorkspaceCalendarActions(projectId);

  const [mode, setMode] = useState<Mode>('week');
  const [anchor, setAnchor] = useState(() => weekStart(new Date()));
  const [filter, setFilter] = useState<WithFilter>('all');
  const [fireId, setFireId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ open: boolean; day: string | null; n: number }>({ open: false, day: null, n: 0 });
  /** Items moved by a drag, shown on their new day until the list reads them back. */
  const [moved, setMoved] = useState<Record<string, Pick<CalendarItem, 'starts_at' | 'all_day'>>>({});

  const itemParam = search.get('item');
  const itemId = itemParam && ITEM_ID.test(itemParam) ? itemParam : null;
  const selection: CalendarSelection = itemId ? { kind: 'item', id: itemId } : fireId ? { kind: 'fire', id: fireId } : null;

  const range = useMemo(() => viewRange(mode, anchor), [mode, anchor]);
  const items = useWorkspaceCalendarItems(projectId, {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    with: filter === 'all' ? undefined : filter,
  });
  // Scheduled triggers and Loops always show: everyone, or the picked agent's own.
  const triggers = useUnifiedTriggers(projectId);

  const shownItems = useMemo(
    () => (items.data ?? []).map((item) => (moved[item.item_id] ? { ...item, ...moved[item.item_id] } : item)),
    [items.data, moved],
  );
  const fires = useMemo(() => {
    if (filter === 'me' || filter.startsWith('user:')) return [];
    const all = scheduledFires(triggers.data, range, now);
    return filter.startsWith('agent:') ? all.filter((fire) => fire.trigger.agent === filter.slice(6)) : all;
  }, [filter, triggers.data, range, now]);
  const openFire = fireId ? fires.find((fire) => fire.id === fireId) ?? null : null;

  const setItemParam = (id: string | null) => {
    const params = new URLSearchParams(search.toString());
    if (id) params.set('item', id);
    else params.delete('item');
    params.delete('notification');
    const query = params.toString();
    navigate(`${pathname}${query ? `?${query}` : ''}`, { replace: true });
  };
  const openItem = (id: string) => {
    setFireId(null);
    setItemParam(id);
  };
  const openFireEntry = (id: string) => {
    if (itemId) setItemParam(null);
    setFireId(id);
  };
  const close = () => {
    setFireId(null);
    if (itemId) setItemParam(null);
  };

  const move = (item: CalendarItem, day: string) => {
    const input = day === UNDATED ? { starts_at: null, all_day: false } : moveToDay(item, day);
    setMoved((current) => ({ ...current, [item.item_id]: input }));
    actions.update.mutate(
      { itemId: item.item_id, input },
      {
        onError: (error) => errorToast(error instanceof Error ? error.message : t('saveFailed')),
        onSettled: () =>
          setMoved((current) => {
            const { [item.item_id]: _, ...rest } = current;
            return rest;
          }),
      },
    );
  };

  const step = (direction: -1 | 1) =>
    setAnchor(mode === 'week' ? addDays(anchor, 7 * direction) : new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1));
  const goToday = () => setAnchor(mode === 'week' ? weekStart(new Date()) : new Date());
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setAnchor(next === 'week' ? weekStart(anchor) : addDays(anchor, 3));
    setMode(next);
  };
  const label =
    mode === 'week'
      ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(range.from, addDays(range.to, -1))
      : new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor);

  const filterLabel = (() => {
    if (filter === 'all') return t('filter.everyone');
    if (filter === 'me') return t('filter.me');
    if (filter.startsWith('agent:')) return agentDisplayName(filter.slice(6));
    return personName(directory.person(filter.slice(5)), t('formerMember'));
  })();

  // A deep link to an item in another week shows that week once the item loads.
  useLinkedItemWeek(projectId, itemId, items.data, (day) => {
    setMode('week');
    setAnchor(weekStart(parseDayKey(day)));
  });

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')}>
        <Button size="sm" className="gap-1.5" onClick={() => setCreating((c) => ({ open: true, day: null, n: c.n + 1 }))}>
          <PlusIcon className="size-3.5 shrink-0" aria-hidden />
          {t('newItem')}
        </Button>
      </ProjectPageHeader>
      <SplitSheet size="lg" open={selection !== null && (selection.kind === 'item' || openFire !== null)} onOpenChange={(open) => !open && close()} className="min-h-0 flex-1">
        <SplitSheetMain className="flex min-h-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-3 md:px-6">
            <h2 className="text-foreground mr-1 text-base font-medium tabular-nums">{label}</h2>
            <div className="flex items-center gap-1">
              <Hint label={mode === 'week' ? t('previousWeek') : t('previousMonth')}>
                <Button variant="ghost" size="icon-sm" aria-label={mode === 'week' ? t('previousWeek') : t('previousMonth')} onClick={() => step(-1)}>
                  <CaretLeftIcon className="size-4" />
                </Button>
              </Hint>
              <Button variant="outline" size="xs" onClick={goToday}>
                {t('today')}
              </Button>
              <Hint label={mode === 'week' ? t('nextWeek') : t('nextMonth')}>
                <Button variant="ghost" size="icon-sm" aria-label={mode === 'week' ? t('nextWeek') : t('nextMonth')} onClick={() => step(1)}>
                  <CaretRightIcon className="size-4" />
                </Button>
              </Hint>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="xs" className="gap-1.5">
                    <FilterGlyph filter={filter} viewerId={viewerId} directory={directory} />
                    {filterLabel}
                    <CaretDownIcon className="size-3" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
                  <DropdownMenuRadioGroup value={filter} onValueChange={(value) => setFilter(String(value))}>
                    <DropdownMenuRadioItem value="all">
                      <FilterGlyph filter="all" viewerId={viewerId} directory={directory} />
                      {t('filter.everyone')}
                    </DropdownMenuRadioItem>
                    {viewerId ? (
                      <DropdownMenuRadioItem value="me">
                        <FilterGlyph filter="me" viewerId={viewerId} directory={directory} />
                        {t('filter.me')}
                      </DropdownMenuRadioItem>
                    ) : null}
                    {directory.people.length > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t('people')}</DropdownMenuLabel>
                        {directory.people
                          .filter((person) => person.user_id !== viewerId)
                          .map((person) => (
                            <DropdownMenuRadioItem key={person.user_id} value={`user:${person.user_id}`}>
                              <FilterGlyph filter={`user:${person.user_id}`} viewerId={viewerId} directory={directory} />
                              <span className="truncate">{personName(person, person.handle)}</span>
                            </DropdownMenuRadioItem>
                          ))}
                      </>
                    ) : null}
                    {directory.agents.length > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t('agents')}</DropdownMenuLabel>
                        {directory.agents.map((agent) => (
                          <DropdownMenuRadioItem key={agent} value={`agent:${agent}`}>
                            <FilterGlyph filter={`agent:${agent}`} viewerId={viewerId} directory={directory} />
                            <span className="truncate">{agentDisplayName(agent)}</span>
                          </DropdownMenuRadioItem>
                        ))}
                      </>
                    ) : null}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tabs value={mode} onValueChange={(value) => switchMode(value as Mode)}>
                <TabsList size="xs" aria-label={t('view')}>
                  <TabsTrigger value="week">{t('week')}</TabsTrigger>
                  <TabsTrigger value="month">{t('month')}</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto', mode === 'month' && 'border-border border-t')}>
            {items.isPending && !items.data ? (
              <div className="flex flex-col gap-3 px-4 py-3 md:px-6">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-20 w-full rounded-md" />
                ))}
              </div>
            ) : items.isError && !items.data ? (
              <div className="px-4 py-6 md:px-6">
                <ErrorState
                  size="sm"
                  title={t('loadFailed')}
                  action={
                    <Button variant="outline" size="sm" onClick={() => void items.refetch()}>
                      {t('tryAgain')}
                    </Button>
                  }
                />
              </div>
            ) : mode === 'week' ? (
              <WeekView
                start={range.from}
                items={shownItems}
                fires={fires}
                directory={directory}
                selection={selection}
                now={now}
                onOpenItem={openItem}
                onOpenFire={openFireEntry}
                onMove={move}
                onAdd={(day) => setCreating((c) => ({ open: true, day, n: c.n + 1 }))}
              />
            ) : (
              <MonthView
                anchor={anchor}
                items={shownItems.filter((item) => itemDayKey(item) !== null)}
                fires={fires}
                directory={directory}
                selection={selection}
                now={now}
                onOpenItem={openItem}
                onOpenFire={openFireEntry}
                onMove={move}
                onAdd={(day) => setCreating((c) => ({ open: true, day, n: c.n + 1 }))}
                onShowDay={(day) => {
                  setMode('week');
                  setAnchor(weekStart(day));
                }}
              />
            )}
          </div>
        </SplitSheetMain>
        <SplitSheetContent className="flex min-h-0 flex-col">
          {selection?.kind === 'item' ? (
            <ItemPanel key={selection.id} projectId={projectId} itemId={selection.id} directory={directory} onClose={close} />
          ) : openFire ? (
            <FirePanel key={openFire.id} projectId={projectId} fire={openFire} directory={directory} />
          ) : null}
        </SplitSheetContent>
      </SplitSheet>
      <NewItemModal
        key={creating.n}
        projectId={projectId}
        open={creating.open}
        day={creating.day}
        directory={directory}
        onOpenChange={(open) => setCreating((current) => ({ ...current, open }))}
        onCreated={(item) => {
          const day = itemDayKey(item);
          if (day) {
            const { from, to } = viewRange(mode, anchor);
            const at = parseDayKey(day);
            if (at < from || at >= to) setAnchor(mode === 'week' ? weekStart(at) : at);
          }
          openItem(item.item_id);
        }}
      />
    </div>
  );
}

/** The face of a filter row: three people for everyone, else that person's avatar or that agent's mark. */
function FilterGlyph({ filter, viewerId, directory }: { filter: WithFilter; viewerId: string | undefined; directory: CalendarDirectory }) {
  const who: CalendarParticipant | null = filter.startsWith('agent:')
    ? { kind: 'agent', agent: filter.slice(6) }
    : filter.startsWith('user:')
      ? { kind: 'person', user_id: filter.slice(5) }
      : filter === 'me' && viewerId
        ? { kind: 'person', user_id: viewerId }
        : null;
  if (!who) {
    // The avatars' box (`UserAvatar` xs), so every row's label starts at one edge.
    return (
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
        <UsersThreeIcon className="size-4" />
      </span>
    );
  }
  return <ParticipantMark who={who} directory={directory} />;
}

/**
 * A deep link (`?item=` from a notification) to an item outside the shown
 * window moves the view to the item's week, once per item. It reads the same
 * cache entry as the panel.
 */
function useLinkedItemWeek(projectId: string, itemId: string | null, shown: CalendarItem[] | undefined, show: (day: string) => void): void {
  const [handled, setHandled] = useState<string | null>(null);
  const detail = useWorkspaceCalendarItem(projectId, itemId).data?.item;
  // Adjusting state while rendering: runs once per item, no effect.
  if (itemId && handled !== itemId && detail?.item_id === itemId && shown) {
    setHandled(itemId);
    const day = itemDayKey(detail);
    if (day && !shown.some((item) => item.item_id === itemId)) show(day);
  }
}
