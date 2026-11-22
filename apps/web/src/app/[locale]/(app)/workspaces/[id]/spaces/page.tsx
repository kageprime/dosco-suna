'use client';

import { useParams } from 'next/navigation';

import { SpacesPage } from '@kortix/ui/workspace/session-spaces/spaces-page';

/**
 * /workspaces/[id]/spaces — the workspace's Spaces (session groups, flag
 * `session_groups`). The page renders the feature gate while the flag is off.
 * One space is /workspaces/[id]/space/[groupId]; /spaces/[slug] is a
 * `kortix.yaml` space under the `chat` flag.
 */
export default function WorkspaceSpacesPage() {
  const { id } = useParams<{ id: string }>();
  return <SpacesPage projectId={id} />;
}
