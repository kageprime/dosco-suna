'use client';

import type { CapturePolicy, CapturePolicyRecord } from '@kortix/sdk';
import { useCapturePolicy, useSetCapturePolicy } from '@kortix/sdk/react';
import { useState } from 'react';

import { Button } from '@kortix/ui/button';
import { Field, FieldDescription } from '@kortix/ui/field';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, successToast } from '@kortix/ui/toast';
import { ErrorState } from '@kortix/ui/error-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';

import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import { useCaptureArea } from '@kortix/ui/internal/capture/use-capture-area';
import {
  FramesSection,
  Group,
  IncludedSection,
  LayersSection,
  RetentionSection,
  SwitchRow,
} from './policy-sections';

/**
 * Dosco Capture's organization settings, the `capture` section of the
 * account settings (`?accountTab=capture`), `capture.manage` only: what every
 * device of the organization must do, in the order This computer shows it.
 * What is recorded · Screen frames · Exclusions (mandatory) · Retention · Notice · Pause ·
 * Experimental (local masking). The policy is one draft; the save bar shows while it differs from
 * what is stored. The switch that turns Capture on is in the account's
 * Settings. A member's own exclusions live on their computer and never reach
 * Dosco. The account settings pane supplies the heading.
 */
export function CaptureSettingsPane({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.settings');
  const area = useCaptureArea(accountId);
  const record = useCapturePolicy(accountId);

  return record.isLoading ? (
    <div className="space-y-3">
      <Skeleton className="h-9 w-80 rounded-md" />
      <Skeleton className="h-32 rounded-md" />
    </div>
  ) : record.isError || !record.data ? (
    <ErrorState
      size="sm"
      title={t('loadFailed')}
      action={
        <Button variant="outline" size="sm" onClick={() => record.refetch()}>
          {t('tryAgain')}
        </Button>
      }
    />
  ) : (
    // Keyed by the saved version: a save or a newer policy starts a fresh draft.
    <PolicyForm
      key={record.data.updated_at ?? 'default'}
      accountId={accountId}
      org={area.accountName}
      record={record.data}
    />
  );
}

function PolicyForm({
  accountId,
  org,
  record,
}: {
  accountId: string;
  org: string;
  record: CapturePolicyRecord;
}) {
  const t = useTranslations('capture.settings');
  const locale = useLocale();
  const save = useSetCapturePolicy(accountId);
  const [draft, setDraft] = useState<CapturePolicy>(record.policy);
  const privacyControls = draft.experimental?.privacy_controls ?? false;
  const dirty = JSON.stringify(draft) !== JSON.stringify(record.policy);
  const patch = <K extends keyof CapturePolicy>(key: K, value: Partial<CapturePolicy[K]>) =>
    setDraft((current) => ({ ...current, [key]: { ...(current[key] as object), ...value } }));
  const submit = () =>
    save.mutate(draft, {
      onSuccess: () => successToast(t('saved')),
      onError: (error) => errorToast(error instanceof Error ? error.message : t('saveFailed')),
    });

  return (
    <div className="space-y-10">
      <LayersSection draft={draft} patch={patch} org={org} />

      <IncludedSection draft={draft} setDraft={setDraft} org={org} />

      <FramesSection draft={draft} patch={patch} />

      <RetentionSection draft={draft} patch={patch} />

      <section className="space-y-3">
        <Label htmlFor="capture-notice">{t('noticeTitle')}</Label>
        <Field>
          <Textarea
            id="capture-notice"
            value={draft.notice}
            maxLength={2000}
            rows={3}
            placeholder={t('noticePlaceholder')}
            onChange={(event) => setDraft({ ...draft, notice: event.target.value })}
          />
          <FieldDescription>{t('noticeHint')}</FieldDescription>
        </Field>
      </section>

      <Group title={t('pauseTitle')}>
        <SwitchRow
          title={t('pause')}
          description={t('pauseHint')}
          checked={draft.recording.paused}
          onChange={(paused) => patch('recording', { paused, paused_until_ms: null })}
        />
      </Group>

      <Group title={t('experimentalTitle')} description={t('experimentalHint')}>
        <SwitchRow
          title={t('privacyControls')}
          description={t('privacyControlsHint')}
          checked={privacyControls}
          onChange={(privacy_controls) => patch('experimental', { privacy_controls })}
        />
      </Group>

      {privacyControls ? (
        <>
          {/* Works, and costs each computer a ~1 GB model download first. */}
          <Group title={t('maskingTitle')}>
            <SwitchRow
              title={t('masking')}
              description={t('maskingHint')}
              checked={draft.privacy.redact_pii}
              onChange={(redact_pii) => patch('privacy', { redact_pii })}
            />
          </Group>
        </>
      ) : null}

      {dirty ? (
        <div className="bg-background sticky bottom-0 z-10 mt-8 flex flex-wrap items-center justify-between gap-3 border-t py-3">
          <p className="text-muted-foreground text-xs">{t('unsaved')}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline-ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => setDraft(record.policy)}
            >
              {t('discard')}
            </Button>
            <Button size="sm" disabled={save.isPending} aria-busy={save.isPending} onClick={submit}>
              {save.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
              {t('save')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground mt-8 text-xs">
          {record.updated_at
            ? t('lastChanged', { time: relativeTime(Date.parse(record.updated_at), locale) })
            : t('defaultPolicy')}
        </p>
      )}
    </div>
  );
}
