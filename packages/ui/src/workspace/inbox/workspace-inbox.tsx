'use client';

import { ReviewView } from '../../customize/sections/view/review-view';
import { useTranslations } from '../../i18n';
import { ProjectPageHeader } from '../../internal/layout/project-page-header';

/**
 * /workspaces/[id]/review — this workspace's Review queue (KRTX-4799):
 * approvals, questions and change requests to act on. `?id=` opens one item.
 * The person's notifications are not here: they span every workspace, so a
 * workspace page cannot scope them — they live on the person-level Inbox page
 * (`/inbox`, KRTX-1742), which `AccountTopBar` and the workspace menu's Inbox
 * row open. The sidebar's Review row (`uiRoutes().review`) opens this page.
 */
export function WorkspaceInbox({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  return (
    // `h-svh`: nothing above this box has a definite height (as the Apps page).
    <div className="flex h-svh min-h-0 flex-col overflow-hidden">
      <ProjectPageHeader title={t('spaces.review')} />
      {/* Full width: the list and the open item sit side by side, so no
          reading-width cap here. */}
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <ReviewView projectId={projectId} />
      </div>
    </div>
  );
}
