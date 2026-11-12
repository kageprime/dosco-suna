'use client';

import { useState } from 'react';

import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { Label } from '@kortix/ui/label';
import { Skeleton } from '@kortix/ui/skeleton';
import { StorageMeter, StorageNotice, formatStorageBytes, storageTone } from '@kortix/ui/files';
import { useAccountStorageUsage } from '@kortix/sdk/react';
import { useLocale, useTranslations } from '@/i18n/use-translations';

/**
 * Files storage of the account: the total against the plan's account limit,
 * then each project's Files against the plan's project limit, largest first.
 * The API decides every figure (`GET /drives/usage`); a member without
 * `billing.read` gets a 403 and the section stays out.
 */
export function AccountStorageSection({ accountId }: { accountId: string | undefined }) {
  const t = useTranslations('drives');
  const locale = useLocale();
  // No id: the caller's own account, as the API answers it.
  const usage = useAccountStorageUsage(accountId);

  if (usage.isLoading) {
    return (
      <section className="space-y-4">
        <Label>{t('accountStorageTitle')}</Label>
        <Skeleton className="h-24 w-full rounded-md" />
      </section>
    );
  }
  const data = usage.data;
  if (!data) return null;
  // An answer without limits (an older API) shows usage with no limit, never a crashed billing tab.
  const projectBytes = data.limits?.projectBytes ?? null;
  const accountBytes = data.limits?.accountBytes ?? null;
  const tone = storageTone(data.usedBytes, accountBytes);

  return (
    <section className="space-y-4" data-testid="account-storage">
      <Label>{t('accountStorageTitle')}</Label>
      <div className="bg-popover rounded-md border px-4 py-4">
        <StorageMeter label={t('storageLabel')} usedBytes={data.usedBytes} limitBytes={accountBytes} />
        {projectBytes !== null && accountBytes !== null ? (
          <p className="text-muted-foreground mt-2 text-xs">
            {t('accountStorageDescription', {
              project: formatStorageBytes(projectBytes, locale),
              account: formatStorageBytes(accountBytes, locale),
            })}
          </p>
        ) : null}
        {tone !== 'ok' ? (
          <div className="mt-3">
            <StorageNotice>{tone === 'full' ? t('storageFull') : t('storageNearFull')}</StorageNotice>
          </div>
        ) : null}
      </div>
      {data.projects.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('accountStorageEmpty')}</p>
      ) : (
        <ul className="bg-popover divide-border divide-y rounded-md border">
          {data.projects.map((p) => (
            <li key={p.driveId} className="px-4 py-3">
              <StorageMeter label={p.name || p.projectId} usedBytes={p.usedBytes ?? 0} limitBytes={projectBytes} />
            </li>
          ))}
        </ul>
      )}
      {!data.complete ? <p className="text-muted-foreground text-xs">{t('accountStorageIncomplete')}</p> : null}
    </section>
  );
}

/** Bar fill by how full a workspace is against its own limit: the Storage
 *  purple the rest of the Usage page gives storage while there is room,
 *  orange near the limit, red at it. The same three states `storageTone`
 *  reports. */
const BAR_TONE_CLASS = {
  ok: 'bg-kortix-purple',
  near: 'bg-kortix-orange',
  full: 'bg-kortix-red',
} as const;

/** Rows shown before the list folds: an account can hold dozens of
 *  workspaces, and the card sits beside the balance card. */
const STORAGE_ROWS_FOLDED = 5;

/**
 * Each bar's length against the largest workspace, not against the limit: the
 * limit is 50 GB and a typical workspace holds megabytes, so against the limit
 * every bar is an empty track. The figure on the right stays the real size.
 * A real but tiny workspace keeps a 2% sliver, so it never reads as empty.
 */
export function storageBarPercent(usedBytes: number, largestBytes: number): number {
  if (!(usedBytes > 0) || !(largestBytes > 0)) return 0;
  return Math.max(2, Math.min(100, (usedBytes / largestBytes) * 100));
}

/**
 * Files storage as one card: the account total against its limit in the
 * header, then one row per workspace that holds files, largest first. Each
 * row is the name, a bar and the size, so 3 workspaces and 40 read the same
 * way. The first five show; the rest fold behind one toggle.
 */
export function AccountStorageCard({ accountId }: { accountId: string | undefined }) {
  const t = useTranslations('drives');
  const locale = useLocale();
  const usage = useAccountStorageUsage(accountId);
  const [expanded, setExpanded] = useState(false);

  if (usage.isLoading) {
    return <Skeleton className="h-full min-h-40 w-full rounded-md" />;
  }
  const data = usage.data;
  if (!data) return null;
  const projectBytes = data.limits?.projectBytes ?? null;
  const accountBytes = data.limits?.accountBytes ?? null;
  const tone = storageTone(data.usedBytes, accountBytes);
  const used = formatStorageBytes(data.usedBytes, locale);
  const holding = data.projects
    .filter((p) => (p.usedBytes ?? 0) > 0)
    .sort((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0));
  const emptyCount = data.projects.length - holding.length;
  const largest = holding[0]?.usedBytes ?? 0;
  const hiddenCount = Math.max(0, holding.length - STORAGE_ROWS_FOLDED);
  const shown = expanded ? holding : holding.slice(0, STORAGE_ROWS_FOLDED);
  const footer = [
    projectBytes ? t('storageWorkspaceLimit', { limit: formatStorageBytes(projectBytes, locale) }) : null,
    emptyCount > 0 && holding.length > 0 ? t('emptyWorkspaces', { count: emptyCount }) : null,
  ].filter(Boolean);

  return (
    <section
      className="bg-popover flex min-w-0 flex-col gap-4 rounded-md border px-4 py-4"
      data-testid="account-storage"
      aria-label={t('accountStorageTitle')}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-foreground text-sm font-medium">{t('accountStorageTitle')}</h3>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {accountBytes
            ? t('storageOfLimit', { used, limit: formatStorageBytes(accountBytes, locale) })
            : t('storageUsed', { used })}
        </span>
      </div>
      {holding.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('accountStorageEmpty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((p) => {
            const bytes = p.usedBytes ?? 0;
            const rowTone = storageTone(bytes, projectBytes);
            const label = p.name || p.projectId;
            const size = formatStorageBytes(bytes, locale);
            return (
              <li key={p.driveId} className="flex min-w-0 items-center gap-3 text-xs">
                <span className="text-foreground w-28 shrink-0 truncate" title={label}>
                  {label}
                </span>
                <span aria-hidden="true" className="bg-muted h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                  <span
                    className={cn('block h-full rounded-full', BAR_TONE_CLASS[rowTone])}
                    style={{ width: `${storageBarPercent(bytes, largest)}%` }}
                  />
                </span>
                <span
                  className={cn(
                    'shrink-0 text-right tabular-nums',
                    rowTone === 'ok' ? 'text-muted-foreground w-16' : 'text-foreground',
                  )}
                >
                  {rowTone !== 'ok' && projectBytes
                    ? t('storageOfLimit', { used: size, limit: formatStorageBytes(projectBytes, locale) })
                    : size}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {hiddenCount > 0 ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? t('storageShowFewer') : t('storageMoreWorkspaces', { count: hiddenCount })}
          </Button>
        </div>
      ) : null}
      {tone !== 'ok' ? (
        <StorageNotice>{tone === 'full' ? t('storageFull') : t('storageNearFull')}</StorageNotice>
      ) : null}
      {footer.length > 0 || !data.complete ? (
        <p className="text-muted-foreground mt-auto text-xs">
          {[...footer, data.complete ? null : t('accountStorageIncomplete')].filter(Boolean).join(' · ')}
        </p>
      ) : null}
    </section>
  );
}
