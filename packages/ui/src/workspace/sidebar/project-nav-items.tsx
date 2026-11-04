'use client';

import { ProjectAppsNavItem } from './footer/project-apps-nav';
import { ProjectGoalsNavItem } from './footer/project-goals-nav';
import { ProjectArtifactsNavItem } from './footer/project-artifacts-nav';
import { ProjectRoomsNavItem } from './footer/project-rooms-nav';
import { ProjectFilesNavItem } from './footer/project-files-nav';
import {
  CustomizeGlyph,
  useCapabilityAccess,
} from '../../internal/layout/project-settings-nav';
import { isProjectAdminPath, ProjectCapabilityNav } from '../../internal/layout/project-capability-nav';
import { cn } from '../../lib/utils';
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../primitives/sidebar';
import { useIsMobile } from '../../internal/hooks';
import { useTranslations } from '../../i18n';
import { CaretRightIcon } from '@phosphor-icons/react';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { useEffect, useState } from 'react';

/**
 * The nav rows under New session, in one fixed order. Each row applies its
 * own flag and permission gate and renders nothing when the project does not
 * offer it. Spaces are the channel sidebar under the `project_channels` flag
 * (project-spaces-nav.tsx).
 */
const NAV_ROWS = ['customize', 'files', 'apps', 'rooms', 'goals', 'artifacts'] as const;
type NavRowId = (typeof NAV_ROWS)[number];

export function ProjectNavItems({ projectId }: { projectId: string }) {
  return (
    <>
      {NAV_ROWS.map((id) => (
        <NavItem key={id} id={id} projectId={projectId} />
      ))}
    </>
  );
}

/**
 * Customize, for the people who may configure the project. Navigates directly
 * to the centralized Settings & Customization Hub at `/projects/[id]/settings`,
 * and allows expanding/collapsing the sub menu on mobile and desktop.
 */
function CustomizeNavEntry({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const pathname = useUiPathname();
  const access = useCapabilityAccess(projectId);
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  const onCustomizePage =
    !!pathname &&
    (pathname.includes('/settings') ||
      pathname.includes('/customize') ||
      isProjectAdminPath(pathname));

  const [open, setOpen] = useState(onCustomizePage);

  useEffect(() => {
    if (onCustomizePage) {
      setOpen(true);
    }
  }, [onCustomizePage]);

  if (!access.settled || access.tabs.length === 0) return null;

  const href = `/projects/${projectId}/settings`;
  const isActive = onCustomizePage;

  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton asChild isActive={isActive} tooltip={t('customize')}>
          <Link
            href={href}
            prefetch={false}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
            }}
          >
            <span className="shrink-0">
              <CustomizeGlyph />
            </span>
            <span className="truncate">{t('customize')}</span>
          </Link>
        </SidebarMenuButton>
        <SidebarMenuAction
          aria-label={open ? 'Collapse Customize submenu' : 'Expand Customize submenu'}
          aria-expanded={open}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen((prev) => !prev);
          }}
          className={cn(
            'transition-transform duration-200 cursor-pointer',
            open && 'rotate-90',
          )}
        >
          <CaretRightIcon className="size-3.5" />
        </SidebarMenuAction>
      </SidebarMenuItem>
      {open ? <ProjectCapabilityNav projectId={projectId} /> : null}
    </>
  );
}

function NavItem({ id, projectId }: { id: NavRowId; projectId: string }) {
  switch (id) {
    case 'customize':
      return <CustomizeNavEntry projectId={projectId} />;
    case 'apps':
      return <ProjectAppsNavItem projectId={projectId} />;
    case 'files':
      return <ProjectFilesNavItem projectId={projectId} />;
    case 'rooms':
      return <ProjectRoomsNavItem projectId={projectId} />;
    case 'goals':
      return <ProjectGoalsNavItem projectId={projectId} />;
    case 'artifacts':
      return <ProjectArtifactsNavItem projectId={projectId} />;
  }
}
