'use client';

import { useParams, useSearchParams } from 'next/navigation';

import { EvalDatasetView } from '@kortix/ui/customize/evals/eval-dataset-view';
import { datasetKey, parseDatasetSegments } from '@kortix/ui/customize/evals/eval-meta';

import { ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

/**
 * /workspaces/[id]/admin/eval-datasets/suite/<name> and
 * /workspaces/[id]/admin/eval-datasets/dataset/<org>/<name>?version= — one
 * dataset, under Customize → Evals → Datasets.
 */
export default function ProjectAdminEvalDatasetPage() {
  const { id: projectId, ref } = useParams<{ id: string; ref: string[] }>();
  const dataset = parseDatasetSegments(ref ?? [], useSearchParams().get('version'));
  return (
    <ProjectAdminRoute
      projectId={projectId}
      section="eval-datasets"
      content={dataset ? <EvalDatasetView key={`${datasetKey(dataset)}@${dataset.kind === 'dataset' ? (dataset.version ?? '') : ''}`} projectId={projectId} dataset={dataset} /> : undefined}
    />
  );
}
