'use client';

// When an item happens, as one chip: "No date", "Thu, Nov 19",
// "Thu, Nov 19, 3:00 PM" or "Thu, Nov 19, 3:00 – 4:00 PM". It opens the Kortix
// `Calendar` in a popover (the access dialog's ExpiryPicker pattern) with an
// All day switch, a start and an optional end time, and Remove date. The New
// item dialog and the side panel use this one control.
import { CalendarBlankIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useLocale, useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { Calendar } from '../../primitives/calendar';
import { Input } from '../../primitives/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { Switch } from '../../primitives/switch';
import { dayKey, parseDayKey } from './calendar-dates';

export interface WhenValue {
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
}

export const NO_DATE: WhenValue = { starts_at: null, ends_at: null, all_day: false };

const pad = (n: number) => String(n).padStart(2, '0');
const DEFAULT_TIME = '09:00';

/** The day an item sits on (an all-day item keeps its written date), or undefined with no date. */
function dayOf(value: WhenValue): Date | undefined {
  if (!value.starts_at) return undefined;
  return value.all_day ? parseDayKey(value.starts_at.slice(0, 10)) : new Date(value.starts_at);
}

/** `HH:MM` in the viewer's zone, or '' when there is none. */
function clockOf(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The value for a day: all day, or from `start` to an optional `end` (local `HH:MM`). An end not after the start is dropped. */
export function whenOn(day: Date, allDay: boolean, start: string, end = ''): WhenValue {
  if (allDay) return { starts_at: `${dayKey(day)}T00:00:00.000Z`, ends_at: null, all_day: true };
  const at = (clock: string) => {
    const [h, m] = clock.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h ?? 9, m ?? 0);
  };
  const startsAt = at(start || DEFAULT_TIME);
  const endsAt = end ? at(end) : null;
  return {
    starts_at: startsAt.toISOString(),
    ends_at: endsAt && endsAt > startsAt ? endsAt.toISOString() : null,
    all_day: false,
  };
}

/** "Thu, Nov 19", "Thu, Nov 19, 3:00 PM" or "Thu, Nov 19, 3:00 PM – 4:00 PM". */
export function whenLabel(value: WhenValue, locale: string, noDate: string): string {
  const day = dayOf(value);
  if (!day) return noDate;
  const dayLabel = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' }).format(day);
  if (value.all_day) return dayLabel;
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const start = clock.format(day);
  return value.ends_at ? `${dayLabel}, ${start} – ${clock.format(new Date(value.ends_at))}` : `${dayLabel}, ${start}`;
}

export function WhenPicker({ value, onChange }: { value: WhenValue; onChange: (value: WhenValue) => void }) {
  const t = useTranslations('calendar');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const day = dayOf(value);
  const start = value.all_day ? DEFAULT_TIME : clockOf(value.starts_at) || DEFAULT_TIME;
  const end = value.all_day ? '' : clockOf(value.ends_at);
  const label = whenLabel(value, locale, t('noDate'));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" aria-label={`${t('when')}: ${label}`} className={cn('font-normal', !day && 'text-muted-foreground')}>
          <CalendarBlankIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="tabular-nums">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={day}
          defaultMonth={day}
          onSelect={(picked) => {
            if (!picked) return;
            // A first pick is a date only; a moved item keeps all day or its times.
            onChange(whenOn(picked, day ? value.all_day : true, start, end));
            if (!day || value.all_day) setOpen(false);
          }}
        />
        {day ? (
          <div className="flex flex-col gap-2 border-t px-3 py-2">
            <div className="flex items-center gap-2">
              <label className="text-muted-foreground flex items-center gap-2 text-xs">
                <Switch checked={value.all_day} aria-label={t('allDay')} onCheckedChange={(allDay) => onChange(whenOn(day, allDay, start, end))} />
                {t('allDay')}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto"
                onClick={() => {
                  onChange(NO_DATE);
                  setOpen(false);
                }}
              >
                {t('clearDate')}
              </Button>
            </div>
            {value.all_day ? null : (
              <div className="flex items-center gap-2">
                <Input
                  type="time"
                  size="xs"
                  aria-label={t('startTime')}
                  value={start}
                  className="w-auto"
                  onChange={(event) => event.target.value && onChange(whenOn(day, false, event.target.value, end))}
                />
                <span className="text-muted-foreground text-xs">–</span>
                <Input
                  type="time"
                  size="xs"
                  aria-label={t('endTime')}
                  value={end}
                  className="w-auto"
                  onChange={(event) => onChange(whenOn(day, false, start, event.target.value))}
                />
              </div>
            )}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
