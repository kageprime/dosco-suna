'use client';

import { useParams } from 'next/navigation';

import { EvalJobView } from '@kortix/ui/customize/evals/eval-job-view';

import { decodeSegment, ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

/** /workspaces/[id]/admin/eval-jobs/<job_id> — one eval job, under Customize → Evals → Jobs. `?trial=` opens a trial. */
export default function ProjectAdminEvalJobPage() {
  const { id: projectId, jobId } = useParams<{ id: string; jobId: string }>();
  const job = decodeSegment(jobId);
  return <ProjectAdminRoute projectId={projectId} section="eval-jobs" content={<EvalJobView key={job} projectId={projectId} jobId={job} />} />;
}
