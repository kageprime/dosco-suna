'use client';

/**
 * The Context section's usage meter: how full the model's context window is,
 * and what fills it.
 *
 * One stacked bar over the whole window, then one legend row per part with its
 * tokens and its share of the window. The parts are the ones the transcript
 * actually measures for the last reply (`getLastAssistantTokenBreakdown`):
 * cached input reused from earlier turns, new input, and the reply. Nothing is
 * estimated or invented. Without a known window (a model the catalog does not
 * list) the meter shows the tokens and drops the percentages and free space.
 *
 * Nearly full shows as the composer context ring's tone (a yellow dot from
 * 70%, red from 85%, `contextTone`), so the two never disagree.
 */

import { flattenModels } from '@kortix/sdk';
import {
  useProjectSession,
  useRuntimeProviders,
  useRuntimeSupports,
  useSessionLogThread,
  useSessionModelUsage,
} from '@kortix/sdk/react';
import { useMemo, useState } from 'react';
import { Button } from '../../../primitives/button';
import { CompactModal } from '../../header/compact-modal';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { STATUS_DOT } from '../../../primitives/status';
import { type ContextUsage, formatContextCount, getContextUsage } from '../../composer/context-usage';
import { useOptionalSessionPanel } from '../session-panel-provider';

/**
 * The catalog entry a recorded model key names. The session row carries the
 * provider prefix ("kortix/codex/gpt-6.1-sol"); the gateway's served model
 * does not ("codex/gpt-6.1-sol"). Both resolve to the same entry.
 */
export function findModelKey(
  models: { providerID: string; modelID: string }[],
  key: string | null | undefined,
): { providerID: string; modelID: string } | null {
  if (!key) return null;
  const hit = models.find((m) => `${m.providerID}/${m.modelID}` === key || m.modelID === key);
  return hit ? { providerID: hit.providerID, modelID: hit.modelID } : null;
}

/** The live session's context usage, or null outside a session panel / before the first reply. */
export function useSessionContextUsage(): ContextUsage | null {
  const panel = useOptionalSessionPanel();
  const projectId = panel?.projectId;
  const sessionId = panel?.projectSessionId;
  const session = useProjectSession(projectId, sessionId).data;
  const served = useSessionModelUsage(projectId, sessionId).data?.latest?.served_model;
  const { data: providers } = useRuntimeProviders();
  // Throttled: the meter restates a total, it does not need every streamed token.
  const thread = useSessionLogThread(
    { projectId: projectId ?? '', sessionId: sessionId ?? '', runtimeSessionId: panel?.sessionId ?? '' },
    null,
    { throttleMs: 1000 },
  );
  const models = useMemo(() => flattenModels(providers), [providers]);
  const messages = thread?.messages;
  const modelKey = served ?? session?.model ?? null;
  return useMemo(() => {
    if (!panel) return null;
    const usage = getContextUsage(messages, models, findModelKey(models, modelKey));
    return usage.breakdown.total > 0 ? usage : null;
  }, [panel, messages, models, modelKey]);
}

/** Offer Compact once the window is nearly full (the composer ring's warning tone, 70%). */
export function offersCompact(usage: Pick<ContextUsage, 'limit' | 'tone'>, supported: boolean): boolean {
  return supported && usage.limit != null && (usage.tone === 'warning' || usage.tone === 'destructive');
}

export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const tProgress = useTranslations('hardcodedUi.featuresSessionComposerTokenProgress');
  const runtimeSessionId = useOptionalSessionPanel()?.sessionId;
  const compact = offersCompact(usage, useRuntimeSupports('session.compact')) && Boolean(runtimeSessionId);
  const [compactOpen, setCompactOpen] = useState(false);
  const { breakdown, limit } = usage;
  // The bar's scale: the window when known, else the tokens themselves.
  const scale = limit ?? breakdown.total;
  const share = (n: number) => (scale > 0 ? n / scale : 0);
  const pct = (n: number) => {
    const p = share(n) * 100;
    return p > 0 && p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`;
  };
  const free = limit ? Math.max(0, limit - breakdown.total) : null;

  const parts = [
    { key: 'cache', label: t.raw('texta251c18205f1'), value: breakdown.cache, swatch: 'bg-kortix-blue' },
    { key: 'input', label: t.raw('text36ecb4f86691'), value: breakdown.input, swatch: 'bg-kortix-purple' },
    { key: 'output', label: t.raw('textb2439bcb8dee'), value: breakdown.output, swatch: 'bg-kortix-green' },
  ].filter((p) => p.value > 0);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-3 text-sm tabular-nums">
        <span className="text-foreground flex items-center gap-1.5">
          {/* Nearly full: the composer ring's tone as a dot, never as tinted text. */}
          {limit && usage.tone !== 'info' && (
            <span className={cn('size-1.5 rounded-full', STATUS_DOT[usage.tone])} aria-hidden />
          )}
          {limit ? `${usage.percent}% ${t.raw('textf83916135509')}` : formatContextCount(breakdown.total)}
        </span>
        {limit && (
          <span className="text-muted-foreground">
            {formatContextCount(breakdown.total)} / {formatContextCount(limit)}
          </span>
        )}
      </div>

      {/* One track, the parts laid end to end at their share of the window. */}
      <div className="bg-muted mx-3 mt-2 flex h-1 gap-px overflow-hidden rounded-full" aria-hidden>
        {parts.map((p) => (
          <span key={p.key} className={p.swatch} style={{ width: `${share(p.value) * 100}%` }} />
        ))}
      </div>

      <dl className="mt-2 flex flex-col">
        {parts.map((p) => (
          <MeterRow key={p.key} swatch={p.swatch} label={p.label} value={p.value} percent={limit ? pct(p.value) : null} />
        ))}
        {free != null && (
          <MeterRow
            className="mt-2"
            swatch="bg-muted ring-1 ring-border ring-inset"
            label={t.raw('text64cd989efc14')}
            value={free}
            percent={pct(free)}
          />
        )}
      </dl>

      {compact && runtimeSessionId && (
        <>
          <div className="flex items-center justify-between gap-2 px-3 pt-3">
            <span className="text-muted-foreground text-sm tabular-nums">
              {tProgress('remainingCount', { remaining: formatContextCount(free ?? 0) })}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setCompactOpen(true)}>
              {t.raw('textee1ca259e05b')}
            </Button>
          </div>
          <CompactModal sessionId={runtimeSessionId} open={compactOpen} onOpenChange={setCompactOpen} />
        </>
      )}
    </div>
  );
}

/** One legend row: swatch, label, tokens, share. Columns line up down the list. */
function MeterRow({
  swatch,
  label,
  value,
  percent,
  className,
}: {
  swatch: string;
  label: string;
  value: number;
  percent: string | null;
  className?: string;
}) {
  return (
    <div className={cn('mx-1 flex h-7 items-center gap-3 px-2 text-sm tabular-nums', className)}>
      <span className="flex w-5 shrink-0 items-center justify-center" aria-hidden>
        <span className={cn('size-2.5 rounded-xs', swatch)} />
      </span>
      <dt className="text-muted-foreground min-w-0 flex-1 truncate">{label}</dt>
      <dd className="text-muted-foreground text-right">{formatContextCount(value)}</dd>
      {percent && <dd className="text-foreground w-14 text-right">{percent}</dd>}
    </div>
  );
}
