import { redirect } from 'next/navigation';

/** The job page moved to Customize → Evals → Jobs on 2026-11-13: an old link opens it there. */
export default async function LegacyEvalJobPage({ params }: { params: Promise<{ locale: string; id: string; jobId: string }> }) {
  const { id, jobId } = await params;
  redirect(`/workspaces/${encodeURIComponent(id)}/admin/eval-jobs/${encodeURIComponent(jobId)}`);
}
