'use client';

import {
  useRuntimeLocal,
  type RuntimeLocal,
  type UseRuntimeLocalOptions,
} from './use-runtime-local';
import {
  useModelDefaults,
  type UseModelDefaults,
} from './use-model-defaults';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { platformConfig } from '../core/http/config';
import { setWorkspaceSessionModel } from '../core/rest/projects-client/sessions';
import { modelKeyToWire, type ModelKey } from './use-model-store';
import { qk } from './query-keys';
import { useKortixRouteWorkspaceId } from './route-project';

export interface SessionModelSelection extends RuntimeLocal {
  model: RuntimeLocal['model'] & {
    defaults: UseModelDefaults;
  };
}

/**
 * Project-aware model and agent selection.
 *
 * The SDK owns the server default and free-tier resolution. Hosts supply only
 * the runtime capabilities and optional explicit overrides. `sessionId` keys the
 * local selection (a thread passes its runtime id); `projectSessionId` is the
 * durable session an intentional pick is saved to. Without it a pick stays local.
 */
export function useSessionModelSelection(
  options: UseRuntimeLocalOptions & { projectSessionId?: string },
): SessionModelSelection {
  const projectId = useKortixRouteWorkspaceId();
  const defaults = useModelDefaults(projectId);
  const queryClient = useQueryClient();
  const base = useRuntimeLocal({
    ...options,
    freeTier: options.freeTier ?? defaults.freeTier,
    resolveServerDefault:
      options.resolveServerDefault ?? defaults.resolveDefaultFor,
  });

  const persist = useMutation({
    scope: { id: `session-model:${projectId}:${options.projectSessionId}` },
    // The pick carries its own session and setter: a save that finishes after the
    // thread navigated applies to the session it was picked in, never the new one.
    mutationFn: async (pick: { projectId: string; projectSessionId: string; model: ModelKey; apply: RuntimeLocal['model']['set'] }) => {
      const result = await setWorkspaceSessionModel(pick.projectId, pick.projectSessionId, modelKeyToWire(pick.model));
      if (result.push_failed) throw new Error(result.detail ?? 'The running session did not accept the model');
    },
    onSuccess: (_result, pick) => {
      pick.apply(pick.model, { recent: true });
      void queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(pick.projectId) });
    },
    onError: (error) => {
      platformConfig().onToast?.('error', error.message);
    },
  });

  return {
    ...base,
    model: {
      ...base.model,
      set: (model, pickOptions) => {
        if (model && projectId && options.projectSessionId && pickOptions?.recent && !pickOptions.autoSeed) {
          persist.mutate({ projectId, projectSessionId: options.projectSessionId, model, apply: base.model.set });
        } else {
          base.model.set(model, pickOptions);
        }
      },
      defaults,
    },
  };
}
