'use client';

import { ProjectAppsNavItem } from './footer/project-apps-nav';
import { ProjectGoalsNavItem } from './footer/project-goals-nav';
import { ProjectArtifactsNavItem } from './footer/project-artifacts-nav';
import { ProjectRoomsNavItem } from './footer/project-rooms-nav';
import { ProjectFilesNavItem } from './footer/project-files-nav';

/**
 * The nav rows under New session, in one fixed order. Each row applies its
 * own flag and permission gate and renders nothing when the project does not
 * offer it. Customize is handled by the bottom Settings button in the sidebar.
 * Spaces are the channel sidebar under the `project_channels` flag
 * (project-spaces-nav.tsx).
 */
const NAV_ROWS = ['files', 'apps', 'rooms', 'goals', 'artifacts'] as const;
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

function NavItem({ id, projectId }: { id: NavRowId; projectId: string }) {
  switch (id) {
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
