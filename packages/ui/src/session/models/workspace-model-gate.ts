/**
 * The workspace model gate: a workspace opens only when the viewer can run at
 * least one model. Without one, every workspace page shows the "Connect a
 * model" step instead (`apps/web` `ConnectModelScreen`).
 *
 * "Can run a model" is the composer's own test (`isRunnableModel`) over the
 * server-resolved `/model-picker` list. That list already applies the plan
 * (a Free account sees no Kortix model), the viewer's own Claude login, the
 * project's ChatGPT login and keys, and the model switches. So a Credits or
 * Enterprise workspace opens on Kortix models, and a Free workspace opens once
 * a ChatGPT plan, a Claude plan or an API key is connected.
 *
 * Pure and framework-free: the hook (`use-workspace-model-gate.ts`) feeds it.
 */

import { isRunnableModel } from './model-availability';

export type WorkspaceModelGateView = 'open' | 'pending' | 'blocked';

export interface WorkspaceModelGateInput {
  /** False turns the gate off: no project yet, or the project runs program agents. */
  enabled: boolean;
  /** The flattened `/model-picker` list, or `undefined` while no answer is in. */
  models: ReadonlyArray<{ enabled?: boolean; available?: boolean }> | undefined;
  /** The `/model-picker` read failed and holds no answer. */
  failed: boolean;
  /** This browser saw a runnable model in this workspace for this viewer before. */
  rememberedReady: boolean;
}

/**
 * - A settled answer decides: one runnable model opens the workspace, none
 *   blocks it.
 * - A failed read opens the workspace. The server still refuses a session with
 *   no model (`no_model_available`), so an outage of `/model-picker` must not
 *   lock every workspace.
 * - No answer yet: a workspace this browser saw ready opens at once (no wait
 *   on every load); any other waits, so a blocked workspace never flashes.
 */
export function resolveWorkspaceModelGate(input: WorkspaceModelGateInput): WorkspaceModelGateView {
  if (!input.enabled) return 'open';
  if (input.models) return input.models.some(isRunnableModel) ? 'open' : 'blocked';
  if (input.failed) return 'open';
  return input.rememberedReady ? 'open' : 'pending';
}

const READY_KEY_PREFIX = 'kortix:model-ready:';

function readyKey(viewerId: string, projectId: string): string {
  return `${READY_KEY_PREFIX}${viewerId}:${projectId}`;
}

/**
 * Whether this browser saw a runnable model for this viewer in this workspace.
 * A per-viewer hint that only skips the wait; the server answer always wins.
 * False when storage is blocked (private mode, a preview frame).
 */
export function readModelReady(viewerId: string | null | undefined, projectId: string): boolean {
  if (!viewerId || !projectId || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(readyKey(viewerId, projectId)) === '1';
  } catch {
    return false;
  }
}

/** Record the server's answer, so the next load of this workspace waits only when it was blocked. */
export function writeModelReady(viewerId: string | null | undefined, projectId: string, ready: boolean): void {
  if (!viewerId || !projectId || typeof window === 'undefined') return;
  try {
    if (ready) window.localStorage.setItem(readyKey(viewerId, projectId), '1');
    else window.localStorage.removeItem(readyKey(viewerId, projectId));
  } catch {
    // Storage blocked: every load waits for the answer, which is still correct.
  }
}
