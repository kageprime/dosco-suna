'use client';

import { useFeatureFlag, useWorkspaceCalendarItems } from '@kortix/sdk/react';
import { CalendarBlankIcon } from '@phosphor-icons/react';
import { useMemo } from 'react';
import { useTranslations } from '../../../i18n';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { uiRoutes } from '../../../lib/routes';
import { CountBadge } from '../../../primitives/count-badge';
import { useUiPathname } from '../../../providers/ui-provider';

/**
 * The Calendar row (flag `calendar`), with the count of open items the
 * viewer owns that are due today or overdue. Off, it renders nothing and
 * reads nothing: the flag comes from the project row already in the cache.
 */
export function ProjectCalendarNavItem({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const visible = useFeatureFlag(projectId, 'calendar').enabled;
  const endOfToday = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  }, []);
  const due = useWorkspaceCalendarItems(visible ? projectId : null, { assignee: 'me', status: 'open', to: endOfToday, undated: false }, { refetchMs: 60_000 });
  const href = uiRoutes().calendar?.(projectId) ?? null;
  if (!href || !visible) return null;
  const count = due.data?.length ?? 0;
  return (
    <ProjectNavRow active={pathname?.startsWith(href) === true} label={t('calendar')} href={href} prefetch>
      <span className="shrink-0">
        <CalendarBlankIcon />
      </span>
      {t('calendar')}
      {count > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <CountBadge count={count} tone="waiting" />
        </span>
      ) : null}
    </ProjectNavRow>
  );
}
