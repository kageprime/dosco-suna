'use client';

import { useParams, useSearchParams } from 'next/navigation';

import { parseDatasetKey } from '@kortix/ui/customize/evals/eval-meta';
import { EvalTaskView } from '@kortix/ui/customize/evals/eval-task-view';

import { decodeSegment, ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

/** /workspaces/[id]/admin/eval-tasks/<task_id>?from=<dataset> — one task, under Customize → Evals → Tasks. */
export default function ProjectAdminEvalTaskPage() {
  const { id: projectId, taskId } = useParams<{ id: string; taskId: string }>();
  const task = decodeSegment(taskId);
  const from = parseDatasetKey(useSearchParams().get('from'));
  return <ProjectAdminRoute projectId={projectId} section="eval-tasks" content={<EvalTaskView key={task} projectId={projectId} taskId={task} from={from} />} />;
}
