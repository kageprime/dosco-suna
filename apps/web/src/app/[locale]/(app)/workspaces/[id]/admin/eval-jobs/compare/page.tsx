'use client';

import { useParams, useSearchParams } from 'next/navigation';

import { EvalCompareView } from '@kortix/ui/customize/evals/eval-compare-view';

import { ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

/** /workspaces/[id]/admin/eval-jobs/compare?jobs=<a>,<b> — jobs side by side, the first the baseline. */
export default function ProjectAdminEvalComparePage() {
  const { id: projectId } = useParams<{ id: string }>();
  const jobs = (useSearchParams().get('jobs') ?? '').split(',').filter(Boolean);
  return <ProjectAdminRoute projectId={projectId} section="eval-jobs" content={<EvalCompareView key={jobs.join(',')} projectId={projectId} jobIds={jobs} />} />;
}
