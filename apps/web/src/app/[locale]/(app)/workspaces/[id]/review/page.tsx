import { WorkspaceInbox } from '@kortix/ui/workspace/inbox/workspace-inbox';

export default async function WorkspaceReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <WorkspaceInbox projectId={id} />;
}
