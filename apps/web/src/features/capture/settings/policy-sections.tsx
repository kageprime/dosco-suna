'use client';

import {
  CAPTURE_LAYERS,
  CAPTURE_MAX_HEIGHTS,
  CAPTURE_RETENTION_LIMITS,
  type CaptureMaxHeight,
  type CapturePolicy,
} from '@kortix/sdk';
import { useId, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';

import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import { RadioGroup, RadioGroupItem } from '@kortix/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { Switch } from '@kortix/ui/switch';
import { useTranslations } from '@/i18n/use-translations';

import { ExclusionsEditor, IncludedEditor } from './exclusions-editor';
import { applyToPrivacy, fromPolicy, includedView } from './exclusions-model';

/** The draft every section reads, and the way it patches one top-level key of the policy. */
interface Draft {
  draft: CapturePolicy;
  patch: <K extends keyof CapturePolicy>(key: K, value: Partial<CapturePolicy[K]>) => void;
}

export function SwitchRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p id={id} className="text-foreground text-sm font-medium">
          {title}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
      </div>
      <Switch
        aria-labelledby={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

export function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <Label>{title}</Label>
        {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      </div>
      <div className="bg-popover divide-border divide-y rounded-md border">{children}</div>
    </section>
  );
}

/** A choice from a short list, or none (each computer decides), right-aligned like a switch. */
function SelectRow<T extends number | string>({
  title,
  description,
  value,
  noneLabel,
  options,
  onChange,
}: {
  title: string;
  description: string;
  value: T | null;
  noneLabel: string;
  options: readonly { value: T; label: string }[];
  onChange: (value: T | null) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p id={id} className="text-foreground text-sm font-medium">
          {title}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
      </div>
      <Select
        value={value === null ? 'none' : String(value)}
        onValueChange={(next) =>
          onChange(options.find((option) => String(option.value) === next)?.value ?? null)
        }
      >
        <SelectTrigger size="sm" aria-labelledby={id} className="w-56 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{noneLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={String(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A whole number with its unit, right-aligned like a switch. */
function NumberRow({
  id,
  title,
  description,
  unit,
  value,
  max,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  unit: string;
  value: number;
  max: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-foreground text-sm font-medium">
          {title}
        </Label>
        <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{description}</p>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-20 tabular-nums"
        />
        <span className="text-muted-foreground text-sm">{unit}</span>
      </span>
    </div>
  );
}

/** Which layers every device records. */
export function LayersSection({ draft, patch, org }: Draft & { org: string }) {
  const t = useTranslations('capture.settings');
  return (
    <Group title={t('layersTitle')} description={t('layersHint', { org })}>
      {CAPTURE_LAYERS.map((layer) => (
        <SwitchRow
          key={layer}
          title={t(`layer.${layer}`)}
          description={t(`layer.${layer}Hint`)}
          checked={draft.layers[layer]}
          onChange={(on) => patch('layers', { [layer]: on })}
        />
      ))}
    </Group>
  );
}

/** The included-policy radio, the included list, member inclusions and the mandatory exclusions. */
export function IncludedSection({
  draft,
  setDraft,
  org,
}: {
  draft: CapturePolicy;
  setDraft: Dispatch<SetStateAction<CapturePolicy>>;
  org: string;
}) {
  const t = useTranslations('capture.settings');
  const tGroup = useTranslations('capture.settings.exclusions.group');
  const recordOnly = draft.privacy.record_only_included ?? false;
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <Label>{t('included.title')}</Label>
        <p className="text-muted-foreground text-xs">{t('included.hint', { org })}</p>
      </div>
      <RadioGroup
        value={recordOnly ? 'include' : 'exclude'}
        onValueChange={(mode) =>
          setDraft((current) => ({
            ...current,
            privacy: applyToPrivacy(current.privacy, {
              kind: 'record-only',
              on: mode === 'include',
            }),
          }))
        }
        className="grid gap-2 sm:grid-cols-2"
        aria-label={t('included.policyType')}
      >
        <RadioGroupItem
          value="exclude"
          label={t('included.exclusionPolicy')}
          description={t('included.exclusionPolicyHint')}
          size="lg"
          variant="outline"
        />
        <RadioGroupItem
          value="include"
          label={t('included.inclusionPolicy')}
          description={t('included.inclusionPolicyHint')}
          size="lg"
          variant="outline"
        />
      </RadioGroup>
      {recordOnly ? (
        <div className="space-y-1 pt-2">
          <Label>{t('included.recordTitle')}</Label>
          <IncludedEditor
            view={includedView(draft.privacy)}
            onChange={(change) =>
              setDraft((current) => ({
                ...current,
                privacy: applyToPrivacy(current.privacy, change),
              }))
            }
          />
          <div className="bg-popover mt-3 rounded-md border">
            <SwitchRow
              title={t('included.memberInclusions')}
              description={t('included.memberInclusionsHint')}
              checked={draft.privacy.member_inclusions ?? true}
              onChange={(on) =>
                setDraft((current) => ({
                  ...current,
                  privacy: applyToPrivacy(current.privacy, { kind: 'member-inclusions', on }),
                }))
              }
            />
          </div>
        </div>
      ) : null}
      <div className="space-y-1 pt-2">
        <Label>{recordOnly ? t('included.exceptTitle') : t('exclusionsTitle')}</Label>
        <ExclusionsEditor
          org={org}
          view={fromPolicy(draft.privacy, (id) => ({
            name: tGroup(id),
            description: tGroup(`${id}Hint`),
          }))}
          onChange={(change) =>
            setDraft((current) => ({
              ...current,
              privacy: applyToPrivacy(current.privacy, change),
            }))
          }
        />
      </div>
    </section>
  );
}

/** Resolution and text recognition: null leaves each computer its own. The app sets its own frame rate, so no interval row (PR #12365). */
export function FramesSection({ draft, patch }: Draft) {
  const t = useTranslations('capture.settings');
  return (
    <Group title={t('framesTitle')} description={t('framesHint')}>
      <SelectRow<CaptureMaxHeight>
        title={t('resolution')}
        description={t('resolutionHint')}
        value={draft.recording.max_height ?? null}
        noneLabel={t('computerDecides')}
        options={CAPTURE_MAX_HEIGHTS.map((height) => ({
          value: height,
          label: height === 2160 ? '4K' : `${height}p`,
        }))}
        onChange={(max_height) => patch('recording', { max_height })}
      />
      <SelectRow<'accurate' | 'fast' | 'off'>
        title={t('textRecognition')}
        description={t('textRecognitionHint')}
        value={draft.recording.text_recognition ?? null}
        noneLabel={t('computerDecides')}
        options={(['accurate', 'fast', 'off'] as const).map((level) => ({
          value: level,
          label: t(`textRecognitionOption.${level}`),
        }))}
        onChange={(text_recognition) => patch('recording', { text_recognition })}
      />
    </Group>
  );
}

/** How long frames live locally and in Kortix. */
export function RetentionSection({ draft, patch }: Draft) {
  const t = useTranslations('capture.settings');
  const whole = (value: string, max: number) =>
    Math.min(max, Math.max(0, Math.round(Number(value) || 0)));
  return (
    <Group title={t('retentionTitle')}>
      <NumberRow
        id="capture-local-hours"
        title={t('localHours')}
        description={t('localHoursHint')}
        unit={t('hours')}
        value={draft.retention.local_hours}
        max={CAPTURE_RETENTION_LIMITS.localHours}
        onChange={(value) =>
          patch('retention', {
            local_hours: whole(value, CAPTURE_RETENTION_LIMITS.localHours),
          })
        }
      />
      <NumberRow
        id="capture-remote-days"
        title={t('remoteDays')}
        description={t('remoteDaysHint')}
        unit={t('days')}
        value={draft.retention.remote_days}
        max={CAPTURE_RETENTION_LIMITS.remoteDays}
        onChange={(value) =>
          patch('retention', {
            remote_days: whole(value, CAPTURE_RETENTION_LIMITS.remoteDays),
          })
        }
      />
    </Group>
  );
}
