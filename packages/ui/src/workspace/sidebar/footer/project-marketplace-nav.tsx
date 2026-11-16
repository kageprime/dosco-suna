'use client';

import { StorefrontIcon } from '@phosphor-icons/react';
import { ProjectNavRow } from '../../../internal/layout/project-nav-row';
import { uiRoutes } from '../../../lib/routes';
import { useUiPathname } from '../../../providers/ui-provider';

export function ProjectMarketplaceNavItem({ projectId }: { projectId: string }) {
  const pathname = useUiPathname();
  const href = projectId ? (uiRoutes().marketplace?.(projectId) ?? `/workspaces/${projectId}/marketplace`) : null;
  if (!href) return null;

  return (
    <ProjectNavRow
      active={pathname?.startsWith(href) === true}
      label="Marketplace"
      href={href}
      prefetch
    >
      <span className="shrink-0">
        <StorefrontIcon />
      </span>
      <span className="truncate group-data-[collapsible=icon]:hidden">Marketplace</span>
    </ProjectNavRow>
  );
}
