'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';
import { GearSixIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

import {
  activeCapabilityTab,
  capabilityTabHref,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * Top-level project settings entry: General, Git, Sandbox templates, Feature
 * flags, Upgrades. These live on their own page (`/customize/settings`) with
 * no capability tab bar — the bar covers the agent library (Agents, Skills,
 * Connectors, …), and configuration is a different area, so it gets its own
 * row instead of a trailing tab.
 *
 * Gated on `project.customize.write`, the same leaf the old tab probed:
 * anyone who could open the tab can open this row. Hidden on an explicit
 * deny, optimistic while the probe loads.
 */
export function WorkspaceSettingsNavItem() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const canWrite = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE];
  const isActive = !!pathname && activeCapabilityTab(pathname) === 'config';

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId) return null;
  if (!canWrite.allowed && !canWrite.isLoading) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={tI18nComplete.raw('text74a883a037bc')}
        className="group/menu-button text-sidebar-foreground relative"
      >
        {/* Hover-gated prefetch, same reason as the sibling rows. */}
        <HoverPrefetchLink
          href={capabilityTabHref(projectId, 'config')}
          prefetch
          onClick={handleClick}
        >
          <span className="shrink-0">
            <GearSixIcon />
          </span>
          {tI18nComplete.raw('text74a883a037bc')}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
