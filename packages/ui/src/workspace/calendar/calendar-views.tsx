'use client';

// The two calendar views. Week: one row per day (the day on the left, its
// entries side by side), with the items that have no date in the first row.
// Month: a grid of days, each with up to three entries. An item is a filled
// card; a scheduled trigger or Loop is an outlined card. Items drag onto
// another day (or onto "No date"); scheduled entries do not move here.
import type { CalendarItem } from '@kortix/sdk';
import { ArrowsClockwiseIcon, ChatCircleIcon, CheckIcon, LightningIcon, PlusIcon } from '@phosphor-icons/react';
import { useState, type DragEvent } from 'react';
import { useLocale, useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { dayKey, isOverdue, itemDayKey, monthWeeks, weekDays } from './calendar-dates';
import { Participants, type CalendarDirectory } from './calendar-people';
import type { ScheduledFire } from './calendar-scheduled';

export const UNDATED = 'undated';

export type CalendarSelection = { kind: 'item'; id: string } | { kind: 'fire'; id: string } | null;

interface ViewProps {
  items: CalendarItem[];
  fires: ScheduledFire[];
  directory: CalendarDirectory;
  selection: CalendarSelection;
  now: Date;
  onOpenItem: (id: string) => void;
  onOpenFire: (id: string) => void;
  /** An item dropped on a day key, or on {@link UNDATED}. */
  onMove: (item: CalendarItem, day: string) => void;
  /** "+" on a day: a new item on that day. */
  onAdd: (day: string | null) => void;
}

/** Drag state shared by the drop zones of one view. */
function useDrop(items: CalendarItem[], onMove: ViewProps['onMove']) {
  const [over, setOver] = useState('');
  const zone = (day: string) => ({
    'data-over': over === day || undefined,
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes('application/x-kortix-calendar-item')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setOver(day);
    },
    onDragLeave: () => setOver((current) => (current === day ? '' : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setOver('');
      const id = event.dataTransfer.getData('application/x-kortix-calendar-item');
      const item = items.find((candidate) => candidate.item_id === id);
      if (item && (itemDayKey(item) ?? UNDATED) !== day) onMove(item, day);
    },
  });
  return zone;
}

const draggable = (item: CalendarItem) => ({
  draggable: true,
  onDragStart: (event: DragEvent) => {
    event.dataTransfer.setData('application/x-kortix-calendar-item', item.item_id);
    event.dataTransfer.effectAllowed = 'move';
  },
});

/** The dot before an item in the month grid: done (green), overdue (orange), else neutral. */
function ItemDot({ item, now }: { item: CalendarItem; now: Date }) {
  const tone = item.status === 'done' ? 'bg-kortix-green' : isOverdue(item, now) ? 'bg-kortix-orange' : 'bg-muted-foreground';
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', tone)} />;
}

function useTimeLabel() {
  const locale = useLocale();
  const t = useTranslations('calendar');
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  return (item: Pick<CalendarItem, 'starts_at' | 'ends_at' | 'all_day'>) => {
    if (!item.starts_at) return t('noDate');
    if (item.all_day) return t('allDay');
    const start = clock.format(new Date(item.starts_at));
    return item.ends_at ? `${start} – ${clock.format(new Date(item.ends_at))}` : start;
  };
}

function ItemCard({ item, selected, directory, now, onOpen }: { item: CalendarItem; selected: boolean; directory: CalendarDirectory; now: Date; onOpen: () => void }) {
  const t = useTranslations('calendar');
  const when = useTimeLabel();
  // No status word: a done item has a check and a struck title, an overdue one says so, else the time. Undated items sit under "No date" already.
  const done = item.status === 'done';
  const overdue = !done && isOverdue(item, now);
  const lead = overdue ? t('overdue') : item.starts_at ? when(item) : null;
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={item.title}
      onClick={onOpen}
      {...draggable(item)}
      className={cn(
        'bg-muted text-foreground hover:bg-hover duration-fast flex size-full min-h-20 cursor-pointer flex-col justify-between gap-3 rounded-md p-3 text-left transition-colors',
        'focus-visible:ring-ring outline-none focus-visible:ring-2 aria-pressed:bg-active',
      )}
    >
      <span className={cn('line-clamp-2 text-sm font-medium wrap-anywhere', done && 'text-muted-foreground line-through')}>
        {item.title}
      </span>
      <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap">
        {done ? <CheckIcon weight="bold" className="text-kortix-green size-3.5 shrink-0" aria-label={t('status.done')} /> : null}
        {lead ? <span className={cn('truncate tabular-nums', overdue && 'text-kortix-orange')}>{lead}</span> : null}
        {item.comment_count > 0 ? (
          <span className="inline-flex items-center gap-0.5 tabular-nums">
            <ChatCircleIcon className="size-3.5" aria-label={t('comments', { count: item.comment_count })} />
            {item.comment_count}
          </span>
        ) : null}
        {item.people.length > 0 ? (
          <span className="ml-auto">
            <Participants people={item.people} directory={directory} />
          </span>
        ) : null}
      </span>
    </button>
  );
}

function FireCard({ fire, selected, onOpen }: { fire: ScheduledFire; selected: boolean; onOpen: () => void }) {
  const t = useTranslations('calendar');
  const locale = useLocale();
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const loop = fire.trigger.target.kind === 'session';
  const Glyph = loop ? ArrowsClockwiseIcon : LightningIcon;
  const lead = fire.count > 1 ? t('runs', { count: fire.count, capped: fire.capped ? 'yes' : 'no' }) : clock.format(new Date(fire.at));
  return (
    <button
      type="button"
      aria-pressed={selected}
      title={fire.trigger.name ?? fire.trigger.id}
      onClick={onOpen}
      className={cn(
        'bg-background text-foreground hover:bg-hover duration-fast border-border flex size-full min-h-20 cursor-pointer flex-col justify-between gap-3 rounded-md border p-3 text-left transition-colors',
        'focus-visible:ring-ring outline-none focus-visible:ring-2 aria-pressed:bg-active',
      )}
    >
      <span className="line-clamp-2 text-sm font-medium wrap-anywhere">{fire.trigger.name || fire.trigger.id}</span>
      <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap">
        <Glyph className={cn('size-3.5 shrink-0', fire.failed && 'text-kortix-red')} aria-hidden />
        <span className="truncate tabular-nums">{fire.past ? (fire.failed ? t('lastRunFailed') : t('lastRun')) : lead}</span>
        <span className="ml-auto truncate">{loop ? t('loop') : t('trigger')}</span>
      </span>
    </button>
  );
}

function Entries({ items, fires, props }: { items: CalendarItem[]; fires: ScheduledFire[]; props: ViewProps }) {
  return (
    <ul className="flex min-w-0 gap-2 overflow-x-auto p-0.5">
      {items.map((item) => (
        <li key={item.item_id} className="w-60 shrink-0">
          <ItemCard
            item={item}
            directory={props.directory}
            now={props.now}
            selected={props.selection?.kind === 'item' && props.selection.id === item.item_id}
            onOpen={() => props.onOpenItem(item.item_id)}
          />
        </li>
      ))}
      {fires.map((fire) => (
        <li key={fire.id} className="w-60 shrink-0">
          <FireCard fire={fire} selected={props.selection?.kind === 'fire' && props.selection.id === fire.id} onOpen={() => props.onOpenFire(fire.id)} />
        </li>
      ))}
    </ul>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="text-muted-foreground hover:bg-hover hover:text-foreground duration-fast focus-visible:ring-ring ml-auto inline-flex size-6 items-center justify-center rounded-sm opacity-0 transition-colors outline-none group-hover/day:opacity-100 focus-visible:opacity-100 focus-visible:ring-2"
    >
      <PlusIcon className="size-3.5" />
    </button>
  );
}

function byTime(a: CalendarItem, b: CalendarItem): number {
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
  return (a.starts_at ?? '').localeCompare(b.starts_at ?? '');
}

export function WeekView(props: ViewProps & { start: Date }) {
  const t = useTranslations('calendar');
  const locale = useLocale();
  const zone = useDrop(props.items, props.onMove);
  const today = dayKey(props.now);
  const undated = props.items.filter((item) => !item.starts_at);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const full = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <div className="@container flex flex-col px-4 pb-10 md:px-6">
      <section
        aria-label={t('noDate')}
        {...zone(UNDATED)}
        className="group/day border-border grid gap-2 border-b py-3 data-over:bg-hover @md:grid-cols-[6rem_minmax(0,1fr)] @md:gap-4"
      >
        <header className="flex h-7 items-center gap-1.5">
          <span className="text-muted-foreground text-sm">{t('noDate')}</span>
          {undated.length > 0 ? <span className="text-muted-foreground text-xs tabular-nums">{undated.length}</span> : null}
          <AddButton label={t('addOn', { day: t('noDate') })} onClick={() => props.onAdd(null)} />
        </header>
        {undated.length > 0 ? <Entries items={undated} fires={[]} props={props} /> : <p className="text-muted-foreground self-center text-xs">{t('noDateHint')}</p>}
      </section>
      {weekDays(props.start).map((day) => {
        const key = dayKey(day);
        const items = props.items.filter((item) => itemDayKey(item) === key).sort(byTime);
        const fires = props.fires.filter((fire) => fire.day === key);
        const empty = items.length === 0 && fires.length === 0;
        return (
          <section
            key={key}
            aria-label={full.format(day)}
            {...zone(key)}
            className={cn(
              'group/day border-border grid gap-2 border-b py-3 last:border-b-0 data-over:bg-hover @md:grid-cols-[6rem_minmax(0,1fr)] @md:gap-4',
              empty && 'py-1.5',
            )}
          >
            <header className="flex h-7 items-center gap-1.5">
              <span className="text-muted-foreground text-sm">{weekday.format(day)}</span>
              <span
                className={cn(
                  'inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm font-medium tabular-nums',
                  key === today && 'bg-foreground text-background',
                )}
                aria-current={key === today ? 'date' : undefined}
              >
                {day.getDate()}
              </span>
              <AddButton label={t('addOn', { day: full.format(day) })} onClick={() => props.onAdd(key)} />
            </header>
            {empty ? <span /> : <Entries items={items} fires={fires} props={props} />}
          </section>
        );
      })}
    </div>
  );
}

const MONTH_CELL_ENTRIES = 3;

export function MonthView(props: ViewProps & { anchor: Date; onShowDay: (day: Date) => void }) {
  const t = useTranslations('calendar');
  const locale = useLocale();
  const zone = useDrop(props.items, props.onMove);
  const today = dayKey(props.now);
  const weeks = monthWeeks(props.anchor);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  const label = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' });
  return (
    <div className="grid min-h-full grid-cols-7 auto-rows-[minmax(7rem,1fr)] grid-rows-[auto]" role="grid" aria-label={t('month')}>
      {weeks[0]!.map((day) => (
        <span key={day.getDay()} role="columnheader" className="text-muted-foreground border-border border-r border-b px-3 py-2 text-xs [&:nth-child(7n)]:border-r-0">
          {weekday.format(day)}
        </span>
      ))}
      {weeks.flat().map((day) => {
        const key = dayKey(day);
        const items = props.items.filter((item) => itemDayKey(item) === key).sort(byTime);
        const fires = props.fires.filter((fire) => fire.day === key);
        const entries = [
          ...items.map((item) => ({ key: item.item_id, item, fire: null as ScheduledFire | null })),
          ...fires.map((fire) => ({ key: fire.id, item: null as CalendarItem | null, fire })),
        ];
        const outside = day.getMonth() !== props.anchor.getMonth();
        return (
          <div
            key={key}
            role="gridcell"
            aria-label={t('dayEntries', { day: label.format(day), count: entries.length })}
            {...zone(key)}
            className="border-border flex min-w-0 flex-col gap-1 border-r border-b p-1.5 data-over:bg-hover [&:nth-child(7n)]:border-r-0"
          >
            <button
              type="button"
              onClick={() => props.onShowDay(day)}
              aria-label={t('showWeekOf', { day: label.format(day) })}
              className={cn(
                'hover:bg-hover duration-fast inline-flex h-6 min-w-6 items-center justify-center self-start rounded-full px-1 text-sm tabular-nums transition-colors',
                outside && 'text-muted-foreground',
                key === today && 'bg-foreground text-background hover:bg-foreground',
              )}
            >
              {day.getDate()}
            </button>
            <ul className="flex min-w-0 flex-col gap-0.5">
              {entries.slice(0, MONTH_CELL_ENTRIES).map((entry) => (
                <li key={entry.key}>
                  {entry.item ? (
                    <button
                      type="button"
                      {...draggable(entry.item)}
                      aria-pressed={props.selection?.kind === 'item' && props.selection.id === entry.item.item_id}
                      onClick={() => props.onOpenItem(entry.item!.item_id)}
                      className="hover:bg-hover duration-fast aria-pressed:bg-active flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors"
                    >
                      <ItemDot item={entry.item} now={props.now} />
                      <span className={cn('truncate', outside && 'text-muted-foreground', entry.item.status === 'done' && 'line-through')}>{entry.item.title}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-pressed={props.selection?.kind === 'fire' && props.selection.id === entry.fire!.id}
                      onClick={() => props.onOpenFire(entry.fire!.id)}
                      className="text-muted-foreground hover:bg-hover duration-fast aria-pressed:bg-active flex h-6 w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors"
                    >
                      <LightningIcon className={cn('size-3 shrink-0', entry.fire!.failed && 'text-kortix-red')} aria-hidden />
                      <span className="truncate">{entry.fire!.trigger.name || entry.fire!.trigger.id}</span>
                    </button>
                  )}
                </li>
              ))}
              {entries.length > MONTH_CELL_ENTRIES ? (
                <li>
                  <button type="button" onClick={() => props.onShowDay(day)} className="text-muted-foreground hover:text-foreground px-1.5 text-xs tabular-nums">
                    {t('more', { count: entries.length - MONTH_CELL_ENTRIES })}
                  </button>
                </li>
              ) : null}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
