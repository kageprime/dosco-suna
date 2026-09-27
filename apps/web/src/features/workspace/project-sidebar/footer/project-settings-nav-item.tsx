'use client';

import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { HubLink } from '@/features/accounts/hub/account-hub-location';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';
import { hubTarget } from '@/stores/account-panel-store';
import { GearSixIcon as CogOne } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

/**
 * Account settings, lifted out of the workspace-switcher menu into the
 * sidebar (bottom group, where Files used to sit). Same destination as the
 * menu row — the account hub modal — so there is exactly one settings door,
 * not two competing ones.
 */
export function ProjectSettingsNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  const detailQuery = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId!),
    enabled: !!projectId,
    ...contract('config'),
  });
  const accountId = (detailQuery.data as any)?.project?.account_id as string | undefined;

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId || !accountId) return null;
  const isActive = !!pathname && pathname.startsWith('/accounts/');
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={t('settings')}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <HubLink to={hubTarget(accountId)} onClick={handleClick}>
          <CogOne />
          {t('settings')}
        </HubLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
