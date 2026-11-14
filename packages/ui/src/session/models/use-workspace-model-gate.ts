'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { getWorkspaceModelPicker } from '@kortix/sdk';
import {
  contract,
  flattenModels,
  projectLlmCatalogToProviderList,
  qk,
  useFeatureFlag,
} from '@kortix/sdk/react';

import { useUiViewerId } from '../../providers/ui-provider';
import { isRunnableModel } from './model-availability';
import {
  readModelReady,
  resolveWorkspaceModelGate,
  writeModelReady,
  type WorkspaceModelGateView,
} from './workspace-model-gate';

/**
 * While the workspace is blocked, re-read the model list on this cadence, so a
 * connection made elsewhere (another tab, another device, a person who manages
 * the workspace) opens it without a reload. The same cadence as the access
 * gate's approval poll. A connection made on this screen does not wait for
 * it: the provider dialog's save invalidates the same query at once
 * (`refreshWorkspaceProviderState`).
 */
const BLOCKED_RECHECK_MS = 15_000;

/**
 * Whether `projectId` may open for the signed-in viewer: `'open'`,
 * `'pending'` (no answer yet, and this browser never saw it ready) or
 * `'blocked'` (no model can run). See `workspace-model-gate.ts` for the rules.
 *
 * Reads `/model-picker` through its shared cache entry
 * (`qk.project.modelPicker`), the one the composer, the model picker and the
 * shell prefetch read, so it adds no request to a workspace load.
 */
export function useWorkspaceModelGate(projectId: string): WorkspaceModelGateView {
  const viewerId = useUiViewerId();
  // A program agent runs code instead of a model (flag `program_agents`), so a
  // project that turned them on may work with no model at all.
  const programAgents = useFeatureFlag(projectId, 'program_agents').enabled;
  const enabled = !!projectId && !programAgents;

  const query = useQuery({
    queryKey: qk.project.modelPicker(projectId),
    queryFn: () => getWorkspaceModelPicker(projectId),
    enabled,
    ...contract('config'),
    retry: false,
    refetchInterval: (current) =>
      current.state.data && !flattenCatalog(current.state.data).some(isRunnableModel)
        ? BLOCKED_RECHECK_MS
        : false,
  });

  const models = useMemo(() => (query.data ? flattenCatalog(query.data) : undefined), [query.data]);
  // Read once per viewer and workspace: the write below must not flip a
  // decision that is already on screen.
  const rememberedReady = useMemo(() => readModelReady(viewerId, projectId), [viewerId, projectId]);

  const view = resolveWorkspaceModelGate({
    enabled,
    models,
    failed: query.isError,
    rememberedReady,
  });

  useEffect(() => {
    // Only a server answer is recorded; a remembered or failed-open verdict is not.
    if (enabled && models) writeModelReady(viewerId, projectId, view === 'open');
  }, [enabled, models, projectId, view, viewerId]);

  return view;
}

function flattenCatalog(catalog: Parameters<typeof projectLlmCatalogToProviderList>[0]) {
  return flattenModels(projectLlmCatalogToProviderList(catalog));
}
