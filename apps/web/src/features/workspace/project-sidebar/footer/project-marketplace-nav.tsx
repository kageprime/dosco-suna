'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';
import { useFeatureFlag } from '@kortix/sdk/react';
import { StorefrontIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

import {
  activeCapabilityTab,
  capabilityTabHref,
} from '@/features/workspace/capabilities/shared/capability-tab-routes';

/**
 * Top-level Marketplace entry, directly under New session + Customize — not a
 * capability-tab-bar tab. Links the same `/customize/marketplace` URL the tab
 * used, so bookmarks and the catalog's own links keep working and
 * `activeCapabilityTab` still lights this row.
 *
 * Gated twice, mirroring the old tab: the project `marketplace` feature flag
 * (fail-closed — the row exists once the flag is on) plus `project.read`
 * (optimistic while the probe loads — the entry only disappears on an
 * explicit deny).
 */
export function ProjectMarketplaceNavItem() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const marketplaceGate = useFeatureFlag(projectId, 'marketplace');
  const canRead = useProjectPageCans(projectId)[PROJECT_ACTIONS.PROJECT_READ];
  const isActive = !!pathname && activeCapabilityTab(pathname) === 'marketplace';

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId) return null;
  if (!marketplaceGate.enabled) return null;
  if (!canRead.allowed && !canRead.isLoading) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={tI18nComplete.raw('textc608981d8d68')}
        className="group/menu-button text-sidebar-foreground relative"
      >
        {/* Hover-gated prefetch, same reason as the sibling rows: prefetching
            on mount would charge every session open a full dynamic render of
            a route most opens never visit. */}
        <HoverPrefetchLink
          href={capabilityTabHref(projectId, 'marketplace')}
          prefetch
          onClick={handleClick}
        >
          <span className="shrink-0">
            <StorefrontIcon />
          </span>
          {tI18nComplete.raw('textc608981d8d68')}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
