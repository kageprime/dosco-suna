'use client';

import { useParams } from 'next/navigation';

import { SpaceDetailPage } from '@kortix/ui/workspace/session-spaces/space-detail-page';
import { SpaceFileView } from '@/features/drives/space-file-view';
import { DriveFolderAt } from '@/features/drives/space-folder-view';

/**
 * /workspaces/[id]/space/[groupId] — one space (session group, flag
 * `session_groups`): start a session in it, its sessions and tabs, what it is
 * for, who sees it. Folder and file tabs render with the Drive explorer and
 * file viewer. The page renders the feature gate while the flag is off.
 */
export default function WorkspaceSpacePage() {
  const { id, groupId } = useParams<{ id: string; groupId: string }>();
  return (
    <SpaceDetailPage
      projectId={id}
      groupId={decodeURIComponent(groupId)}
      renderFolder={(folder) => <DriveFolderAt projectId={id} {...folder} />}
      renderFile={(file) => <SpaceFileView projectId={id} {...file} />}
    />
  );
}
