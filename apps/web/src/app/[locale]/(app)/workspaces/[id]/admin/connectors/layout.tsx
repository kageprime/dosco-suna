import type { ReactNode } from 'react';

import { workspaceSettingsSectionMetadata } from '@/features/workspace/project-admin/workspace-settings-metadata';

/** A static folder owns `/admin/connectors`, so the tab title of this section is set here. */
export const generateMetadata = () => workspaceSettingsSectionMetadata('connectors');

export default function WorkspaceSettingsSectionLayout({ children }: { children: ReactNode }) {
  return children;
}
