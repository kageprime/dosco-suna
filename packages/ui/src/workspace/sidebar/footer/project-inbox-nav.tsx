'use client';

import { useNotificationInbox } from '@kortix/sdk/react';
import { BellIcon } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { tabUnreadCount } from '../../../internal/notifications/notification-rows';
import { uiRoutes } from '../../../lib/routes';
import { CountBadge } from '../../../primitives/count-badge';
import { useUiPathname, useUiViewerId } from '../../../providers/ui-provider';

/**
 * The Inbox row: the person's notifications (`uiRoutes().inbox`, `/inbox` on
 * apps/web), one click from the workspace. The badge counts the unread rows
 * of Needs you only (open asks and failures, `tabUnreadCount`), so a finished
 * turn never lights the sidebar. It reads the inbox query `NotificationHost`
 * already polls. Nothing while signed out or when the host serves no Inbox.
 */
export function ProjectInboxNavItem() {
  const viewerId = useUiViewerId();
  const href = uiRoutes().inbox?.() ?? null;
  return viewerId && href ? <InboxNavRow viewerId={viewerId} href={href} /> : null;
}

function InboxNavRow({ viewerId, href }: { viewerId: string; href: string }) {
  const t = useTranslations('notifications');
  const pathname = useUiPathname();
  const inbox = useNotificationInbox({ userId: viewerId });
  const needsYou = tabUnreadCount(inbox.data?.notifications ?? [], 'needs');
  return (
    <ProjectNavRow active={pathname?.startsWith(href) === true} label={t('inbox.title')} href={href} prefetch>
      <span className="shrink-0">
        <BellIcon />
      </span>
      {t('inbox.title')}
      {needsYou > 0 ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <CountBadge count={needsYou} tone="waiting" />
        </span>
      ) : null}
    </ProjectNavRow>
  );
}
