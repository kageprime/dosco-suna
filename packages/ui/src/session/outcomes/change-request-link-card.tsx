'use client';

/**
 * The change request an agent's reply links to, as a card under the reply:
 * a state chip and its number, the title, when it opened and where it lands;
 * then a footer with what it changes and the decision itself. Open and clean: Merge,
 * with Close in the menu beside it. Open with conflicts: Resolve conflict
 * (starts a session that fixes them, the Review page's same action), with
 * Close in the menu. Merged or closed: the state, no actions.
 *
 * The reply's link is enough to find it (`linkedChangeRequestIds`); the card
 * reads the request itself, so it shows the live state, not the reply's.
 */

import { CaretDownIcon, GitMergeIcon, GitPullRequestIcon } from '@phosphor-icons/react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { useChangeRequestRecovery } from '../../files/project/hooks/use-change-request-recovery';
import {
  useChangeRequest,
  useChangeRequestDiff,
  useChangeRequestMergePreview,
  useCloseChangeRequest,
  useMergeChangeRequest,
} from '../../files/project/hooks/use-change-requests';
import { reviewHref } from '../../internal/lib/capability-tab-routes';
import { outcomeTint } from '../../internal/outcomes/outcome-vocabulary';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { errorToast, successToast } from '../../primitives/toast';
import { UiLink } from '../../providers/ui-provider';

/** The two halves of the split button: square inner corners (`--radius` − 6px, the button group's), a 1px seam. */
const JOIN_LEFT = 'rounded-r-[calc(var(--radius)-6px)]';
const JOIN_RIGHT = 'ml-px rounded-l-[calc(var(--radius)-6px)]';

export function ChangeRequestLinkCard({ projectId, crId }: { projectId: string; crId: string }) {
  const t = useTranslations('sessionUi.changeRequest');
  const locale = useLocale();
  const detail = useChangeRequest(crId);
  const cr = detail.data?.change_request ?? null;
  const open = cr?.status === 'open';
  const preview = useChangeRequestMergePreview(crId, open);
  // What it changes: files and lines, the facts a merge decision needs.
  const diff = useChangeRequestDiff(crId);
  const merge = useMergeChangeRequest();
  const close = useCloseChangeRequest();
  const { startRecovery, startingCrId } = useChangeRequestRecovery();

  // Not found, or not readable by this person: the reply's link still works.
  if (!cr) return null;

  const conflicts =
    open && preview.data && !preview.data.is_up_to_date && !preview.data.can_merge ? preview.data.conflicts : [];
  const hasConflicts = conflicts.length > 0;
  const busy = merge.isPending || close.isPending || startingCrId === crId;
  const state =
    cr.status === 'merged' ? t('merged') : cr.status === 'closed' ? t('closed') : hasConflicts ? t('conflicts', { count: conflicts.length }) : t('open');
  const review = reviewHref(projectId);
  const href = review ? `${review.split('?')[0]}?id=cr:${encodeURIComponent(cr.cr_id)}` : null;

  const onMerge = () =>
    merge.mutate(cr.cr_id, {
      onSuccess: () => successToast(t('mergedToast', { number: cr.number })),
      onError: (error) => errorToast(error.message || t('mergeFailed')),
    });
  const onClose = () =>
    close.mutate(cr.cr_id, {
      onSuccess: () => successToast(t('closedToast', { number: cr.number })),
      onError: (error) => errorToast(error.message || t('closeFailed')),
    });
  const onResolve = () =>
    void startRecovery(
      { crId: cr.cr_id, number: cr.number, title: cr.title, headRef: cr.head_ref, baseRef: cr.base_ref },
      { kind: 'merge_conflict', conflicts },
    );

  const settled = cr.status === 'merged' || cr.status === 'closed';
  const chipTone = cr.status === 'closed' ? 'neutral' : hasConflicts ? 'warning' : 'success';
  // Merged reads purple, as a merged pull request does: the brand's purple at the tint strengths of `OUTCOME_TINT`.
  const chip = cr.status === 'merged' ? { bg: 'bg-kortix-purple/15', fg: 'text-kortix-purple/85' } : outcomeTint(chipTone);
  const facts = [
    t('openedAgo', { time: relativeTime(cr.created_at, locale, undefined, { style: 'long' }) }),
    diff.data ? t('files', { count: diff.data.files_changed }) : null,
    t('into', { branch: cr.base_ref }),
  ].filter(Boolean);
  const footerNote =
    cr.status === 'merged'
      ? t('mergedInto', { branch: cr.base_ref })
      : cr.status === 'closed'
        ? t('closedNote')
        : hasConflicts
          ? t('conflicts', { count: conflicts.length })
          : preview.data?.can_merge
            ? t('readyToMerge')
            : null;

  return (
    <div
      data-testid="change-request-link-card"
      data-cr-id={cr.cr_id}
      aria-busy={busy || undefined}
      className="border-strong bg-card mt-2 flex flex-col overflow-hidden rounded-lg"
    >
      {/* What it is: its state and number, then the title with where it lands under it (one group, tight). */}
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-xs font-medium', chip.bg, chip.fg)}>
            {cr.status === 'merged' ? <GitMergeIcon weight="fill" className="size-3" /> : <GitPullRequestIcon weight="fill" className="size-3" />}
            {state}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">{t('number', { number: cr.number })}</span>
        </div>
        {/* The reply's own `text-sm`: the card sits under it and reads as part of it, not as a second headline. */}
        <div className="flex min-w-0 flex-col gap-0.5">
          {href ? (
            <UiLink href={href} prefetch className="text-foreground text-sm leading-snug font-medium text-pretty hover:underline">
              {cr.title}
            </UiLink>
          ) : (
            <span className="text-foreground text-sm leading-snug font-medium text-pretty">{cr.title}</span>
          )}
          <p className="text-muted-foreground truncate text-xs">{facts.join(' · ')}</p>
        </div>
      </div>
      {/* The decision: what it changes on the left, the action on the right. */}
      <div className="border-border-strong bg-muted flex items-center justify-between gap-3 border-t px-3 py-2">
        <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 truncate text-xs tabular-nums">
          {diff.data ? (
            <>
              <span className="text-kortix-green">+{diff.data.additions}</span>
              <span className="text-kortix-red">−{diff.data.deletions}</span>
            </>
          ) : null}
          {diff.data && footerNote ? <span aria-hidden>·</span> : null}
          {footerNote ? <span className="truncate">{footerNote}</span> : null}
        </p>
        {settled ? null : (
          // Not `ButtonGroup`: an open menu adds a hidden element beside its trigger, and the group's `gap-px`
          // and first/last-child corners then shifted the arrow. A fixed 1px seam and set corners hold it still.
          <div role="group" className="flex shrink-0 items-stretch">
            {hasConflicts ? (
              <Button size="sm" disabled={busy} onClick={onResolve} className={JOIN_LEFT}>
                {t('resolveConflict')}
              </Button>
            ) : (
              <Button size="sm" disabled={busy || !preview.data?.can_merge} onClick={onMerge} className={JOIN_LEFT}>
                {merge.isPending ? t('merging') : t('mergeInto', { branch: cr.base_ref })}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* `size="sm"`, the action's own height: one control in two parts. */}
                <Button size="sm" disabled={busy} aria-label={t('moreActions')} className={cn(JOIN_RIGHT, 'px-2')}>
                  <CaretDownIcon weight="bold" className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {href ? (
                  <DropdownMenuItem asChild>
                    <UiLink href={href}>{t('openInReview')}</UiLink>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem variant="destructive" onSelect={onClose}>
                  {t('close')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </div>
  );
}
