'use client';

import { useTranslations } from '../../../i18n';
import { Button } from '../../../primitives/button';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import { ScheduleBuilder } from './schedule-builder';

import { InlineError, type PatchDraft } from './composer-parts';
import { TimezoneField } from './schedule-fields';
import type { ComposerDraft } from './trigger-composer-logic';

const EVERY_ERROR_ID = 'trigger-every-error';
/** Duration syntax the `every` field parses, not copy. */
const EVERY_EXAMPLE = '1h';

/**
 * When: a repeating schedule, or one run at a set time. A trigger saved with a
 * fixed period (`every: 1h`) shows that period, not a calendar it does not
 * have, until the person switches it to a calendar schedule.
 */
export function WhenSchedule({
  draft,
  patch,
  error,
}: {
  draft: ComposerDraft;
  patch: PatchDraft;
  error?: string;
}) {
  const t = useTranslations('triggerComposer');
  if (draft.every !== null) {
    return (
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="trigger-every" className="text-xs">
            {t('intervalLabel')}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="trigger-every"
              size="xs"
              value={draft.every}
              onChange={(e) => patch({ every: e.target.value })}
              placeholder={EVERY_EXAMPLE}
              maxLength={16}
              className="w-32 font-mono text-sm"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? EVERY_ERROR_ID : undefined}
            />
            <Button variant="ghost" size="sm" onClick={() => patch({ every: null })}>
              {t('useCalendar')}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{t('intervalHelp')}</p>
        </div>
        <InlineError id={EVERY_ERROR_ID} message={error} />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ScheduleBuilder
        value={draft.cron}
        onChange={(cron) => patch({ cron })}
        allowOnce
        runAt={draft.runAt}
        onRunAtChange={(runAt) => patch({ runAt })}
        // A one-off runs at a local date and time, so it has no timezone field.
        trailing={
          <TimezoneField
            inline
            className="min-w-40 flex-1"
            value={draft.timezone}
            onChange={(timezone) => patch({ timezone })}
          />
        }
      />
      <InlineError message={error} />
    </div>
  );
}
