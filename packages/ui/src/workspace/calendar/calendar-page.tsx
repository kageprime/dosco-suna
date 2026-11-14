'use client';

// /workspaces/[id]/calendar (flag `calendar`): the workspace's shared
// calendar. The middle is the week (one row per day) or the month; a card
// opens its detail in the side panel, which the URL keeps (`?item=<id>`).
// Items come from the calendar API; the scheduled triggers and Loops come
// from the trigger list the workspace already serves, computed here.
import type { CalendarItem } from '@kortix/sdk';
import { useUnifiedTriggers, useWorkspaceCalendarActions, useWorkspaceCalendarItem, useWorkspaceCalendarItems } from '@kortix/sdk/react';
import { agentDisplayName } from '@kortix/shared';
import { CaretDownIcon, CaretLeftIcon, CaretRightIcon, CheckIcon, LightningIcon, PlusIcon } from '@phosphor-icons/react';
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
import { personName, useCalendarDirectory } from './calendar-people';
import { scheduledFires } from './calendar-scheduled';
import { MonthView, UNDATED, WeekView, type CalendarSelection } from './calendar-views';

type Mode = 'week' | 'month';
/** `all`, `me`, `user:<id>` or `agent:<name>`: the API's `assignee` filter. */
type OwnerFilter = string;

const TRIGGERS_KEY = 'kortix.calendar.showTriggers';
const ITEM_ID = /^[0-9a-f-]{36}$/i;

function readShowTriggers(): boolean {
  try {
    return window.localStorage.getItem(TRIGGERS_KEY) !== '0';
  } catch {
    return true;
  }
}

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
  const [owner, setOwner] = useState<OwnerFilter>('all');
  const [showTriggers, setShowTriggers] = useState(readShowTriggers);
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
    assignee: owner === 'all' ? undefined : owner,
  });
  const triggers = useUnifiedTriggers(showTriggers ? projectId : null);

  const shownItems = useMemo(
    () => (items.data ?? []).map((item) => (moved[item.item_id] ? { ...item, ...moved[item.item_id] } : item)),
    [items.data, moved],
  );
  const fires = useMemo(() => {
    if (!showTriggers || owner === 'me' || owner.startsWith('user:')) return [];
    const all = scheduledFires(triggers.data, range, now);
    return owner.startsWith('agent:') ? all.filter((fire) => fire.trigger.agent === owner.slice(6)) : all;
  }, [showTriggers, owner, triggers.data, range, now]);
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
  const toggleTriggers = () => {
    const next = !showTriggers;
    setShowTriggers(next);
    try {
      window.localStorage.setItem(TRIGGERS_KEY, next ? '1' : '0');
    } catch {
      // A private window keeps the choice for this visit only.
    }
  };

  const label =
    mode === 'week'
      ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(range.from, addDays(range.to, -1))
      : new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor);

  const ownerLabel = (() => {
    if (owner === 'all') return t('filter.everyone');
    if (owner === 'me') return t('filter.me');
    if (owner.startsWith('agent:')) return agentDisplayName(owner.slice(6));
    return personName(directory.person(owner.slice(5)), t('formerMember'));
  })();

  // A deep link to an item in another week shows that week once the item loads.
  useLinkedItemWeek(projectId, itemId, items.data, (day) => {
    setMode('week');
    setAnchor(weekStart(parseDayKey(day)));
  });

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={t('title')}>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setCreating((c) => ({ open: true, day: null, n: c.n + 1 }))}>
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
                  <Button variant="ghost" size="xs" className="gap-1">
                    {ownerLabel}
                    <CaretDownIcon className="size-3" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
                  <DropdownMenuRadioGroup value={owner} onValueChange={(value) => setOwner(String(value))}>
                    <DropdownMenuRadioItem value="all">{t('filter.everyone')}</DropdownMenuRadioItem>
                    {viewerId ? <DropdownMenuRadioItem value="me">{t('filter.me')}</DropdownMenuRadioItem> : null}
                    {directory.people.length > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t('people')}</DropdownMenuLabel>
                        {directory.people
                          .filter((person) => person.user_id !== viewerId)
                          .map((person) => (
                            <DropdownMenuRadioItem key={person.user_id} value={`user:${person.user_id}`}>
                              {personName(person, person.handle)}
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
                            {agentDisplayName(agent)}
                          </DropdownMenuRadioItem>
                        ))}
                      </>
                    ) : null}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="xs" className="gap-1.5" aria-pressed={showTriggers} onClick={toggleTriggers}>
                {showTriggers ? <CheckIcon className="size-3.5 shrink-0" aria-hidden /> : <LightningIcon className="size-3.5 shrink-0" aria-hidden />}
                {t('triggers')}
              </Button>
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
