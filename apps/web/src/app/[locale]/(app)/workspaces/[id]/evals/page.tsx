import { redirect } from 'next/navigation';

/** /workspaces/[id]/evals moved into Customize: /workspaces/[id]/admin/evals. */
export default async function ProjectEvalsRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/workspaces/${encodeURIComponent(id)}/admin/evals`);
}
