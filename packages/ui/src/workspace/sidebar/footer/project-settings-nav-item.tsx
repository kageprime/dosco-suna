'use client';

import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { GearSixIcon as CogOne } from '@phosphor-icons/react';

/**
 * Centralized settings, in the sidebar's bottom group where Files used to
 * sit. Opens the one overlay — Project, Personal and Account groups —
 * instead of the account hub modal. The hub stays reachable from the
 * workspace switcher and the palette for account-native flows.
 */
export function ProjectSettingsNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const openSettings = useSettingsPanelStore((s) => s.openSettings);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    openSettings();
  }, [isMobile, setOpenMobile, openSettings]);

  if (!projectId) return null;
  const isActive = !!pathname && /\/settings(\/|$)/.test(pathname);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        tooltip={t('settings')}
        onClick={handleClick}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <span className="shrink-0">
          <CogOne />
        </span>
        {t('settings')}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
