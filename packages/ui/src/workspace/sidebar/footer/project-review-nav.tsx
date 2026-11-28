'use client';

import { CheckIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../../i18n';
import { useReviewNeedsYouCount } from '../../../internal/hooks/use-review-session-summary';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { reviewHref } from '../../../internal/lib/capability-tab-routes';
import { CountBadge } from '../../../primitives/count-badge';
import { useUiPathname } from '../../../providers/ui-provider';

/**
 * The Review row: this workspace's Review page (`reviewHref`,
 * `/workspaces/<id>/review`: change requests, agent questions, approvals)
 * with the count of what waits on the person (`useReviewNeedsYouCount`).
 * One row for both sidebars: the default nav rows (`ProjectNavItems`, first
 * row) and the Spaces list (`ProjectSpacesNav`, `chat` on). Nothing when the
 * host serves no Review page.
 */
export function ProjectReviewNavItem({
  projectId,
  itemClassName,
  bare = false,
}: {
  projectId: string;
  /** The rail's More menu: no count. */
  bare?: boolean;
  /** Added to the list item's classes (the Spaces list sets Review apart with spacing). */
  itemClassName?: string;
}) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const href = reviewHref(projectId);
  const needsYou = useReviewNeedsYouCount(projectId);
  if (!href) return null;
  // The page or an item under it; a query (`?id=`) is not part of the match.
  const path = href.split('?')[0]!;
  const active = !!pathname && (pathname === path || pathname.startsWith(`${path}/`));
  return (
    <ProjectNavRow active={active} label={t('spaces.review')} href={href} itemClassName={itemClassName}>
      <CheckIcon />
      <span className="min-w-0 flex-1 truncate">{t('spaces.review')}</span>
      {!bare && needsYou > 0 ? <CountBadge count={needsYou} tone="waiting" /> : null}
    </ProjectNavRow>
  );
}
